"""
LC Vision Translate (server routes, no node)
--------------------------------------------
Backs the Translate button on LC123's LC Note. Nothing to wire: the note calls
these routes, this loads an LC Vision GGUF model text-only (no mmproj), translates
the markdown, and unloads it again so it never sits in VRAM between clicks.

  GET  /lc_vision/translate/status  -> {"available": bool, "models": [...], "default": str}
  POST /lc_vision/translate         {"text", "target", "model"?, "title"?} -> {"text", "title"} | {"error"}

Code blocks, inline code, URLs and HTML tags are swapped for placeholders before
the model sees the text and swapped back after, so the markdown survives.
"""

from __future__ import annotations

import gc
import re
import threading

from .lc_vision_loader import _discover_vision_models, gguf_architecture

_LOCK = threading.Lock()
_PH = "⟦{}⟧"  # ⟦0⟧
_PROTECT = [
    re.compile(r"```.*?```", re.S),                     # fenced code
    re.compile(r"`[^`\n]+`"),                           # inline code
    re.compile(r"(?<=\]\()[^)\s]+(?=\))"),              # link targets
    re.compile(r"https?://[^\s)>\]]+"),                 # bare urls
    re.compile(r"</?[A-Za-z][^>\n]*>"),                 # html tags
]


def _protect(text: str):
    saved = []

    def keep(m):
        saved.append(m.group(0))
        return _PH.format(len(saved) - 1)

    for rx in _PROTECT:
        text = rx.sub(keep, text)
    return text, saved


def _restore(text: str, saved: list[str]):
    missing = [i for i in range(len(saved)) if _PH.format(i) not in text]
    for i, s in enumerate(saved):
        text = text.replace(_PH.format(i), s)
    return text, missing


_NUM = re.compile(r"(?<![A-Za-z_\d.])\d+(?:[.,]\d+)?(?!\d)")


def _numbers(text: str) -> list[str]:
    return sorted(_NUM.findall(re.sub(r"⟦\d+⟧", " ", text)))


def _clean(out: str) -> str:
    out = re.sub(r"<think>.*?</think>", "", out, flags=re.S).strip()
    out = re.sub(r"^\s*/no_think\s*", "", out)
    m = re.match(r"^```(?:markdown|md)?\s*\n(.*)\n```\s*$", out, re.S)
    return m.group(1) if m else out


def _pick_model(requested: str | None):
    models = _discover_vision_models()
    if not models:
        return None, None
    if requested and requested in models:
        name = requested
    else:
        # translation quality first: an 8B quant, then a 4B quant, then anything
        quant = [n for n in models if not re.search(r"f16|bf16|f32", n, re.I)]
        big = [n for n in quant if re.search(r"8b", n, re.I)]
        small = [n for n in quant if re.search(r"4b", n, re.I)]
        name = sorted(big or small or quant or models)[0]
    return name, models[name][0]


def _run(llm, system: str, text: str, target: str, name: str, what: str) -> str:
    body, saved = _protect(text)
    want_nums = _numbers(body)
    for attempt, temp in enumerate((0.2, 0.05, 0.4)):
        r = llm.create_chat_completion(
            messages=[{"role": "system", "content": system}, {"role": "user", "content": body}],
            max_tokens=min(12000, 200 + len(body) * 3),
            temperature=temp,
            top_p=0.9,
            repeat_penalty=1.05,
        )
        out = _clean((r["choices"][0]["message"].get("content") or "").strip())
        restored, missing = _restore(out, saved)
        # a marker the model invented (not one of ours) must never reach the note
        restored = re.sub(r"\s*⟦\d+⟧", "", restored).strip()
        if out and not missing and _numbers(out) != want_nums:
            missing = ["numbers"]
        if out and not missing:
            print(f"[LC Vision] translated note {what} to {target} with {name}")
            return restored
        print(f"[LC Vision] {what} attempt {attempt + 1} lost links, code or numbers ({missing[:3]}), retrying")
    raise RuntimeError("The model kept changing links, code or numbers in the note. Try again, or shorten the note.")


def _translate(text: str, target: str, requested_model: str | None, title: str | None = None):
    """Returns (text, title). The title is best effort: None if it could not be translated."""
    from llama_cpp import Llama

    name, path = _pick_model(requested_model)
    if not path:
        raise RuntimeError(
            "No LC Vision model found. Run an LC Vision Loader once to download one, "
            "or put a Qwen-VL .gguf (with its mmproj) in models/LLM/GGUF."
        )
    try:
        import torch

        gpu = -1 if torch.cuda.is_available() else 0
    except Exception:
        gpu = 0
    qwen3 = "qwen3" in (gguf_architecture(path) or "").lower()

    system = (
        f"You are a professional translator. Translate the user's Markdown document into {target}. "
        "Keep the Markdown structure exactly: the same headings, lists, tables, bold and italics, "
        "line breaks and emoji. Copy every placeholder like ⟦3⟧ exactly as it is. "
        "Do not translate ComfyUI node names, setting names, file names or model names. "
        "Keep every number exactly as written. Output only the translated Markdown, nothing else."
        + (" /no_think" if qwen3 else "")
    )
    title_system = (
        f"Translate this short title of a ComfyUI workflow note into {target}. Keep any emoji exactly. "
        "If a word is a name that should not be translated, keep it. "
        "Output only the translated title on one line, with nothing added." + (" /no_think" if qwen3 else "")
    )
    llm = Llama(model_path=path, n_ctx=16384, n_gpu_layers=gpu, verbose=False)
    try:
        out = _run(llm, system, text, target, name, "text")
        out_title = None
        if title and title.strip():
            try:
                out_title = _run(llm, title_system, title.strip(), target, name, "title").splitlines()[0].strip() or None
            except Exception as e:
                print(f"[LC Vision] title not translated ({e}); the note shows the original title twice")
        return out, out_title
    finally:
        del llm
        gc.collect()
        try:
            import torch

            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass


try:
    from aiohttp import web
    from server import PromptServer

    @PromptServer.instance.routes.get("/lc_vision/translate/status")
    async def _status(_request):
        try:
            import llama_cpp  # noqa: F401

            ok = True
        except Exception:
            ok = False
        models = sorted(_discover_vision_models()) if ok else []
        default = _pick_model(None)[0] if models else ""
        return web.json_response({"available": ok and bool(models), "models": models, "default": default})

    @PromptServer.instance.routes.post("/lc_vision/translate")
    async def _translate_route(request):
        import asyncio

        data = await request.json()
        text, target = data.get("text") or "", data.get("target") or ""
        if not text.strip() or not target:
            return web.json_response({"error": "Nothing to translate."}, status=400)
        if not _LOCK.acquire(blocking=False):
            return web.json_response({"error": "Another translation is still running."}, status=409)
        try:
            out, title = await asyncio.get_running_loop().run_in_executor(
                None, _translate, text, target, data.get("model"), data.get("title")
            )
            return web.json_response({"text": out, "title": title})
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)
        finally:
            _LOCK.release()
except Exception as e:  # pragma: no cover - only when imported outside ComfyUI
    print(f"[LC Vision] translate routes not registered: {e}")

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
