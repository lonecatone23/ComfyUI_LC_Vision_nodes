"""
LC Vision model routes (no node)
--------------------------------
Backs the Vision section of LC Settings: which vision models are on disk, and a download button for the
curated ones, with progress the settings page can show (the console prints it too).

  GET  /lc_vision/models            -> {"installed": [...], "curated": [...], "folder": str}
  POST /lc_vision/download          {"label"} -> {"ok"} | {"error"}
  GET  /lc_vision/download/status   -> {"active", "label", "file", "done", "total", "error", "finished"}
"""

from __future__ import annotations

import os
import threading
import time

from .lc_vision_loader import CURATED_DOWNLOADS, DOWNLOAD_LABEL_PREFIX, _curated_target_dir, _discover_vision_models, _ensure_downloaded, gguf_architecture

_JOB = {"active": False, "label": "", "file": "", "done": 0, "total": 0, "error": "", "finished": "", "started": 0.0}
_LOCK = threading.Lock()


def _gb(path: str) -> float:
    try:
        return round(os.path.getsize(path) / 1024 ** 3, 2)
    except OSError:
        return 0.0


def _installed():
    out = []
    for name, (model, mmproj) in sorted(_discover_vision_models().items()):
        out.append({"name": name, "model": model, "mmproj": mmproj, "gb": round(_gb(model) + _gb(mmproj), 2),
                    "arch": gguf_architecture(model) or ""})
    return out


def _remote_size(repo_id: str, filename: str) -> int:
    try:
        from huggingface_hub import get_hf_file_metadata, hf_hub_url

        return int(get_hf_file_metadata(hf_hub_url(repo_id, filename)).size or 0)
    except Exception:
        return 0


def _partial_bytes(folder: str, filename: str) -> int:
    """Bytes of the download in progress. The fallback downloader writes <file>.part; huggingface_hub writes a
    hash-named .incomplete under <folder>/.cache, so take the newest one started since this job began."""
    part = os.path.join(folder, filename + ".part")
    if os.path.exists(part):
        return os.path.getsize(part)
    newest, when = None, _JOB["started"] - 5
    for root, _dirs, files in os.walk(os.path.join(folder, ".cache", "huggingface", "download")):
        for f in files:
            if f.endswith(".incomplete"):
                p = os.path.join(root, f)
                if os.path.getmtime(p) >= when:
                    newest, when = p, os.path.getmtime(p)
    return os.path.getsize(newest) if newest else 0


def _run(label: str):
    entry = CURATED_DOWNLOADS[label]
    folder = _curated_target_dir()
    try:
        for key in ("model_file", "mmproj_file"):
            fname = entry[key]
            _JOB.update(file=fname, done=0, total=_remote_size(entry["repo_id"], fname))
            _ensure_downloaded(entry["repo_id"], fname, folder)
        _JOB["finished"] = label
    except Exception as e:
        _JOB["error"] = str(e)
    finally:
        _JOB["active"] = False


try:
    from aiohttp import web
    from server import PromptServer

    @PromptServer.instance.routes.get("/lc_vision/models")
    async def _models(_request):
        installed = _installed()
        have = {os.path.basename(m["model"]) for m in installed}
        curated = [{"label": label[len(DOWNLOAD_LABEL_PREFIX):] if label.startswith(DOWNLOAD_LABEL_PREFIX) else label, "key": label,
                    "repo": e["repo_id"], "model_file": e["model_file"], "mmproj_file": e["mmproj_file"],
                    "have": e["model_file"] in have} for label, e in CURATED_DOWNLOADS.items()]
        return web.json_response({"installed": installed, "curated": curated, "folder": _curated_target_dir()})

    @PromptServer.instance.routes.post("/lc_vision/download")
    async def _download(request):
        data = await request.json()
        label = data.get("label") or ""
        if label not in CURATED_DOWNLOADS:
            return web.json_response({"error": "Unknown model."}, status=400)
        with _LOCK:
            if _JOB["active"]:
                return web.json_response({"error": f"Already downloading {_JOB['file']}."}, status=409)
            _JOB.update(active=True, label=label, file="", done=0, total=0, error="", finished="", started=time.time())
        threading.Thread(target=_run, args=(label,), daemon=True).start()
        return web.json_response({"ok": True})

    @PromptServer.instance.routes.get("/lc_vision/download/status")
    async def _status(_request):
        job = dict(_JOB)
        if job["active"] and job["file"]:
            job["done"] = _partial_bytes(_curated_target_dir(), job["file"])
        job.pop("started", None)
        return web.json_response(job)
except Exception as e:  # pragma: no cover - only when imported outside ComfyUI
    print(f"[LC Vision] model routes not registered: {e}")

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
