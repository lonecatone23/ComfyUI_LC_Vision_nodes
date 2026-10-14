"""
Vision Assistant chat (server routes, no node)
----------------------------------------------
Backs the Chat tab of the Vision Assistant sidebar. The page sends a short summary of the open workflow
(nodes, settings, checkup findings) with every message; an LC Vision GGUF model answers in plain words and
may propose actions as JSON. The page shows each proposal and only does it after the user says yes.

  GET  /lc_vision/assistant/status  -> {"available", "models", "default", "loaded", "why"}
  POST /lc_vision/assistant/chat    {"messages", "context", "model"?} -> {"reply", "actions"} | {"error"}
  POST /lc_vision/assistant/unload  -> {"ok"}

The model stays loaded between messages (a chat is many short turns) and is unloaded after a few idle
minutes, when the page asks (a run was queued), or when another model is picked.
"""

from __future__ import annotations

import gc
import json
import os
import re
import threading
import time

from .lc_vision_loader import _discover_vision_models, gguf_architecture, strip_thinking

IDLE_UNLOAD = 60  # seconds: the chat model gives its VRAM back a minute after the last answer
_LOCK = threading.Lock()
_STATE = {"llm": None, "name": None, "qwen3": False, "used": 0.0, "timer": None}

SYSTEM = """You are Vision Assistant, a helper inside ComfyUI made by Lonecat. You help with the workflow that is open right now.

How to answer:
- Short, plain words. A beginner should understand you. No jargon unless the user used it first.
- Only talk about nodes, settings and files that are in the WORKFLOW section. Never invent a node id, setting or file.
- A setting's allowed values are listed after "options:". Pick only from those.
- If the CHECKUP section lists problems and the user asks what's wrong, explain those first.
- If there is a SYMPTOM CHECK section (the user described a problem like a blurry or black picture), answer from it:
  name the SUSPECT settings and what to change, using the values given. A part that is switched off (like bypassed
  detailers) is not the cause of a blurry or black picture unless the SYMPTOM CHECK marks it SUSPECT. If nothing is
  marked SUSPECT, say the usual settings look right and ask what the picture looks like (or to share it). The words
  SUSPECT and ok are labels for you: never write them in the answer.
- If you are not sure, say so and ask a short question.
- Keep it short: explaining a whole workflow takes about 200 words. Go longer only when asked.
- Nodes and groups marked [bypassed], [muted] or "all off" ARE in the workflow, just turned off. Say "it's in
  the workflow but turned off (G31)" and offer to turn it on. Never say a turned-off node is missing.
- "This", "this node", "these" mean the SELECTED nodes. To explain one, use its "what it does" text and the
  setting tips: what it does, which settings matter most and what they change, in plain words. If nothing is
  selected, ask the user to click the node first.
- About the workflow's author: use the WORKFLOW NOTES (name, links, what they wrote) and what the workflow itself
  shows (how it is built, how much it explains). Never invent facts about a person: jobs, credits, other projects.
  The author did not make ComfyUI itself.
- When the user asks about the author, always list every link in AUTHOR LINKS FOUND IN THE NOTES (Ko-fi, Patreon,
  Instagram, CivitAI, etc.), each on its own line with its site name, so the user can support or follow them.
- Vision Assistant (you) is made by Lonecat. That does NOT make Lonecat the author of the open workflow. If the
  notes don't name the author, say the workflow doesn't say who made it. Never guess an author from node names,
  pack names or file names ("likely rgthree" is a guess). If a note links the author's own guide or page ("my
  guide is here: ..."), share that link and say it's the author's. Packs it uses (from their GitHub pages)
  were made by those packs' authors, not necessarily the workflow's author.
- Light Markdown is fine: short headings, bullet lists, **bold**.

Changing the workflow:
- You never change anything yourself. To propose changes, end your answer with one block like this:
```actions
[{"do": "set", "node": 12, "widget": "steps", "value": 30}]
```
- Allowed actions:
  {"do": "set", "node": <id>, "widget": "<name>", "value": <value>}
  {"do": "mode", "node": <id>, "mode": "on" | "bypass" | "mute"}
  {"do": "group", "group": "G2", "mode": "on" | "bypass" | "mute"}
  {"do": "snapshot", "name": "<snapshot name>"}
  {"do": "highlight", "nodes": [<id>, ...]}  or  {"do": "highlight", "group": "G3"}
  {"do": "fix", "card": <checkup number>, "option": <option number, usually 0>}
  {"do": "queue"}
  {"do": "suggest", "text": "<a short follow-up the user might ask next>"}
- The user sees each action and says yes or no. Say in your text what the block will do.
- To turn a whole part of the workflow on or off, use its group (each node line says which group it is in).
- To switch a model or LoRA file, pick from the "matching files" listed for that setting. If none are listed, ask for the file name.
- When the user asks where something is ("where do I put the image?", "where are the detailers?"), answer in one
  or two sentences and add a highlight action for those nodes or that group. It makes them glow on screen and
  changes nothing, so it happens without asking. Never use highlight together with set, mode, group or fix.
- "Where do I put the image / my picture?" means: which node loads it. Point at the Load Image node(s) and say
  "click it and choose your picture, or drag the picture onto it".
- "Can you fix it?": use fix actions for the CHECKUP items that have a one-click fix. For the ones marked
  "no fix I can do", say plainly what the user has to install or download, and where (the pack page or a search).
  Never pretend something is fixed. A fix that "adds a stand-in node" only places a replacement node; it installs
  nothing, and the user still has to wire it up.
- Links: only give links that appear in the WORKFLOW, NOTES or CHECKUP sections. Never make up a URL. When you
  have no link, tell the user to search Hugging Face or CivitAI for the file name.
- "is in a subfolder" means the file is already there; the node just needs its full name. Nothing has to move.
- Quick replies: end most answers with 2 or 3 suggest items: what the user would most likely ask next about
  THIS workflow, written the way they would say it, under 6 words each, built from its real node, group and
  setting names (never generic ones it doesn't have). Only suggest things you can actually answer or do. They
  show as buttons, so never write a "Quick replies", "Next steps" or follow-up list in your text.
- The CHECKUP numbers are for you: say what the problem is, never "CHECKUP #2".
- Only propose "queue" when the user asks to run or generate.
- No block when nothing needs to change."""


# ---------------------------------------------------------------- which model, how much context, for this card
# Measured 2026-10-12 with the V26 workflow summary, flash attention on and the conversation cache at 8 bits (no
# quality loss in the tests; the 4-bit cache did lose some):
#   RTX 5060 Laptop 8 GB: 4B Q4_K_M 8k = 3.4 GB (3.9 s an answer), 16k = 4.0 GB | 4B Q8_0 8k = 5.2 GB
#   RTX 5090: 8B Q5_K_M 8k = 6.8 GB | 8B Q8_0 16k = 9.9 GB (11.7 GB with flash attention off and a 16-bit cache)
# so VRAM is about the file size + 0.08 GB per 1k tokens of context + 0.7 GB (CUDA and working memory).
# CPU chat (no layers on the card, the GPU only helps read the prompt): 4B Q4_K_M 4k = 0.8 GB VRAM, 11 s an answer
# on a Core Ultra 9 laptop, ~13 s on the desktop. Pure CPU (no GPU at all) 17 - 31 s.
KV_GB_PER_1K = 0.08
OVERHEAD_GB = 0.7
SHARE = 0.5  # the chat may use this share of the card at most (it unloads when you queue)
CAP_GB = 11.0
CPU_CTX = 4096


def _vram_gb():
    fake = os.environ.get("LC_VISION_CHAT_VRAM_GB")  # testing aid: plan as if the card had this much VRAM
    if fake:
        try:
            return float(fake)
        except ValueError:
            pass
    try:
        import torch

        if torch.cuda.is_available():
            return torch.cuda.get_device_properties(0).total_memory / 1024 ** 3
    except Exception:
        pass
    return 0.0


def _need_gb(path, ctx):
    try:
        size = os.path.getsize(path) / 1024 ** 3
    except OSError:
        size = 8.0
    return size + KV_GB_PER_1K * ctx / 1024 + OVERHEAD_GB


def _plan(requested=None):
    """{name, path, ctx, need_gb, vram_gb, tours, lite, why}: what the chat loads on this card.
    requested: None / "auto" = pick for the card, "off" = no chat, or a model name from the list."""
    vram = _vram_gb()
    models = _discover_vision_models()
    plan = {"name": None, "path": None, "ctx": 0, "need_gb": 0.0, "vram_gb": round(vram, 1), "tours": False, "lite": True, "mode": "gpu", "why": ""}
    if requested == "off":
        plan["why"] = "The chat is turned off (LC Settings > Vision > Chat model). The checkup, snapshots and saved tours still work."
        return plan
    if not models:
        plan["why"] = "No LC Vision model yet. LC Settings > Vision downloads one."
        return plan
    budget = min(vram * SHARE, CAP_GB) if vram else 6.0
    ctxs = [16384, 8192, 4096] if vram >= 20 else [8192, 4096]
    if requested and requested in models:  # the user's own pick: the largest context that still fits
        path = models[requested][0]
        ctx = next((c for c in ctxs if _need_gb(path, c) <= max(budget, vram * 0.7)), 4096)
        plan.update(name=requested, path=path, ctx=ctx, need_gb=round(_need_gb(path, ctx), 1), lite=False)
    else:
        # the biggest model on disk that fits the budget. Never f16 or 32B, and not Qwen3.5: it reasons before every
        # answer, about ten times slower in chat (it can still be picked by hand)
        cands = [(n, v[0]) for n, v in models.items() if not re.search(r"f16|bf16|f32|32b|qwen3\.5", n, re.I)] or list((n, v[0]) for n, v in models.items())
        cands.sort(key=lambda x: -os.path.getsize(x[1]) if os.path.exists(x[1]) else 0)
        for ctx in ctxs:
            hit = next(((n, p) for n, p in cands if _need_gb(p, ctx) <= budget), None)
            if hit:
                plan.update(name=hit[0], path=hit[1], ctx=ctx, need_gb=round(_need_gb(hit[1], ctx), 1), lite=False)
                break
        if plan["lite"]:
            # nothing fits on the card: chat on the CPU with the smallest model (the GPU only helps read the prompt)
            small = min(cands, key=lambda x: os.path.getsize(x[1]) if os.path.exists(x[1]) else 1e12)
            plan.update(name=small[0], path=small[1], ctx=CPU_CTX, need_gb=1.0 if vram else 0.0, mode="cpu", lite=False)
            plan["why"] = (f"CPU chat: this {vram:.0f} GB card is too small to hold a chat model next to your image model, so it "
                           "runs on the CPU (about 10 to 30 seconds an answer, under 1 GB of VRAM). LC Settings > Vision > Chat model "
                           "can turn it Off.")
            return plan
    plan["tours"] = plan["ctx"] >= 16384 and plan["mode"] == "gpu"  # building a tour needs a long reply
    return plan


def _free():
    llm = _STATE["llm"]
    _STATE.update(llm=None, name=None)
    if llm is not None:
        del llm
        gc.collect()
        try:
            import torch

            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass
        print("[Vision Assistant] chat model unloaded")


def _idle_check():
    with _LOCK:
        if _STATE["llm"] is not None and time.time() - _STATE["used"] >= IDLE_UNLOAD - 1:
            _free()


def _arm_timer():
    t = _STATE["timer"]
    if t:
        t.cancel()
    t = threading.Timer(IDLE_UNLOAD, _idle_check)
    t.daemon = True
    t.start()
    _STATE["timer"] = t


def _llama_kwargs(path, ctx, gpu_layers):
    """Flash attention on and the conversation cache at 8 bits: ~0.3 - 1.9 GB less VRAM, same answers (measured).
    Older llama-cpp-python builds without those options just get the plain load."""
    import inspect

    from llama_cpp import Llama

    params = inspect.signature(Llama.__init__).parameters
    kw = dict(model_path=path, n_ctx=ctx, n_gpu_layers=gpu_layers, verbose=False)
    if "flash_attn_type" in params:
        kw["flash_attn_type"] = 1
    elif "flash_attn" in params:
        kw["flash_attn"] = True
    if "type_k" in params and "type_v" in params:
        kw["type_k"] = kw["type_v"] = 8  # GGML_TYPE_Q8_0
    return kw


def _make_room(need_gb):
    """If ComfyUI still holds an image model, ask it to make room (you're chatting, not rendering)."""
    try:
        import torch

        if not torch.cuda.is_available():
            return
        free = torch.cuda.mem_get_info()[0] / 1024 ** 3
        if free < need_gb + 0.5:
            import comfy.model_management as mm

            mm.free_memory((need_gb + 0.5) * 1024 ** 3, mm.get_torch_device())
            mm.soft_empty_cache()
    except Exception as e:
        print(f"[Vision Assistant] couldn't make room in VRAM: {e}")


def _load(requested):
    plan = _plan(requested)
    name, path, ctx = plan["name"], plan["path"], plan["ctx"]
    if not path:
        raise RuntimeError(plan["why"] or "No LC Vision model found.")
    if _STATE["llm"] is not None and _STATE["name"] == name and _STATE.get("ctx") == ctx and _STATE.get("mode") == plan["mode"]:
        return _STATE["llm"]
    _free()
    _make_room(plan["need_gb"])
    from llama_cpp import Llama

    try:
        import torch

        gpu = -1 if torch.cuda.is_available() else 0
    except Exception:
        gpu = 0
    print(f"[Vision Assistant] loading {name} for chat")
    _STATE["llm"] = Llama(**_llama_kwargs(path, ctx, gpu if plan["mode"] == "gpu" else 0))
    _STATE["name"] = name
    _STATE["ctx"] = ctx
    _STATE["mode"] = plan["mode"]
    # plain Qwen3 and Qwen3.5 think unless told not to; Qwen3-VL instruct doesn't think and would echo the switch
    _STATE["qwen3"] = (gguf_architecture(path) or "").lower() in ("qwen3", "qwen35", "qwen35moe")
    return _STATE["llm"]


_BLOCK = re.compile(r"```(?:actions|json)?\s*([\[{].*?[\]}])\s*```", re.S)


def _parse(body: str) -> list:
    """A list of actions, a single action, or one action per line: all are fine."""
    try:
        parsed = json.loads(body)
        parsed = parsed if isinstance(parsed, list) else [parsed]
    except Exception:
        parsed = []
        for line in body.splitlines():
            try:
                parsed.append(json.loads(line.strip().rstrip(",")))
            except Exception:
                pass
    return [a for a in parsed if isinstance(a, dict) and a.get("do")]


def _split(out: str):
    """Reply text and the proposed actions (a list, possibly empty)."""
    out = strip_thinking(out)
    out = re.sub(r"\s*/no_think\b", "", out).strip()
    actions = []
    for m in _BLOCK.finditer(out):
        actions += _parse(m.group(1))
    out = _BLOCK.sub("", out).strip()
    return out, actions[:12]


MAX_REPLY = 2500


def _ctx():
    return _STATE.get("ctx") or 8192


def _max_reply():
    return MAX_REPLY if _ctx() >= 16384 else 1200 if _ctx() >= 8192 else 700


def _fit(llm, context, turns, scale=1.0):
    """Trim so prompt + reply fit the model's window: oldest turns go first, then the workflow summary shrinks."""
    def count(text):
        return len(llm.tokenize(text.encode("utf-8", "ignore"), add_bos=False))

    budget = int((_ctx() - _max_reply() - 300) * scale)  # room for the chat template
    sys_tokens = count(SYSTEM)
    turn_tokens = [count(t["content"]) + 8 for t in turns]
    ctx = (context or "").strip()
    ctx_tokens = count(ctx)
    while len(turns) > 1 and sys_tokens + ctx_tokens + sum(turn_tokens) > budget:
        turns, turn_tokens = turns[1:], turn_tokens[1:]
        if turns and turns[0]["role"] == "assistant":  # keep user / assistant pairs
            turns, turn_tokens = turns[1:], turn_tokens[1:]
    room = budget - sys_tokens - sum(turn_tokens)
    if ctx_tokens > room:
        keep = max(0, int(len(ctx) * room / max(1, ctx_tokens)) - 200)
        ctx = ctx[:keep] + "\n…(the rest of the workflow summary was cut to fit)"
    return SYSTEM + "\n\n" + ctx, turns


_LONE_SURROGATE = re.compile(r"[\ud800-\udfff]")


def _clean(value):
    """Drop half-emoji left by the browser cutting a string mid-character (lone UTF-16 surrogates): Python can't
    encode them and the whole chat fails with 'surrogates not allowed'."""
    if isinstance(value, str):
        return _LONE_SURROGATE.sub("", value)
    if isinstance(value, list):
        return [_clean(v) for v in value]
    if isinstance(value, dict):
        return {k: _clean(v) for k, v in value.items()}
    return value


def _chat(messages, context, requested):
    llm = _load(requested)
    turns = [{"role": m["role"], "content": str(m.get("content", ""))[:4000]}
             for m in (messages or [])[-12:] if m.get("role") in ("user", "assistant")]
    if _STATE["qwen3"] and turns and turns[-1]["role"] == "user":
        turns[-1] = {**turns[-1], "content": turns[-1]["content"] + " /no_think"}
    r = None
    for scale in (1.0, 0.7, 0.45):  # token counts are an estimate: if it still overflows, trim harder and retry
        system, kept = _fit(llm, context, turns, scale)
        try:
            r = llm.create_chat_completion(
                messages=[{"role": "system", "content": system}] + kept,
                max_tokens=_max_reply(), temperature=0.3, top_p=0.9, repeat_penalty=1.05,
            )
            break
        except Exception as e:
            if "n_ctx" not in str(e) and "Context" not in str(e):
                raise
            print(f"[Vision Assistant] prompt too long at scale {scale}, trimming more")
    if r is None:
        raise RuntimeError("This conversation got too long for the model. Click Clear and ask again.")
    _STATE["used"] = time.time()
    _arm_timer()
    reply, actions = _split((r["choices"][0]["message"].get("content") or "").strip())
    if r["choices"][0].get("finish_reason") == "length":
        reply += "\n\n*(That ran long and got cut off. Say \"continue\" for the rest.)*"
    return reply, actions


TOUR_SYSTEM = """You write a guided tour of a ComfyUI workflow for someone seeing it for the first time.
You get the workflow's PARTS in order. Each part lists its nodes (with ids) and their settings.
Write exactly one step per part, in the same order (P1 first). For each step:
- parts: a list with that part's id, exactly as given (["P1"])
- title: 2 to 5 words, what this part is for ("Load your models", "Write the prompt")
- text: 2 or 3 short sentences, written like you're showing a friend around: what this part is for, and what
  they would change here and when. Don't list node names or describe the wiring. The values shown are just
  what the workflow is set to now: never tell the user to set a value unless the workflow's notes recommend it.
- settings: the 0 to 3 settings in this part a user is most likely to change (models, LoRAs, strength, steps,
  denoise, size, on/off choices, prompts). Never wiring helpers or constants. Give the node id WITHOUT the #
  ("3489") and the setting name exactly as given, and "why" in under 12 words.
Rules: use only the part ids, node ids and setting names given. Cover the whole workflow from start to finish
(inputs, generation, fixes, upscale, finishing, saving), in order. Never a step about plumbing or wiring.
No jargon unless the workflow's notes use it. Never invent features the nodes don't show. Plain text, no HTML."""

TOUR_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "steps": {"type": "array", "items": {"type": "object", "properties": {
            "parts": {"type": "array", "items": {"type": "string"}}, "title": {"type": "string"}, "text": {"type": "string"},
            "settings": {"type": "array", "items": {"type": "object", "properties": {
                "node": {"type": "string"}, "widget": {"type": "string"}, "why": {"type": "string"}},
                "required": ["node", "widget", "why"]}}},
            "required": ["parts", "title", "text", "settings"]}},
    },
    "required": ["title", "steps"],
}


def _tour(parts, context, requested):
    if not _plan(requested)["tours"]:
        raise RuntimeError("building a tour needs about 11 GB of VRAM (the 8B model with a long reply). A tour saved in the workflow still plays on any card")
    llm = _load(requested)
    ask = "PARTS:\n" + (parts or "")[:16000] + "\n\nWrite the tour as JSON."
    if _STATE["qwen3"]:
        ask += " /no_think"
    system, kept = _fit(llm, context, [{"role": "user", "content": ask}])
    # the workflow summary (notes, groups) without the chat's own rules: the tour has its own
    summary = system[len(SYSTEM):].strip()[:6000]
    r = llm.create_chat_completion(
        messages=[{"role": "system", "content": TOUR_SYSTEM + "\n\n" + summary}] + kept,
        max_tokens=8000, temperature=0.3, top_p=0.9,  # a big workflow has 30+ parts
        response_format={"type": "json_object", "schema": TOUR_SCHEMA},
    )
    _STATE["used"] = time.time()
    _arm_timer()
    text = strip_thinking(r["choices"][0]["message"].get("content") or "")
    try:
        return json.loads(text[text.index("{"):])
    except Exception:
        return _salvage(text)


def _salvage(text: str) -> dict:
    """A reply cut off mid-way: keep every step that finished."""
    title = re.search(r'"title"\s*:\s*"([^"]*)"', text)
    steps = []
    start = text.find('"steps"')
    dec = json.JSONDecoder()
    i = text.find("{", start) if start >= 0 else -1
    while i >= 0:
        try:
            obj, end = dec.raw_decode(text, i)
            if isinstance(obj, dict) and (obj.get("parts") or obj.get("part")):
                steps.append(obj)
            i = text.find("{", end)
        except ValueError:
            break
    if not steps:
        raise ValueError("no finished steps in the reply")
    return {"title": title.group(1) if title else "How this workflow works", "steps": steps}


try:
    from aiohttp import web
    from server import PromptServer

    def _free_on_queue(json_data):
        """A run was queued (from the page, the API or another tab): the chat model never sits in VRAM during a render."""
        if _STATE["llm"] is not None and _LOCK.acquire(blocking=False):
            try:
                _free()
            finally:
                _LOCK.release()
        return json_data

    if hasattr(PromptServer.instance, "add_on_prompt_handler"):
        PromptServer.instance.add_on_prompt_handler(_free_on_queue)

    async def _wait_lock(seconds=15.0):
        """The idle unload can hold the lock for a moment: wait for it instead of turning the question away."""
        import asyncio

        for _ in range(int(seconds / 0.25)):
            if _LOCK.acquire(blocking=False):
                return True
            await asyncio.sleep(0.25)
        return False

    @PromptServer.instance.routes.get("/lc_vision/assistant/status")
    async def _status(request):
        why = ""
        try:
            import llama_cpp  # noqa: F401

            ok = True
        except Exception:
            ok, why = False, "llama-cpp-python isn't installed. Reinstall LC Vision from the Manager."
        models = sorted(_discover_vision_models()) if ok else []
        if ok and not models:
            why = "No LC Vision model yet. Run an LC Vision Loader once and it downloads one."
        plan = _plan(request.query.get("model") or None) if ok else {}
        return web.json_response({"available": ok and bool(models), "models": models, "default": plan.get("name") or "",
                                  "loaded": _STATE["name"], "why": why or plan.get("why", ""), "plan": plan})

    @PromptServer.instance.routes.post("/lc_vision/assistant/chat")
    async def _chat_route(request):
        import asyncio

        data = _clean(await request.json())
        if not (data.get("messages") or []):
            return web.json_response({"error": "Nothing to answer."}, status=400)
        if not await _wait_lock():
            return web.json_response({"error": "Still answering the last message."}, status=409)
        try:
            reply, actions = await asyncio.get_running_loop().run_in_executor(
                None, _chat, data.get("messages"), data.get("context"), data.get("model"))
            return web.json_response({"reply": reply, "actions": actions, "model": _STATE["name"]})
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)
        finally:
            _LOCK.release()

    @PromptServer.instance.routes.post("/lc_vision/assistant/tour")
    async def _tour_route(request):
        import asyncio

        data = _clean(await request.json())
        if not (data.get("parts") or "").strip():
            return web.json_response({"error": "This workflow has nothing to tour."}, status=400)
        if not await _wait_lock():
            return web.json_response({"error": "Still answering the last message."}, status=409)
        try:
            tour = await asyncio.get_running_loop().run_in_executor(
                None, _tour, data.get("parts"), data.get("context"), data.get("model"))
            return web.json_response({"tour": tour, "model": _STATE["name"]})
        except Exception as e:
            return web.json_response({"error": f"The tour didn't come out right ({e}). Try again."}, status=500)
        finally:
            _LOCK.release()

    @PromptServer.instance.routes.post("/lc_vision/assistant/unload")
    async def _unload_route(_request):
        if _LOCK.acquire(blocking=False):
            try:
                _free()
            finally:
                _LOCK.release()
        return web.json_response({"ok": True})
except Exception as e:  # pragma: no cover - only when imported outside ComfyUI
    print(f"[Vision Assistant] chat routes not registered: {e}")

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
