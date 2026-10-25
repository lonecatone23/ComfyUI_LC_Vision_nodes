"""
LC Vision Translate (server routes, no node)
--------------------------------------------
Backs the Translate button on LC123's LC Note. Nothing to wire: the note calls
these routes, this loads an LC Vision GGUF model text-only (no mmproj), translates
the markdown, and unloads it again so it never sits in VRAM between clicks.

  GET  /lc_vision/translate/status  -> {"available": bool, "models": [...], "default": str}
  POST /lc_vision/translate         {"text", "target", "model"?, "title"?, "task"?} -> {"text", "title"} | {"error"}
                                    task "spelling": fix typos only, same language
  POST /lc_vision/write_note        {"workflow", "model"?} -> {"text"} | {"error"}   (a first draft of a workflow note)

Code blocks, inline code, URLs and HTML tags are swapped for placeholders before
the model sees the text and swapped back after, so the markdown survives.
"""

from __future__ import annotations

import gc
import re
import threading

from .lc_vision_loader import _discover_vision_models, gguf_architecture, strip_thinking

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
    return sorted(n.replace(",", "") for n in _NUM.findall(re.sub(r"⟦\d+⟧", " ", text)))


def _lost_numbers(want: list[str], got: list[str]) -> list[str]:
    """Numbers of the original missing from the translation (extra ones are fine: a language may spell a list out)."""
    left = list(got)
    lost = []
    for n in want:
        if n in left:
            left.remove(n)
        else:
            lost.append(n)
    return lost


_WARN: list[str] = []  # soft problems of the current request (numbers to check); reset per request under _LOCK


def _clean(out: str) -> str:
    out = strip_thinking(out)
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
    best = None  # (lost numbers, text): links and code all kept, only numbers off
    for attempt, temp in enumerate((0.2, 0.05, 0.4)):
        r = llm.create_chat_completion(
            messages=[{"role": "system", "content": system}, {"role": "user", "content": body}],
            max_tokens=max(256, min(12000, 200 + len(body) * 3, _CTX["ctx"] - len(body) // 3 - len(system) // 3 - 64)),
            temperature=temp,
            top_p=0.9,
            repeat_penalty=1.05,
        )
        out = _clean((r["choices"][0]["message"].get("content") or "").strip())
        restored, missing = _restore(out, saved)
        # a marker the model invented (not one of ours) must never reach the note
        restored = re.sub(r"\s*⟦\d+⟧", "", restored).strip()
        if out and not missing:
            lost = _lost_numbers(want_nums, _numbers(out))
            if not lost:
                print(f"[LC Vision] translated note {what} to {target} with {name}")
                return restored
            if best is None or len(lost) < len(best[0]):
                best = (lost, restored)
            missing = ["numbers"]
        print(f"[LC Vision] {what} attempt {attempt + 1} lost links, code or numbers ({missing[:3]}), retrying")
    if best is not None:  # links and code are fine, only numbers moved: keep the closest try and say which to check
        nums = ", ".join(dict.fromkeys(best[0]))[:80]
        _WARN.append(f"check these numbers in the {what}: {nums}")
        print(f"[LC Vision] translated note {what} to {target} with {name}, numbers to check: {nums}")
        return best[1]
    raise RuntimeError("The model kept changing links or code in the note. Try again, or shorten the note.")


_CTX = {"ctx": 16384}  # context of the model loaded for the current request (sizes the replies and the chunks)


def _llm(requested_model):
    """Load a model the way the Vision Assistant chat picks one: what fits this card (half of it, 11 GB at most), after
    ComfyUI is asked to make room; nothing fits = the smallest model on the CPU (under 1 GB of VRAM, slow but safe).
    The old way loaded the biggest 8B at 16k on the GPU whatever the card, about 10 - 11 GB."""
    from llama_cpp import Llama

    from .lc_vision_assistant import _free as _free_chat, _llama_kwargs, _make_room, _plan_for

    _free_chat()  # an idle chat model would sit next to this one
    plan = _plan_for(requested_model or None)
    if not plan["path"]:
        raise RuntimeError(plan["why"] or (
            "No LC Vision model found. Run an LC Vision Loader once to download one, "
            "or put a Qwen-VL .gguf (with its mmproj) in models/LLM/GGUF."))
    try:
        import torch

        gpu = -1 if torch.cuda.is_available() and plan["mode"] == "gpu" else 0
    except Exception:
        gpu = 0
    if gpu:
        _make_room(plan["need_gb"])
    _CTX["ctx"] = plan["ctx"]
    print(f"[LC Vision] translator: {plan['name']} at {plan['ctx'] // 1024}k context on the "
          f"{'GPU, about ' + str(plan['need_gb']) + ' GB' if gpu else 'CPU'} ({plan['vram_gb']} GB card)")
    qwen3 = "qwen3" in (gguf_architecture(plan["path"]) or "").lower()
    return Llama(**_llama_kwargs(plan["path"], plan["ctx"], gpu)), plan["name"], qwen3


def _chunks(text: str, count) -> list[str]:
    """Split a long note so each piece and its translation fit the context, measured in the model's own tokens
    (tables and links cost far more tokens than prose). A translation can run ~1.2x the source, so a piece gets
    under half of what's left after the instructions. Blank lines first, never inside a code block; a single
    block that is still too big (a long table) splits between its lines."""
    room = max(300, int((_CTX["ctx"] - 600) / 2.3))
    if count(text) <= room:
        return [text]
    out, cur, fence = [], "", False
    pieces = []
    for para in re.split(r"(\n\s*\n)", text):
        if para.count("```") % 2:
            fence = not fence
        if not fence and para.strip() and count(para) > room:  # a block too big on its own: by lines
            pieces += [ln + "\n" for ln in para.split("\n")]
        else:
            pieces.append(para)
    for para in pieces:
        if cur.strip() and count(cur + para) > room and not fence:
            out.append(cur)
            cur = ""
        cur += para
    if cur.strip():
        out.append(cur)
    return out


def _free(llm):
    del llm
    gc.collect()
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


def _spelling(text: str, requested_model: str | None, title: str | None = None):
    """Typos and spelling only: same words, same language, same markdown. Returns (text, title)."""
    llm, name, qwen3 = _llm(requested_model)
    system = (
        "You are a careful proofreader. Fix spelling mistakes and typos in the user's Markdown document, and "
        "nothing else: keep the same words, wording, tone, language and Markdown structure (headings, lists, "
        "tables, bold, italics, line breaks, emoji). Copy every placeholder like ⟦3⟧ exactly as it is. Do not "
        "change ComfyUI node names, setting names, file names, model names or numbers. Do not add or remove "
        "anything. Output only the corrected Markdown." + (" /no_think" if qwen3 else "")
    )
    try:
        out = _run(llm, system, text, "the same language", name, "spelling")
        out_title = None
        if title and title.strip():
            try:
                out_title = _run(llm, system, title.strip(), "the same language", name, "title spelling").splitlines()[0].strip() or None
            except Exception:
                out_title = None
        return out, out_title
    finally:
        _free(llm)


# the user's own workflow-note conventions (their writing style profile)
_NOTE_STYLE = (
    "Write it the way this author writes workflow notes:\n"
    "- Start with a heading line: '### 🛑🚫✋ Read this first' and two or three short bullets on what to set up before the first run.\n"
    "- Then each part of the workflow as a bold name line (e.g. **Load the models**) followed by flat bullets: what it does and what to change. No nested bullets.\n"
    "- Bold the key node names and settings inside bullets. Short, plain sentences. Explain why, not just what.\n"
    "- Model files: name each file and its folder. Show folders as a small tree in a code block, like:\n"
    "  ```\n  ComfyUI/\n  └── models/\n      └── loras/\n  ```\n"
    "- Use 💡 only for a tip and ⚠️ for a warning. Never use the em dash character; use a period, comma or colon.\n"
    "- No closing summary sentence: the note ends on its last part, followed by ---.\n"
    "- Only describe what is in the workflow description. Never invent nodes, models, links or settings.\n"
    "- Put a model file in a folder only when the description gives its folder. Never guess a folder."
)


def _tidy_note(md: str) -> str:
    """House rules the model doesn't always keep: no em dash, flat bullets, one closing rule."""
    md = re.sub(r"\s*—\s*", ": ", md)
    md = re.sub(r"(?m)^[ \t]+([-*] )", r"- ", md)  # nested bullets -> flat
    md = re.sub(r"(?:\n---\s*){2,}$", "\n---", md.rstrip())
    return md.strip()


def _write_note(workflow: str, requested_model: str | None):
    llm, name, qwen3 = _llm(requested_model)
    system = ("You write the setup note that ships inside a ComfyUI workflow, in English Markdown, for people who just "
              "downloaded the workflow. " + _NOTE_STYLE + (" /no_think" if qwen3 else ""))
    try:
        r = llm.create_chat_completion(
            messages=[{"role": "system", "content": system},
                      {"role": "user", "content": "The workflow, part by part:\n\n" + workflow[:12000]}],
            max_tokens=2500, temperature=0.4, top_p=0.9, repeat_penalty=1.05,
        )
        out = _tidy_note(_clean((r["choices"][0]["message"].get("content") or "").strip()))
        if not out:
            raise RuntimeError("The model returned nothing. Try again.")
        print(f"[LC Vision] wrote a workflow note with {name}")
        return out
    finally:
        _free(llm)


def _translate(text: str, target: str, requested_model: str | None, title: str | None = None):
    """Returns (text, title). The title is best effort: None if it could not be translated."""
    llm, name, qwen3 = _llm(requested_model)
    try:
        return _translate_with(llm, name, qwen3, text, target, title)
    finally:
        _free(llm)


def _translate_many(items: list, target: str, requested_model: str | None):
    """Several texts (a guided tour's steps and setting notes) with one model load: [{text, title?}] ->
    [{text, title, warning?}]. An item that fails keeps its original text and says so."""
    llm, name, qwen3 = _llm(requested_model)
    out = []
    try:
        for it in items:
            text, title = str(it.get("text") or ""), str(it.get("title") or "")
            if not text.strip() and not title.strip():
                out.append({"text": text, "title": title})
                continue
            before = len(_WARN)
            try:
                if text.strip():
                    t_text, t_title = _translate_with(llm, name, qwen3, text, target, title)
                else:  # a title alone
                    t_text, t_title = "", _translate_with(llm, name, qwen3, title, target, None)[0].splitlines()[0].strip()
                row = {"text": t_text, "title": t_title or title}
            except Exception as e:
                row = {"text": text, "title": title, "warning": f"kept in the original: {e}"}
            if len(_WARN) > before:
                row["warning"] = "; ".join(_WARN[before:])
            out.append(row)
        return out
    finally:
        _free(llm)


def _translate_with(llm, name, qwen3, text: str, target: str, title: str | None = None):
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
    parts = _chunks(text, lambda s: len(llm.tokenize(s.encode("utf-8"), add_bos=False)))  # a long note on a small card goes through in pieces
    if len(parts) == 1:
        out = _run(llm, system, text, target, name, "text")
    else:
        done = []
        for k, p in enumerate(parts):
            try:
                done.append(_run(llm, system, p, target, name, f"text (part {k + 1} of {len(parts)})").strip())
            except RuntimeError:  # one stubborn piece stays in the original rather than losing the whole note
                done.append(p.strip())
                _WARN.append(f"part {k + 1} of {len(parts)} kept in the original language")
        out = "\n\n".join(done)
    out_title = None
    if title and title.strip():
        try:
            out_title = _run(llm, title_system, title.strip(), target, name, "title").splitlines()[0].strip() or None
        except Exception as e:
            print(f"[LC Vision] title not translated ({e}); the note shows the original title twice")
    return out, out_title


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
        plan = {}
        if models:  # what a translation would load on this card: "cpu" = small card, slow (the pages warn first)
            try:
                from .lc_vision_assistant import _plan_for

                p = _plan_for(None)
                plan = {"mode": p["mode"], "name": p["name"], "vram_gb": p["vram_gb"], "need_gb": p["need_gb"]}
            except Exception:
                plan = {}
        return web.json_response({"available": ok and bool(models), "models": models, "default": default, "plan": plan})

    @PromptServer.instance.routes.post("/lc_vision/translate")
    async def _translate_route(request):
        import asyncio

        data = await request.json()
        text, target = data.get("text") or "", data.get("target") or ""
        if isinstance(data.get("items"), list) and target:  # a batch (a guided tour): one model load for all of it
            if not _LOCK.acquire(blocking=False):
                return web.json_response({"error": "Another translation is still running."}, status=409)
            _WARN.clear()
            try:
                rows = await asyncio.get_running_loop().run_in_executor(None, _translate_many, data["items"][:200], target, data.get("model"))
                return web.json_response({"items": rows})
            except Exception as e:
                return web.json_response({"error": str(e)}, status=500)
            finally:
                _LOCK.release()
        if not text.strip() or not target:
            return web.json_response({"error": "Nothing to translate."}, status=400)
        if not _LOCK.acquire(blocking=False):
            return web.json_response({"error": "Another translation is still running."}, status=409)
        _WARN.clear()
        try:
            if data.get("task") == "spelling":
                out, title = await asyncio.get_running_loop().run_in_executor(None, _spelling, text, data.get("model"), data.get("title"))
            else:
                out, title = await asyncio.get_running_loop().run_in_executor(
                    None, _translate, text, target, data.get("model"), data.get("title")
                )
            return web.json_response({"text": out, "title": title, **({"warning": "; ".join(_WARN)} if _WARN else {})})
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)
        finally:
            _LOCK.release()
    @PromptServer.instance.routes.post("/lc_vision/write_note")
    async def _write_note_route(request):
        import asyncio

        data = await request.json()
        wf = data.get("workflow") or ""
        if not wf.strip():
            return web.json_response({"error": "This workflow has nothing to describe yet."}, status=400)
        if not _LOCK.acquire(blocking=False):
            return web.json_response({"error": "LC Vision is busy with another note. Try again in a moment."}, status=409)
        try:
            out = await asyncio.get_running_loop().run_in_executor(None, _write_note, wf, data.get("model"))
            return web.json_response({"text": out})
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)
        finally:
            _LOCK.release()
except Exception as e:  # pragma: no cover - only when imported outside ComfyUI
    print(f"[LC Vision] translate routes not registered: {e}")

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
