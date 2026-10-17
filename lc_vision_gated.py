"""
Gated Hugging Face models, for Vision Assistant
------------------------------------------------
Some model repos need their license accepted before anything downloads (Black Forest Labs' FLUX, Meta's SAM 3 and
Llama). This answers, per repo: is it gated, how ("auto" = access the moment you click Agree, "manual" = the owner
approves each request by hand), the license and its link, whether this computer is logged in to Hugging Face, and
whether that login already has access. The token itself never leaves the computer and is never returned.
"""
from __future__ import annotations

import asyncio
import os
import sys
import time

_CACHE: dict[str, tuple[float, dict]] = {}
_TTL = 600  # seconds


def _login_cmd() -> str:
    """The login command for this install: the portable build ships hf.exe in python_embeded\\Scripts."""
    d = os.path.dirname(sys.executable)
    if os.path.basename(d).lower() == "python_embeded" and os.path.exists(os.path.join(d, "Scripts", "hf.exe")):
        return "python_embeded\\Scripts\\hf.exe auth login"
    return "hf auth login"


def gate(repo: str, refresh: bool = False) -> dict:
    now = time.time()
    hit = _CACHE.get(repo)
    if hit and not refresh and now - hit[0] < _TTL:
        return hit[1]
    out = {"repo": repo, "page_url": f"https://huggingface.co/{repo}", "token_url": "https://huggingface.co/settings/tokens",
           "login_cmd": _login_cmd(), "gated": None, "mode": None, "has_token": False, "access": None,
           "license": "", "license_url": ""}
    try:
        from huggingface_hub import HfApi, auth_check, get_token
        from huggingface_hub.errors import GatedRepoError, RepositoryNotFoundError
    except Exception as e:  # pragma: no cover
        out["error"] = f"huggingface_hub is missing: {e}"
        return out
    token = get_token()
    out["has_token"] = bool(token)
    try:
        info = HfApi().model_info(repo, token=token or False)
    except Exception as e:
        out["error"] = f"Couldn't reach Hugging Face: {e.__class__.__name__}"
        return out
    mode = getattr(info, "gated", False) or False
    out["gated"] = bool(mode)
    out["mode"] = mode if mode else None
    card = getattr(info, "card_data", None) or {}
    get = card.get if hasattr(card, "get") else (lambda k, d=None: getattr(card, k, d))
    name = get("license_name") or get("license") or ""
    link = get("license_link") or ""
    if link and not link.startswith("http"):
        link = f"https://huggingface.co/{repo}/blob/main/{link}"
    out["license"], out["license_url"] = str(name), link
    if out["gated"]:
        if not token:
            out["access"] = False
        else:
            try:
                auth_check(repo, token=token)
                out["access"] = True
            except GatedRepoError:
                out["access"] = False  # not accepted yet, or (manual gates) still waiting for approval
            except RepositoryNotFoundError:
                out["access"] = False
            except Exception:
                out["access"] = None
    else:
        out["access"] = True
    _CACHE[repo] = (now, out)
    return out


try:
    from aiohttp import web
    from server import PromptServer

    @PromptServer.instance.routes.get("/lc_vision/hf_gate")
    async def _hf_gate(request):
        repo = (request.query.get("repo") or "").strip()
        if not repo or "/" not in repo or len(repo) > 200:
            return web.json_response({"error": "Give a repo like owner/name."}, status=400)
        refresh = request.query.get("refresh") == "1"
        loop = asyncio.get_running_loop()
        return web.json_response(await loop.run_in_executor(None, gate, repo, refresh))
except Exception as e:  # pragma: no cover - only when imported outside ComfyUI
    print(f"[LC Vision] gated-model route not registered: {e}")

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
