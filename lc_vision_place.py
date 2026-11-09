"""🌐 360 from a room picture (LC H3 Story, LC_AV): a vision model reads the place picture and writes one long, concrete
description of the whole place, made for drawing a 360 panorama of it: what is in front, to the sides and behind the
camera, the ground, the sky or ceiling, materials, colours, light, weather and time of day. The Story node keeps the
text on the place card and its ✨ 360 draws from it. The model loads for the one answer and unloads. No node."""
from __future__ import annotations

import gc
import threading

from .lc_vision_boxes import _make_room, _not_while_rendering, models
from .lc_vision_loader import LCVisionBuildParams, _discover_vision_models, build_llama

_LOCK = threading.Lock()

SYSTEM = (
    "You describe places for a 360 degree panorama painter. Look at the picture and describe the place itself, as if "
    "you stood in the middle of it and turned all the way round.\n"
    "- One paragraph, 120 to 200 words, plain English, no lists, no headings.\n"
    "- Start with what kind of place it is, then what is in front, to the left and right, and what is most likely "
    "behind you (invent it so it fits the same place), then the ground, then the sky or ceiling.\n"
    "- Be concrete: materials, colours, signs and their exact words, furniture, plants, vehicles, lamps.\n"
    "- Say the light, the time of day and the weather exactly as the picture shows them (rain, snow, fog, wet "
    "ground, sun, night).\n"
    "- The place only: no people, no animals, no camera or photo words, no 'the image shows'.")


def describe_place(model: str, picture: str) -> dict:
    if not str(picture or "").startswith("data:image/"):
        raise ValueError("The room picture did not come through.")
    found = _discover_vision_models()
    if model not in found:
        model = models()["default"]
    if not model:
        raise ValueError("No LC Vision model on disk (models/LLM, model + mmproj). Load one with LC Vision Loader first.")
    path, mmproj = found[model]
    _not_while_rendering()
    with _LOCK:
        _make_room(path)
        print(f"[LC Vision] 360 from room: reading the picture with {model}")
        llm, _ = build_llama(LCVisionBuildParams(
            model_path=path, mmproj_path=mmproj, device_kind="cuda", n_gpu_layers=-1, n_ctx=8192, n_batch=2048,
            image_min_tokens=256, image_max_tokens=1280, batch_max_tokens=1024, verbose=False))
        try:
            text = ""
            for _ in range(2):
                r = llm.create_chat_completion(
                    messages=[{"role": "system", "content": SYSTEM},
                              {"role": "user", "content": [{"type": "image_url", "image_url": {"url": picture}},
                                                           {"type": "text", "text": "Describe this place for a 360 panorama."}]}],
                    max_tokens=600, temperature=0.3, top_p=0.9, repeat_penalty=1.05)
                text = " ".join(str(r["choices"][0]["message"].get("content") or "").split())
                if len(text.split()) >= 40:
                    break
            if len(text.split()) < 20:
                raise ValueError("The model wrote almost nothing about the place. Try again, or pick a bigger model.")
            print(f"[LC Vision] 360 from room: {len(text.split())} words")
            return {"text": text, "model": model}
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
            print("[LC Vision] 360 from room: model unloaded")


try:
    import asyncio

    from aiohttp import web
    from server import PromptServer

    @PromptServer.instance.routes.post("/lc_vision/place/describe")
    async def _describe_route(request):
        try:
            b = await request.json()
            res = await asyncio.get_running_loop().run_in_executor(
                None, lambda: describe_place(str(b.get("model", "")), b.get("picture", "")))
            return web.json_response(res)
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=400)
except Exception:
    pass

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
