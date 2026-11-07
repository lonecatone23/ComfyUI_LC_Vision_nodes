"""✨ Write boxes for LC Bounding Boxes (LC123): a vision model finds the subjects in the picture (or plans them from an
idea on an empty canvas) and writes a box, name, type, description and palette for each, plus a scene caption. The
editor calls the route, puts the boxes in place to edit, and the model unloads again. No node: nothing to wire."""
from __future__ import annotations

import gc
import json
import os
import re
import threading

from .lc_vision_loader import LCVisionBuildParams, _discover_vision_models, build_llama

_LOCK = threading.Lock()
MIN_SIDE = 20  # on the 0-1000 grid: a box thinner than 2% of the picture is noise (and MOSS misses tiny boxes)
SIGN = re.compile(r"\b(sign|signs|neon|title|banner|poster|logo|label|lettering|text|caption|headline|billboard|plaque)\b", re.I)

SCHEMA = {
    "type": "object",
    "properties": {
        "scene": {"type": "string"},
        "boxes": {"type": "array", "items": {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "type": {"type": "string", "enum": ["character", "object", "text"]},
                "bbox": {"type": "array", "items": {"type": "integer"}, "minItems": 4, "maxItems": 4},
                "desc": {"type": "string"},
                "text": {"type": "string"},
                "palette": {"type": "array", "items": {"type": "string"}},
            },
            "required": ["name", "type", "bbox", "desc", "palette"],
        }},
    },
    "required": ["scene", "boxes"],
}

RULES = (
    "Box coordinates are [x1, y1, x2, y2] on a 0-1000 grid of the whole frame: 0,0 is the top left corner, 1000,1000 "
    "the bottom right. Each box holds the whole visible subject, head to the lowest visible part.\n"
    "type: character for every person, animal or creature (one box each); object for a thing that matters to the "
    "picture (a prop, a vehicle); text for words written in the picture (signs, titles, labels): put the exact words "
    "in text and the lettering style in desc.\n"
    "Box only subjects, props and text. The setting (room, window, wall, sky, sea, ground, street) is never a box: it "
    "goes in scene.\n"
    "name: a plain noun (woman, man, cat, sign).\n"
    "desc: that subject alone, in vivid concrete detail: face, hair, skin tone, body, clothing and its colours, pose "
    "and expression (for an object: material, shape, colour). One or two sentences. No setting, no other subjects, no "
    "position words.\n"
    "palette: the subject's two or three main colours as colour names.\n"
    "scene: the setting, light, mood and style in two or three sentences, WITHOUT the boxed subjects and without "
    "left / right / centre words.\n"
    "Answer with the JSON only.")


def models() -> dict:
    found = _discover_vision_models()
    names = sorted(found)
    # Qwen3-VL first (its native grounding grid is this 0-1000 grid; tested best on boxes), then Qwen3.5, 8-9B, Q8
    score = lambda n: (("vl" in n.lower()) * 4 + ("3.5" in n) * 2 + ("8b" in n.lower() or "9b" in n.lower()) * 2
                       + ("q8" in n.lower()) - ("32b" in n.lower()) * 9)
    return {"models": names, "default": max(names, key=score) if names else ""}


def _not_while_rendering() -> None:
    try:
        from server import PromptServer

        running, _ = PromptServer.instance.prompt_queue.get_current_queue()
    except Exception:
        return
    if running:
        raise ValueError("A render is running. Try again when it's done (loading the model now would push the image "
                         "model out of VRAM mid-render).")


def _make_room(path: str) -> None:
    try:
        import torch

        if not torch.cuda.is_available():
            return
        need = (os.path.getsize(path) / 1024 ** 3) + 2.0
        if torch.cuda.mem_get_info()[0] / 1024 ** 3 < need:
            import comfy.model_management as mm

            mm.unload_all_models()
            mm.soft_empty_cache()
    except Exception as exc:
        print(f"[LC Vision] Boxes: could not make room in VRAM ({exc}).")


def _ask(llm, picture: str, idea: str, width: int, height: int, retry: str = "") -> str:
    if picture:
        task = ("Find the subjects in this picture and write a box for each one." +
                (f"\nThe user's note (follow it: what to box, what to add or change): {idea}" if idea else ""))
        content = [{"type": "image_url", "image_url": {"url": picture}}, {"type": "text", "text": task + retry}]
    else:
        task = (f"Plan a picture of {width}x{height} pixels for this idea: {idea}\nPlace each subject where it makes a "
                "good composition, at a believable size, people not stacked on top of each other.")
        content = task + retry
    r = llm.create_chat_completion(
        messages=[{"role": "system", "content": "You write image layouts.\n" + RULES}, {"role": "user", "content": content}],
        max_tokens=2048, temperature=0.2, top_p=0.9, repeat_penalty=1.05,
        response_format={"type": "json_object", "schema": SCHEMA})
    return (r["choices"][0]["message"].get("content") or "").strip()


def _iou(a, b) -> float:
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union else 0.0


def _clean(raw: dict) -> tuple[str, list, list]:
    """(scene, editor boxes, problems): boxes kept inside the frame, tiny / empty-text / duplicate ones left out,
    left to right."""
    s = lambda v: re.sub(r"\s+", " ", str(v or "")).strip()
    out, problems, kept = [], [], []
    for n, b in enumerate(raw.get("boxes") or []):
        if not isinstance(b, dict):
            continue
        try:
            x1, y1, x2, y2 = (max(0, min(1000, int(v))) for v in b.get("bbox"))
        except Exception:
            problems.append(f"box {n + 1} has no usable coordinates")
            continue
        x1, x2 = sorted((x1, x2))
        y1, y2 = sorted((y1, y2))
        if x2 - x1 < MIN_SIDE or y2 - y1 < MIN_SIDE:
            problems.append(f"box {n + 1} is too small")
            continue
        kind = b.get("type") if b.get("type") in ("character", "object", "text") else "object"
        text = s(b.get("text"))
        quoted = re.search(r"['\"“‘]([^'\"”’]{2,80})['\"”’]", s(b.get("desc")))
        if kind == "object" and quoted and SIGN.search(s(b.get("name"))):
            kind, text = "text", text or quoted.group(1)  # a sign with its words quoted: MOSS writes text boxes exactly
        if kind == "text" and not text:
            problems.append(f"text box {n + 1} has no words")
            continue
        box = (x1, y1, x2, y2)
        if any(_iou(box, k) > 0.85 for k in kept):
            continue  # the same subject twice
        kept.append(box)
        pal = [s(p) for p in (b.get("palette") or []) if s(p)][:4]
        out.append({"x": x1 / 1000, "y": y1 / 1000, "w": (x2 - x1) / 1000, "h": (y2 - y1) / 1000,
                    "name": (s(b.get("name")) or kind).lower()[:40], "kind": "new",
                    "type": {"object": "obj"}.get(kind, kind), "desc": s(b.get("desc")),
                    "text": text if kind == "text" else "", "palette": ", ".join(pal), "to": None})
    out.sort(key=lambda b: (b["x"], b["y"]))
    return s(raw.get("scene")), out, problems


def _parse(text: str) -> dict:
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S).strip()
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        raise ValueError("no JSON in the answer")
    data = json.loads(m.group(0))
    if not isinstance(data, dict):
        raise ValueError("the answer is not a JSON object")
    return data


def write_boxes(model: str, idea: str = "", picture: str = "", width: int = 1024, height: int = 1024) -> dict:
    idea = str(idea or "").strip()[:2000]
    if not picture and not idea:
        raise ValueError("Write an idea first, or connect a picture.")
    if picture and not str(picture).startswith("data:image/"):
        raise ValueError("The picture did not come through.")
    found = _discover_vision_models()
    if model not in found:
        model = models()["default"]
    if not model:
        raise ValueError("No LC Vision model on disk (models/LLM, model + mmproj). Load one with LC Vision Loader first.")
    path, mmproj = found[model]
    _not_while_rendering()
    with _LOCK:
        _make_room(path)
        print(f"[LC Vision] Boxes: ✨ writing with {model}{' from the picture' if picture else ''}")
        llm, _ = build_llama(LCVisionBuildParams(
            model_path=path, mmproj_path=mmproj, device_kind="cuda", n_gpu_layers=-1, n_ctx=8192, n_batch=2048,
            image_min_tokens=256, image_max_tokens=1280, batch_max_tokens=1024, verbose=False))
        try:
            retry, best = "", None
            for attempt in range(3):
                text = _ask(llm, picture, idea, int(width), int(height), retry)
                try:
                    scene, boxes, problems = _clean(_parse(text))
                except Exception as exc:
                    print(f"[LC Vision] Boxes: unreadable answer ({exc}), asking again")
                    retry = f"\n\nYour last answer was not valid JSON ({exc}). Write the complete JSON again."
                    continue
                if boxes and (best is None or len(boxes) > len(best[1])):
                    best = (scene, boxes, problems)
                if boxes and not problems:
                    break
                why = "; ".join(problems) or "there were no boxes"
                print(f"[LC Vision] Boxes: {why}, asking again")
                retry = (f"\n\nYour last answer had problems: {why}. Write the complete JSON again with every box "
                         f"inside the 0-1000 grid, at least {MIN_SIDE} wide and tall.")
            if best is None:
                raise ValueError("The model wrote no usable boxes. Try again, or pick a bigger model.")
            scene, boxes, problems = best
            print(f"[LC Vision] Boxes: {len(boxes)} box(es) written")
            return {"scene": scene, "boxes": boxes, "notes": problems, "model": model}
        finally:
            try:
                llm.close()
            except Exception:
                pass
            del llm
            gc.collect()
            try:
                import torch

                if torch.cuda.is_available():
                    torch.cuda.empty_cache()
            except Exception:
                pass
            print("[LC Vision] Boxes: model unloaded")


try:
    import asyncio

    from aiohttp import web
    from server import PromptServer

    @PromptServer.instance.routes.get("/lc_vision/boxes/models")
    async def _models_route(request):
        return web.json_response(models())

    @PromptServer.instance.routes.post("/lc_vision/boxes/write")
    async def _write_route(request):
        try:
            b = await request.json()
            res = await asyncio.get_running_loop().run_in_executor(
                None, lambda: write_boxes(str(b.get("model", "")), b.get("idea", ""), b.get("picture", ""),
                                          int(b.get("width") or 1024), int(b.get("height") or 1024)))
            return web.json_response(res)
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=400)
except Exception:
    pass

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
