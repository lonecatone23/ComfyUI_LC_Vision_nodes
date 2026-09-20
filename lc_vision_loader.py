"""
LC Vision Loader
----------------
Loads a Qwen-VL GGUF model + its mmproj vision projector once and hands a
persistent handle downstream to LC Vision Caption. Kept separate from the
Run/Caption node on purpose: ComfyUI's own node-caching skips re-running a
node at all when its inputs haven't changed (the same reason a checkpoint
loader doesn't reload on every queue), so the model stays resident across
repeated captions without this node needing any of its own signature-cache
bookkeeping.

The GGUF header parser below is an original implementation against the
public GGUF format spec (https://github.com/ggml-org/ggml/blob/master/docs/gguf.md),
not ported from any GPL-licensed node -- see README.md for why that matters
here.
"""

from __future__ import annotations

import os
import struct
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Optional

import folder_paths

LLM_FOLDER_KEY = "LLM"
NODE_ID = "LCVisionLoader"
NODE_DISPLAY_NAME = "LC Vision Loader 🔬"
MODEL_TYPE = "LC_VISION_MODEL"


def _register_llm_folder() -> None:
    """Defensively register the 'LLM' folder_paths key pointing at
    models/LLM. Other packs (ComfyUI-QwenVL-Mod among them) may already
    have registered it -- don't assume load order, and don't overwrite an
    existing registration (respects the user's extra_model_paths.yaml)."""
    if LLM_FOLDER_KEY in folder_paths.folder_names_and_paths:
        return
    base = os.path.join(folder_paths.models_dir, "LLM")
    # ComfyUI wants (list of paths, set of extensions). The paths must be a LIST: get_folder_paths() slices it, so a
    # set there made ComfyUI's model list answer 500 for "LLM" and the frontend show a JSON parse error.
    folder_paths.folder_names_and_paths[LLM_FOLDER_KEY] = ([base], {".gguf"})


_register_llm_folder()


# ---------------------------------------------------------------------------
# GGUF header reading -- just enough to pull general.architecture without
# loading the model. See the GGUF spec for the value-type table this mirrors.
# ---------------------------------------------------------------------------

_GGUF_FIXED_SIZE_BY_TYPE = {
    0: 1,   # UINT8
    1: 1,   # INT8
    2: 2,   # UINT16
    3: 2,   # INT16
    4: 4,   # UINT32
    5: 4,   # INT32
    6: 4,   # FLOAT32
    7: 1,   # BOOL
    10: 8,  # UINT64
    11: 8,  # INT64
    12: 8,  # FLOAT64
}
_GGUF_TYPE_STRING = 8
_GGUF_TYPE_ARRAY = 9


def _gguf_read_string(f) -> str:
    (length,) = struct.unpack("<Q", f.read(8))
    return f.read(length).decode("utf-8", errors="replace")


def _gguf_skip_value(f, value_type: int) -> None:
    if value_type == _GGUF_TYPE_STRING:
        _gguf_read_string(f)
    elif value_type == _GGUF_TYPE_ARRAY:
        (elem_type,) = struct.unpack("<I", f.read(4))
        (count,) = struct.unpack("<Q", f.read(8))
        for _ in range(count):
            _gguf_skip_value(f, elem_type)
    elif value_type in _GGUF_FIXED_SIZE_BY_TYPE:
        f.seek(_GGUF_FIXED_SIZE_BY_TYPE[value_type], os.SEEK_CUR)
    else:
        raise ValueError(f"unrecognized GGUF value type {value_type}")


def gguf_architecture(path: str) -> Optional[str]:
    """Return the general.architecture metadata string (e.g. 'qwen3vl'),
    or None if the file isn't a readable GGUF / the key is missing."""
    try:
        with open(path, "rb") as f:
            if f.read(4) != b"GGUF":
                return None
            (version,) = struct.unpack("<I", f.read(4))
            if version not in (2, 3):
                return None
            f.read(8)  # tensor_count, unused here
            (kv_count,) = struct.unpack("<Q", f.read(8))
            for _ in range(kv_count):
                key = _gguf_read_string(f)
                (value_type,) = struct.unpack("<I", f.read(4))
                if key == "general.architecture" and value_type == _GGUF_TYPE_STRING:
                    return _gguf_read_string(f)
                _gguf_skip_value(f, value_type)
    except Exception:
        return None
    return None


# ---------------------------------------------------------------------------
# Model discovery -- pairs each non-mmproj .gguf with an mmproj sibling in
# the same directory. Only vision-capable pairs are listed: this loader's
# whole purpose is vision inference, and a bare text-only GGUF here would
# just be a dead end.
# ---------------------------------------------------------------------------

def _discover_vision_models() -> dict[str, tuple[str, str]]:
    """Return {display_name: (model_path, mmproj_path)}."""
    found: dict[str, tuple[str, str]] = {}
    try:
        base_dirs = list(folder_paths.get_folder_paths(LLM_FOLDER_KEY))
    except Exception:
        base_dirs = [os.path.join(folder_paths.models_dir, "LLM")]

    for base_dir in base_dirs:
        if not os.path.isdir(base_dir):
            continue
        for root, _dirs, files in os.walk(base_dir):
            gguf_files = [f for f in files if f.lower().endswith(".gguf")]
            mmproj_files = [f for f in gguf_files if "mmproj" in f.lower()]
            model_files = [f for f in gguf_files if "mmproj" not in f.lower()]
            if not mmproj_files or not model_files:
                continue
            # One mmproj per folder is the overwhelming common case; if a
            # folder ever has more than one, pair each model with the first
            # rather than guessing at a naming convention.
            mmproj_path = os.path.join(root, mmproj_files[0])
            for model_file in model_files:
                display = model_file[:-5] if model_file.lower().endswith(".gguf") else model_file
                found[display] = (os.path.join(root, model_file), mmproj_path)

    return found


# ---------------------------------------------------------------------------
# Curated auto-download list -- deliberately small and hand-picked, unlike
# upstream's long catalog of options that don't all actually work with this
# vision backend. Both sizes matter here (4B for video/Moviemaker workloads
# where memory headroom for multi-frame batches counts most, 8B for
# image/Caption fidelity), and both a quantized and full-precision (f16)
# option per size so this serves low-VRAM/new users and well-equipped/cloud
# users alike without forcing anyone into a multi-GB download they didn't
# ask for. mmproj always downloads at f16 -- it's small relative to the main
# model either way, and vision quality benefits more from mmproj precision
# than the LLM weights do. Real repos/filenames confirmed directly against
# HuggingFace, including the exact repo the pack's own test model came from.
# ---------------------------------------------------------------------------

DOWNLOAD_LABEL_PREFIX = "⬇ Download: "

CURATED_DOWNLOADS: dict[str, dict[str, str]] = {
    f"{DOWNLOAD_LABEL_PREFIX}Qwen3-VL-4B-abliterated (Q8_0, ~5.1GB total)": {
        "repo_id": "mradermacher/Qwen3-VL-4B-Instruct-c_abliterated-v2-GGUF",
        "model_file": "Qwen3-VL-4B-Instruct-c_abliterated-v2.Q8_0.gguf",
        "mmproj_file": "Qwen3-VL-4B-Instruct-c_abliterated-v2.mmproj-f16.gguf",
    },
    f"{DOWNLOAD_LABEL_PREFIX}Qwen3-VL-4B-abliterated (f16, ~8.9GB total)": {
        "repo_id": "mradermacher/Qwen3-VL-4B-Instruct-c_abliterated-v2-GGUF",
        "model_file": "Qwen3-VL-4B-Instruct-c_abliterated-v2.f16.gguf",
        "mmproj_file": "Qwen3-VL-4B-Instruct-c_abliterated-v2.mmproj-f16.gguf",
    },
    f"{DOWNLOAD_LABEL_PREFIX}Qwen3-VL-8B-abliterated (Q8_0, ~9.9GB total)": {
        "repo_id": "prithivMLmods/Qwen3-VL-8B-Instruct-abliterated-v2-GGUF",
        "model_file": "Qwen3-VL-8B-Instruct-abliterated-v2.Q8_0.gguf",
        "mmproj_file": "Qwen3-VL-8B-Instruct-abliterated-v2.mmproj-f16.gguf",
    },
    f"{DOWNLOAD_LABEL_PREFIX}Qwen3-VL-8B-abliterated (f16, ~17.6GB total)": {
        "repo_id": "prithivMLmods/Qwen3-VL-8B-Instruct-abliterated-v2-GGUF",
        "model_file": "Qwen3-VL-8B-Instruct-abliterated-v2.f16.gguf",
        "mmproj_file": "Qwen3-VL-8B-Instruct-abliterated-v2.mmproj-f16.gguf",
    },
}


def _curated_target_dir() -> str:
    """Where auto-downloads land -- the first path registered under the
    'LLM' folder key, same root _discover_vision_models() already walks, so
    a downloaded pair is found normally on the next dropdown refresh with no
    change to the discovery logic itself."""
    try:
        base_dirs = list(folder_paths.get_folder_paths(LLM_FOLDER_KEY))
    except Exception:
        base_dirs = []
    base_dir = base_dirs[0] if base_dirs else os.path.join(folder_paths.models_dir, "LLM")
    os.makedirs(base_dir, exist_ok=True)
    return base_dir


def _download_with_progress(url: str, dest_path: str) -> None:
    """Resumable-ish fallback downloader (Range-header resume, no external
    dependency) for when huggingface_hub isn't importable. Writes to a
    .part file and renames on completion so a crash mid-download can't
    leave a truncated file mistaken for a finished one."""
    part_path = dest_path + ".part"
    existing = os.path.getsize(part_path) if os.path.exists(part_path) else 0

    req = urllib.request.Request(url)
    if existing:
        req.add_header("Range", f"bytes={existing}-")

    with urllib.request.urlopen(req) as resp:
        total = resp.length
        total_str = f"{(existing + total) / (1024 ** 3):.2f}GB" if total else "unknown size"
        mode = "ab" if existing and resp.status == 206 else "wb"
        if mode == "wb":
            existing = 0
        downloaded = existing
        last_pct = -1
        with open(part_path, mode) as f:
            while True:
                chunk = resp.read(1024 * 1024)
                if not chunk:
                    break
                f.write(chunk)
                downloaded += len(chunk)
                if total:
                    pct = int(downloaded * 100 / (existing + total)) if mode == "ab" else int(downloaded * 100 / total)
                    if pct != last_pct and pct % 5 == 0:
                        print(f"[LC Vision] Downloading {os.path.basename(dest_path)}: {pct}% of {total_str}")
                        last_pct = pct
    os.replace(part_path, dest_path)


def _ensure_downloaded(repo_id: str, filename: str, target_dir: str) -> str:
    """Return the local path for repo_id/filename under target_dir,
    downloading it first if not already present. Prefers huggingface_hub
    (resumable, ETag-cached) when importable; falls back to a small
    hand-rolled resumable downloader rather than adding a hard dependency."""
    dest_path = os.path.join(target_dir, filename)
    if os.path.exists(dest_path):
        return dest_path

    print(f"[LC Vision] '{filename}' not found locally -- downloading from {repo_id}...")
    try:
        from huggingface_hub import hf_hub_download

        downloaded_path = hf_hub_download(
            repo_id=repo_id,
            filename=filename,
            local_dir=target_dir,
        )
        if os.path.abspath(downloaded_path) != os.path.abspath(dest_path) and os.path.exists(downloaded_path):
            os.replace(downloaded_path, dest_path)
    except ImportError:
        url = f"https://huggingface.co/{repo_id}/resolve/main/{filename}"
        _download_with_progress(url, dest_path)

    if not os.path.exists(dest_path):
        raise RuntimeError(f"[LC Vision] Download of '{filename}' from {repo_id} did not produce the expected file.")
    print(f"[LC Vision] Finished downloading '{filename}'.")
    return dest_path


# ---------------------------------------------------------------------------
# The handle passed downstream. Carries the build parameters alongside the
# live objects -- not just for bookkeeping. LC Vision Caption needs them to
# rebuild the model in place if a generation call fails with the decode
# error this pack's README traces to stale internal state: reset() and
# clearing _hybrid_cache_mgr don't fully cover it (confirmed empirically --
# a fresh instance handles the exact same request that a reused one fails
# on), and there's no full visibility into every cache a given
# llama-cpp-python build's native mtmd context keeps between calls. Rebuild
# and retry once is the reliable answer instead of chasing every possible
# private attribute.
# ---------------------------------------------------------------------------

@dataclass
class LCVisionBuildParams:
    model_path: str
    mmproj_path: str
    device_kind: str
    n_gpu_layers: int
    n_ctx: int
    n_batch: int
    image_min_tokens: int
    image_max_tokens: int
    batch_max_tokens: int
    verbose: bool


def build_llama(params: LCVisionBuildParams) -> tuple[Any, Any]:
    """Construct a fresh (Llama, chat_handler) pair from build params.
    Shared by the Loader's initial load and Caption's rebuild-on-failure
    path, so both go through exactly one code path for this."""
    from llama_cpp import Llama

    handler_cls = None
    try:
        from llama_cpp.llama_chat_format import Qwen3VLChatHandler as handler_cls
    except ImportError:
        try:
            from llama_cpp.llama_chat_format import Qwen25VLChatHandler as handler_cls
        except ImportError:
            pass
    if handler_cls is None:
        raise RuntimeError(
            "[LC Vision] Installed llama_cpp has neither Qwen3VLChatHandler nor "
            "Qwen25VLChatHandler -- it doesn't have vision support compiled in. "
            "Run this pack's install.py to fix it."
        )

    chat_handler = handler_cls(
        mmproj_path=params.mmproj_path,
        image_min_tokens=params.image_min_tokens,
        image_max_tokens=params.image_max_tokens,
        batch_max_tokens=params.batch_max_tokens,
        verbose=params.verbose,
    )

    llm = Llama(
        model_path=params.model_path,
        chat_handler=chat_handler,
        n_ctx=params.n_ctx,
        n_gpu_layers=params.n_gpu_layers,
        n_batch=params.n_batch,
        n_ubatch=params.n_batch,
        swa_full=True,
        verbose=params.verbose,
    )
    return llm, chat_handler


@dataclass
class LCVisionModel:
    llm: Any
    chat_handler: Any
    model_name: str
    architecture: Optional[str]
    is_qwen3_family: bool
    n_ctx: int
    build_params: "LCVisionBuildParams" = field(default=None)


class LCVisionLoader:
    @classmethod
    def INPUT_TYPES(cls):
        models = _discover_vision_models()
        model_keys = sorted(models.keys())
        already_have = {os.path.basename(p[0]) for p in models.values()}
        model_keys += [
            label for label, entry in CURATED_DOWNLOADS.items()
            if entry["model_file"] not in already_have
        ]
        if not model_keys:
            model_keys = ["(no vision GGUF models found in models/LLM/GGUF)"]
        return {
            "required": {
                "model_name": (
                    model_keys,
                    {
                        "tooltip": (
                            "Vision-capable GGUF models found under models/LLM/GGUF (or any "
                            "path registered under the 'LLM' folder key) -- only files with an "
                            "mmproj sibling in the same folder are listed. Entries prefixed "
                            "'Download:' aren't on disk yet -- selecting one downloads it (and "
                            "its mmproj) on first use, matching upstream QwenVL-Mod's own "
                            "auto-download behavior."
                        ),
                    },
                ),
                "device": (
                    ["auto", "cuda", "cpu"],
                    {
                        "default": "auto",
                        "tooltip": (
                            "auto prefers CUDA when available. Any option works from the same "
                            "install -- CPU inference doesn't need a separate CPU-only build."
                        ),
                    },
                ),
                "n_gpu_layers": (
                    "INT",
                    {
                        "default": -1,
                        "min": -1,
                        "max": 999,
                        "tooltip": "-1 offloads every layer to GPU. 0 forces CPU-only. Any other value offloads that many layers, leaving the rest on CPU RAM.",
                    },
                ),
                "n_ctx": (
                    "INT",
                    {
                        "default": 32768,
                        "min": 512,
                        "max": 131072,
                        "step": 512,
                        "tooltip": "Context window in tokens.",
                    },
                ),
                "n_batch": (
                    "INT",
                    {
                        "default": 2048,
                        "min": 64,
                        "max": 32768,
                        "step": 64,
                        "tooltip": (
                            "Per-decode-call token capacity. Also sets n_ubatch to the same "
                            "value -- llama-cpp-python defaults n_ubatch to 512 independently "
                            "of n_batch (n_ubatch = min(n_batch, n_ubatch) internally), so "
                            "raising n_batch alone silently does nothing unless n_ubatch tracks "
                            "it. Raise this if a large or multi-reference input overflows it."
                        ),
                    },
                ),
            },
            "optional": {
                "image_min_tokens": (
                    "INT",
                    {"default": 1024, "min": -1, "max": 16384, "tooltip": "-1 = model default. Qwen-VL models want at least 1024 for reliable grounding."},
                ),
                "image_max_tokens": (
                    "INT",
                    {"default": -1, "min": -1, "max": 16384, "tooltip": "-1 = no cap beyond n_batch."},
                ),
                "batch_max_tokens": (
                    "INT",
                    {"default": 1024, "min": 64, "max": 16384, "tooltip": "The vision chat handler's own per-batch token limit for image embedding, separate from n_batch/n_ubatch. Raise alongside n_batch for multiple large references."},
                ),
                "verbose": ("BOOLEAN", {"default": False, "tooltip": "Print llama.cpp's own internal load/inference diagnostics to the console. Off by default to keep logs readable."}),
            },
        }

    RETURN_TYPES = (MODEL_TYPE,)
    RETURN_NAMES = ("vision_model",)
    FUNCTION = "load"
    CATEGORY = "LC Vision"
    DESCRIPTION = (
        "Loads a Qwen-VL GGUF model + mmproj vision projector once. ComfyUI's own node "
        "caching keeps it resident across queues as long as these inputs don't change."
    )

    def load(
        self,
        model_name: str,
        device: str = "auto",
        n_gpu_layers: int = -1,
        n_ctx: int = 32768,
        n_batch: int = 2048,
        image_min_tokens: int = 1024,
        image_max_tokens: int = -1,
        batch_max_tokens: int = 1024,
        verbose: bool = False,
    ) -> tuple[LCVisionModel]:
        try:
            import llama_cpp  # noqa: F401
        except Exception as exc:
            raise RuntimeError(
                "[LC Vision] llama_cpp is not installed, or the installed copy cannot load or lacks vision "
                f"support ({type(exc).__name__}: {exc}). Run this pack's install.py (or see README.md; AMD/Intel "
                "GPUs need a source build, see 'AMD, Intel and other non-NVIDIA GPUs')."
            ) from exc

        if model_name in CURATED_DOWNLOADS:
            entry = CURATED_DOWNLOADS[model_name]
            target_dir = _curated_target_dir()
            model_path = _ensure_downloaded(entry["repo_id"], entry["model_file"], target_dir)
            mmproj_path = _ensure_downloaded(entry["repo_id"], entry["mmproj_file"], target_dir)
        else:
            models = _discover_vision_models()
            if model_name not in models:
                raise FileNotFoundError(
                    f"[LC Vision] '{model_name}' not found under models/LLM/GGUF. "
                    "Place the model .gguf and its mmproj .gguf in the same folder."
                )
            model_path, mmproj_path = models[model_name]

        if device == "auto":
            import torch

            device_kind = "cuda" if torch.cuda.is_available() else "cpu"
        else:
            device_kind = device
        effective_gpu_layers = 0 if device_kind == "cpu" else n_gpu_layers

        arch = gguf_architecture(model_path)
        is_qwen3_family = bool(arch and "qwen3" in arch.lower())

        build_params = LCVisionBuildParams(
            model_path=str(model_path),
            mmproj_path=str(mmproj_path),
            device_kind=device_kind,
            n_gpu_layers=effective_gpu_layers,
            n_ctx=n_ctx,
            n_batch=n_batch,
            image_min_tokens=image_min_tokens,
            image_max_tokens=image_max_tokens,
            batch_max_tokens=batch_max_tokens,
            verbose=verbose,
        )
        llm, chat_handler = build_llama(build_params)

        print(
            f"[LC Vision] Loaded '{model_name}' (arch={arch}, device={device_kind}, "
            f"gpu_layers={effective_gpu_layers}, n_ctx={n_ctx}, n_batch/n_ubatch={n_batch})"
        )

        handle = LCVisionModel(
            llm=llm,
            chat_handler=chat_handler,
            model_name=model_name,
            architecture=arch,
            is_qwen3_family=is_qwen3_family,
            n_ctx=n_ctx,
            build_params=build_params,
        )
        return (handle,)


NODE_CLASS_MAPPINGS = {
    NODE_ID: LCVisionLoader,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_ID: NODE_DISPLAY_NAME,
}
