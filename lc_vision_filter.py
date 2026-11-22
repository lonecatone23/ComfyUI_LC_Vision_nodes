"""
LC Vision Filter: sits between LC Vision Loader and Caption / Prompt Enhancer and decides what the model writes about.
"describe" = only these parts of the picture (Person, Outfit ...), "leave_out" = never these (Location, Background ...).
The model passes through unchanged; Caption and Prompt Enhancer add the filter to their instructions.
"""
from __future__ import annotations

import re

from .lc_vision_loader import MODEL_TYPE
from .lc_vision_prompt_order import POSE_RULE, in_order

NODE_ID = "LCVisionFilter"
NODE_DISPLAY_NAME = "LC Vision Filter 🧹"

PARTS = ["Camera angle", "Framing", "Lighting", "Time of day", "Location", "Background", "Props", "Weather",
         "Person", "Face", "Hair", "Body", "Outfit", "Accessories", "Expression", "Pose", "Style"]

# what each part takes in, so "Location" also drops the railing and the string lights
SCOPE = {
    "person": "the person (age, face, eyes, hair, skin, body)",
    "face": "the face (features, eyes, skin, makeup)",
    "hair": "the hair (color, length, style)",
    "body": "the body (build, height, skin)",
    "outfit": "the clothes and shoes",
    "accessories": "jewelry, glasses, bags, hats and other accessories",
    "pose": "the pose and what the body is doing",
    "expression": "the facial expression",
    "location": "the place, with everything that belongs to it (set dressing, furniture, railings, lights, signs)",
    "background": "the background (skyline, sky, the view behind)",
    "props": "objects that are held or that sit in the scene",
    "lighting": "the light (sources, direction, color, shadows)",
    "time of day": "the time of day and the sky",
    "weather": "the weather",
    "camera angle": "the camera angle and viewpoint",
    "framing": "the framing and shot size",
    "style": "the photo or art style, film look and color grade",
}


def _list(s: str) -> list[str]:
    return [p.strip() for p in re.split(r"[,\n;]+", s or "") if p.strip()]


def _scope(p: str) -> str:
    return SCOPE.get(p.lower(), p)


def filter_text(describe: str, leave_out: str) -> str:
    """The instruction added to the system prompt ('' = no filter)."""
    inc, exc = in_order(_list(describe)), _list(leave_out)
    out = []
    if inc:
        out.append("Describe only these parts of the picture: " + "; ".join(_scope(p) for p in inc) + ". Leave "
                   "everything else out completely: do not mention it, not even in passing.")
        if len(inc) > 1:
            out.append("Write them in the order listed.")  # the shared prompt order: camera, light, place, person ...
        if any(p.lower() == "pose" for p in inc):
            out.append(POSE_RULE)
    if exc:
        out.append("Never mention these parts of the picture, not even in passing: " + "; ".join(_scope(p) for p in exc)
                   + ".")
    return (" Filter: " + " ".join(out)) if out else ""


class FilteredVisionModel:
    """The Loader's model with a filter attached. Everything else (llm, load / unload state) reads and writes through
    to the Loader's own object, so unloading and reloading still work on the real model."""

    def __init__(self, model, directive: str):
        object.__setattr__(self, "_lc_base", model)
        object.__setattr__(self, "vision_filter", (getattr(model, "vision_filter", "") or "") + directive)

    def __getattr__(self, name):
        return getattr(object.__getattribute__(self, "_lc_base"), name)

    def __setattr__(self, name, value):
        if name == "vision_filter":
            object.__setattr__(self, name, value)
        else:
            setattr(object.__getattribute__(self, "_lc_base"), name, value)


def vision_filter(model) -> str:
    """The filter instruction on a model ('' when it did not come through LC Vision Filter)."""
    return getattr(model, "vision_filter", "") or ""


def filter_note(model) -> str:
    """The same filter for the end of the user message. A Caption prompt that asks for "the setting and background,
    lighting ... and mood" beat the system line alone, so the filter is said again last, as the final word."""
    f = vision_filter(model).replace(" Filter: ", "", 1).strip()
    if not f:
        return ""
    return ("\n\nFinal filter, stronger than anything asked above: " + f + " If the request above asks for other parts "
            "(the setting, background, lighting, colors, camera, mood), skip them anyway.")


class LCVisionFilter:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "vision_model": (MODEL_TYPE, {"tooltip": "From LC Vision Loader."}),
                "describe": ("STRING", {"default": "",
                                        "tooltip": "Only these parts get written (Person, Outfit ...), comma separated. "
                                                   "Pick from the 🎯 list or type your own. Empty = everything."}),
                "leave_out": ("STRING", {"default": "",
                                         "tooltip": "These parts never get written (Location, Background ...). "
                                                    "Pick from the 🚫 list or type your own."}),
            },
        }

    RETURN_TYPES = (MODEL_TYPE,)
    RETURN_NAMES = ("vision_model",)
    OUTPUT_TOOLTIPS = ("The same model with the filter on. Plug it into LC Vision Caption or LC Vision Prompt Enhancer.",)
    FUNCTION = "run"
    CATEGORY = "LC Vision"
    DESCRIPTION = ("Decides what Caption and Prompt Enhancer write about: describe only some parts of the picture "
                   "(Person, Outfit ...) or leave some out (Location, Background ...).")

    def run(self, vision_model, describe, leave_out):
        directive = filter_text(describe, leave_out)
        if not directive or vision_model is None:
            return (vision_model,)
        print("[LC Vision] Filter:" + directive.replace(" Filter:", "", 1))
        return (FilteredVisionModel(vision_model, directive),)


NODE_CLASS_MAPPINGS = {NODE_ID: LCVisionFilter}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_ID: NODE_DISPLAY_NAME}
