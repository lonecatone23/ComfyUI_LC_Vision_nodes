"""
LC Vision Prompt Enhancer
-------------------------
Text-only generation pass over an LC Vision model: takes a rough prompt
and a preset instruction, returns rewritten text. Uses the same
LC_VISION_MODEL handle as LC Vision Caption -- a vision-capable model is
still a perfectly good text-only LLM when nothing gets attached to the
message content.

Presets live in lc_vision_presets.json, written fresh for this pack (see
that file's own comment, and README.md's licensing note) rather than
ported from any other node's preset library -- add more there as needed.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from .lc_vision_generate import generate_with_recovery
from .lc_vision_loader import LCVisionModel, MODEL_TYPE
from .lc_vision_styles import STYLE_TAG_OPTIONS, apply_style_tag_to_text

NODE_ID = "LCVisionPromptEnhancer"
NODE_DISPLAY_NAME = "LC Vision Prompt Enhancer 📝"

PRESETS_PATH = Path(__file__).parent / "lc_vision_presets.json"
CUSTOM_PRESET_LABEL = "Custom"

# Heuristic for "the model only emitted planning/thinking text, not the
# actual rewritten prompt" -- a small independent detector, not ported
# from anywhere; the retry-once-with-a-stricter-instruction mechanism it
# feeds into is a mechanical quality guard, not creative content.
_PLANNING_LEAD_RE = re.compile(
    r"(?im)^\s*(?:[-*]\s*)?(?:\*\*)?\s*(okay[,.:]?|first[,.:]?|let me|i (?:should|need to|will|am going to))\b"
)


def _load_presets() -> dict[str, str]:
    try:
        with open(PRESETS_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        presets = data.get("presets", {})
        return {name: entry.get("system_prompt", "") for name, entry in presets.items() if entry.get("system_prompt")}
    except Exception as exc:
        print(f"[LC Vision] Failed to load lc_vision_presets.json: {exc}")
        return {}


def _looks_like_leftover_planning(text: str) -> bool:
    if not text:
        return False
    return bool(_PLANNING_LEAD_RE.search(text)) or "<think" in text.lower()


def _strip_think_tags(text: str) -> str:
    return re.sub(r"(?is)<think>.*?</think>", "", text).strip()


class LCVisionPromptEnhancer:
    @classmethod
    def INPUT_TYPES(cls):
        presets = _load_presets()
        preset_names = [CUSTOM_PRESET_LABEL] + list(presets.keys())
        return {
            "required": {
                "vision_model": (MODEL_TYPE, {"tooltip": "Handle from LC Vision Loader. Works fine text-only -- nothing image-specific is required."}),
                "prompt_text": ("STRING", {"multiline": True, "default": "", "tooltip": "The rough prompt to rewrite."}),
                "preset": (preset_names, {"tooltip": "Which system_prompt from lc_vision_presets.json to rewrite through. 'Custom' reads its system prompt from the custom_system_prompt socket instead. Add more presets by editing that file."}),
            },
            "optional": {
                "custom_system_prompt": ("STRING", {"multiline": True, "default": "", "tooltip": "Used only when preset is 'Custom' -- read directly instead of a lc_vision_presets.json entry."}),
                "style_tag": (STYLE_TAG_OPTIONS, {"default": "None", "tooltip": "Commits the rewritten prompt to a specific visual style, on top of whatever the preset already does. 'None' leaves style unconstrained."}),
                "max_tokens": ("INT", {"default": 1024, "min": 16, "max": 16384, "tooltip": "Upper limit on generated tokens. Generation can stop earlier on its own; this only caps the ceiling."}),
                "temperature": ("FLOAT", {"default": 0.7, "min": 0.0, "max": 2.0, "step": 0.05, "tooltip": "Sampling randomness. 0 = deterministic and literal, higher = more varied wording at some cost to focus."}),
                "top_p": ("FLOAT", {"default": 0.9, "min": 0.0, "max": 1.0, "step": 0.01, "tooltip": "Nucleus sampling: only sample from the smallest set of tokens covering this cumulative probability. Lower = more focused, higher = more varied."}),
                "repetition_penalty": ("FLOAT", {"default": 1.1, "min": 0.5, "max": 2.0, "step": 0.01, "tooltip": "Penalizes tokens the model has already used, to discourage repetitive or looping output. 1.0 = no penalty."}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 2**32 - 1, "tooltip": "Sampling seed. Same seed + same inputs should reproduce the same output, modulo hardware/threading nondeterminism."}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "run"
    CATEGORY = "LC Vision"
    DESCRIPTION = "Rewrites a prompt through an LC Vision model using a preset instruction. Text-only -- no image/video input."

    def _generate(self, vision_model: LCVisionModel, system_prompt: str, user_text: str, max_tokens, temperature, top_p, repetition_penalty, seed) -> str:
        effective_user = user_text
        if getattr(vision_model, "is_qwen3_family", False):
            effective_user = "/no_think\n" + user_text

        response = generate_with_recovery(
            vision_model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": effective_user},
            ],
            max_tokens=max_tokens,
            temperature=temperature,
            top_p=top_p,
            repeat_penalty=repetition_penalty,
            seed=seed,
        )
        if not response or "choices" not in response or not response["choices"]:
            raise RuntimeError("[LC Vision] Model returned an empty response.")
        return _strip_think_tags((response["choices"][0].get("message", {}).get("content", "") or "").strip())

    def run(
        self,
        vision_model: LCVisionModel,
        prompt_text: str,
        preset: str,
        custom_system_prompt: str = "",
        style_tag: str = "None",
        max_tokens: int = 1024,
        temperature: float = 0.7,
        top_p: float = 0.9,
        repetition_penalty: float = 1.1,
        seed: int = 0,
    ) -> tuple[str]:
        if vision_model is None or getattr(vision_model, "llm", None) is None:
            raise ValueError("[LC Vision] Prompt Enhancer received no model -- connect an LC Vision Loader.")

        if preset == CUSTOM_PRESET_LABEL:
            system_prompt = custom_system_prompt.strip()
            if not system_prompt:
                raise ValueError("[LC Vision] preset is 'Custom' but custom_system_prompt is empty -- provide a system prompt or pick a preset.")
        else:
            presets = _load_presets()
            system_prompt = presets.get(preset)
            if not system_prompt:
                raise ValueError(f"[LC Vision] Preset '{preset}' not found in lc_vision_presets.json.")

        user_text = prompt_text.strip() or "Describe a scene vividly."
        user_text = apply_style_tag_to_text(user_text, style_tag)
        result = self._generate(vision_model, system_prompt, user_text, max_tokens, temperature, top_p, repetition_penalty, seed)

        if _looks_like_leftover_planning(result):
            # One constrained retry, same pattern used elsewhere in this space: ask
            # explicitly for just the final text rather than silently returning
            # planning output to the user.
            retry_system = (
                "Output only the final rewritten prompt as one paragraph. No analysis, "
                "no planning steps, no first-person narration, no <think>, no bullet points."
            )
            retry_user = f"Rewrite the following into just the final prompt text:\n\n{result}"
            retried = self._generate(vision_model, retry_system, retry_user, max_tokens, 0.4, 0.95, 1.05, seed + 1)
            if retried and not _looks_like_leftover_planning(retried):
                result = retried

        return (result,)


NODE_CLASS_MAPPINGS = {
    NODE_ID: LCVisionPromptEnhancer,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_ID: NODE_DISPLAY_NAME,
}
