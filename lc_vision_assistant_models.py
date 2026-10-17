"""
Vision Assistant: the models a workflow uses. Finds each file in your model folders (present / missing, size), hashes
it on request (SHA-256, cached by size and date so a 12 GB file is only read once), and looks it up on CivitAI by that
hash, or by name for a missing file. Nothing here contacts CivitAI unless the person presses a button for it.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import threading
import urllib.error
import urllib.parse
import urllib.request

import folder_paths

EXTS = (".safetensors", ".ckpt", ".pt", ".pth", ".bin", ".gguf", ".sft")
# widget name -> the folder it reads from (anything else with a model file extension is searched in every folder)
HINTS = {
    "ckpt_name": "checkpoints", "unet_name": "diffusion_models", "lora_name": "loras", "vae_name": "vae",
    "clip_name": "text_encoders", "clip_name1": "text_encoders", "clip_name2": "text_encoders", "clip_name3": "text_encoders",
    "clip_name4": "text_encoders", "control_net_name": "controlnet", "style_model_name": "style_models",
    "upscale_model": "upscale_models", "ipadapter_file": "ipadapter", "model_patch": "model_patch", "gligen_name": "gligen",
}
CACHE = os.path.join(folder_paths.get_user_directory(), "vision_assistant", "hashes.json")
_lock = threading.Lock()


def _load_cache():
    try:
        return json.load(open(CACHE, encoding="utf-8"))
    except Exception:
        return {}


def _save_cache(c):
    os.makedirs(os.path.dirname(CACHE), exist_ok=True)
    tmp = CACHE + ".tmp"
    json.dump(c, open(tmp, "w", encoding="utf-8"), indent=1)
    os.replace(tmp, CACHE)


def _stamp(path):
    st = os.stat(path)
    return st.st_size, int(st.st_mtime)


# weights some LC nodes read from outside the registered model folders
EXTRA_DIRS = [
    (re.compile(r"^rife\d+\.pth$", re.I), "rife", lambda: [os.path.join(folder_paths.models_dir, "rife"),
                                                         os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                                                      "ComfyUI-Frame-Interpolation", "ckpts", "rife")]),
]


def resolve(name, hint=None):
    """(folder, full path) of a model file name as a widget holds it, or (hint, None) when it is not on this computer.
    A file moved to another subfolder of the same kind is found by its name (moved = the path differs from the saved one)."""
    folders = ([hint] if hint else []) + [f for f in folder_paths.folder_names_and_paths if f != hint]
    for f in folders:
        try:
            p = folder_paths.get_full_path(f, name)
        except Exception:
            p = None
        if p and os.path.isfile(p):
            return f, p
    want = os.path.basename(name.replace("\\", "/")).lower()
    for pat, folder, dirs in EXTRA_DIRS:
        if pat.match(want):
            for d in dirs():
                p = os.path.join(d, want)
                if os.path.isfile(p):
                    return folder, p
    for f in ([hint] if hint else folders):  # by name only in the folder the node reads from: generic names stay unmatched
        try:
            hits = [x for x in folder_paths.get_filename_list(f) if os.path.basename(x.replace("\\", "/")).lower() == want]
        except Exception:
            hits = []
        if len(hits) == 1:
            p = folder_paths.get_full_path(f, hits[0])
            if p and os.path.isfile(p):
                return f, p
    return hint, None


def _where(folder, path):
    """The subfolder a file sits in, as the model folder's own name shows it (MiniMax/Utility), or its parent folder."""
    d = os.path.dirname(os.path.abspath(path))
    try:
        for root in folder_paths.get_folder_paths(folder):
            root = os.path.abspath(root)
            if d.lower().startswith(root.lower()):
                return os.path.relpath(d, root) if d.lower() != root.lower() else folder
    except Exception:
        pass
    return os.path.basename(d)


def cached_hash(path):
    size, mtime = _stamp(path)
    e = _load_cache().get(os.path.abspath(path))
    return e["sha256"] if e and e.get("size") == size and e.get("mtime") == mtime else None


def sha256(path):
    """SHA-256 of a file, cached by size and date (a changed file is hashed again)."""
    have = cached_hash(path)
    if have:
        return have
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 24), b""):
            h.update(chunk)
    digest = h.hexdigest()
    size, mtime = _stamp(path)
    with _lock:
        c = _load_cache()
        c[os.path.abspath(path)] = {"size": size, "mtime": mtime, "sha256": digest}
        _save_cache(c)
    return digest


def _get_json(url):
    if not url.startswith("https://civitai.com/"):
        raise ValueError("only civitai.com")
    req = urllib.request.Request(url, headers={"User-Agent": "LC-Vision-Assistant", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode("utf-8"))


def civitai_by_hash(digest):
    """The exact CivitAI model version for this file, or None (custom, private or not on CivitAI)."""
    try:
        v = _get_json("https://civitai.com/api/v1/model-versions/by-hash/" + urllib.parse.quote(digest))
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        raise
    if not v or "modelId" not in v:
        return None
    return {"model": (v.get("model") or {}).get("name") or "", "version": v.get("name") or "", "model_id": v.get("modelId"),
            "version_id": v.get("id"), "base": v.get("baseModel") or "",
            "url": f"https://civitai.com/models/{v.get('modelId')}?modelVersionId={v.get('id')}"}


def civitai_search(query, kind=None):
    """CivitAI models whose name matches (by name only: the person checks it is the right one)."""
    q = os.path.splitext(os.path.basename(query))[0].replace("_", " ").replace("-", " ")
    params = {"query": q[:80], "limit": "5", "nsfw": "true"}
    j = _get_json("https://civitai.com/api/v1/models?" + urllib.parse.urlencode(params))
    out = []
    for m in (j.get("items") or [])[:5]:
        v = (m.get("modelVersions") or [{}])[0]
        out.append({"model": m.get("name") or "", "type": m.get("type") or "", "base": v.get("baseModel") or "",
                    "url": f"https://civitai.com/models/{m.get('id')}"})
    return out


try:
    from aiohttp import web
    from server import PromptServer

    def _ok(data):
        return web.json_response(data)

    @PromptServer.instance.routes.post("/lc_vision/assistant/models")
    async def _models(request):
        """[{name, hint}] -> where each file is, its size and its hash when already known."""
        body = await request.json()
        out = []
        for it in body.get("items", [])[:300]:
            name, hint = str(it.get("name", "")), it.get("hint")
            folder, path = resolve(name, hint)
            row = {"name": name, "folder": folder, "exists": bool(path)}
            if path:
                size, _ = _stamp(path)
                row.update(size=size, sha256=cached_hash(path))
                if not path.replace("\\", "/").lower().endswith(name.replace("\\", "/").lower()):
                    row["moved"] = _where(folder, path)  # found by name in another subfolder
            out.append(row)
        return _ok({"items": out})

    @PromptServer.instance.routes.post("/lc_vision/assistant/model_hash")
    async def _model_hash(request):
        body = await request.json()
        folder, path = resolve(str(body.get("name", "")), body.get("hint"))
        if not path:
            return _ok({"error": "not on this computer"})
        digest = await asyncio.get_running_loop().run_in_executor(None, sha256, path)
        return _ok({"sha256": digest, "size": _stamp(path)[0]})

    @PromptServer.instance.routes.post("/lc_vision/assistant/civitai")
    async def _civitai(request):
        """{sha256} -> the exact model page, or {query} -> name matches. Only when the person asks."""
        body = await request.json()
        loop = asyncio.get_running_loop()
        try:
            if body.get("sha256"):
                return _ok({"match": await loop.run_in_executor(None, civitai_by_hash, str(body["sha256"]))})
            if body.get("query"):
                return _ok({"results": await loop.run_in_executor(None, civitai_search, str(body["query"]))})
        except Exception as e:
            return _ok({"error": f"CivitAI did not answer: {e}"})
        return _ok({"error": "nothing to look up"})
except Exception as e:  # no server (tests): the helpers still work
    print(f"[LC Vision] assistant model routes not registered: {e}")

NODE_CLASS_MAPPINGS = {}
