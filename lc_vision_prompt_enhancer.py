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

from .lc_vision_caption import _image_input_to_base64_list
from .lc_vision_generate import budget_line, generate_with_recovery, release, trim_to_sentence
from .lc_vision_loader import LCVisionModel, MODEL_TYPE, strip_thinking
from .lc_vision_styles import STYLE_TAG_OPTIONS, apply_style_tag_to_text

NODE_ID = "LCVisionPromptEnhancer"
NODE_DISPLAY_NAME = "LC Vision Prompt Enhancer 📝"

PRESETS_PATH = Path(__file__).parent / "lc_vision_presets.json"
CUSTOM_PRESET_LABEL = "Custom"
# A brand-new node launches on this preset (rather than Custom, whose fresh/empty
# custom_system_prompt used to hard-error on first run), and it's what Custom
# falls back to when custom_system_prompt is empty.
FALLBACK_PRESET = "Enhance"

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
    return strip_thinking(text)


class LCVisionPromptEnhancer:
    @classmethod
    def INPUT_TYPES(cls):
        presets = _load_presets()
        preset_names = [CUSTOM_PRESET_LABEL] + list(presets.keys())
        default_preset = FALLBACK_PRESET if FALLBACK_PRESET in presets else preset_names[0]
        return {
            "required": {
                "vision_model": (MODEL_TYPE, {"tooltip": "Handle from LC Vision Loader. Works fine text-only -- nothing image-specific is required."}),
                "prompt_text": ("STRING", {"multiline": True, "default": "", "tooltip": "The rough prompt to rewrite."}),
                "preset": (preset_names, {"default": default_preset, "tooltip": "Which system_prompt from lc_vision_presets.json to rewrite through. 'Custom' reads its system prompt from the custom_system_prompt socket instead (an empty one falls back to 'Enhance'). Add more presets by editing that file."}),
            },
            "optional": {
                "custom_system_prompt": ("STRING", {"multiline": True, "default": "", "tooltip": "Used only when preset is 'Custom' -- read directly instead of a lc_vision_presets.json entry."}),
                "style_tag": (STYLE_TAG_OPTIONS, {"default": "None", "tooltip": "Commits the rewritten prompt to a specific visual style, on top of whatever the preset already does. 'None' leaves style unconstrained."}),
                "max_tokens": ("INT", {"default": 1024, "min": 16, "max": 16384, "tooltip": "Length limit. The model is told to fit its answer under it (about 0.55 words per token), and if it still runs over, the text is cut back to the last complete sentence."}),
                "temperature": ("FLOAT", {"default": 0.7, "min": 0.0, "max": 2.0, "step": 0.05, "tooltip": "Sampling randomness. 0 = deterministic and literal, higher = more varied wording at some cost to focus."}),
                "top_p": ("FLOAT", {"default": 0.9, "min": 0.0, "max": 1.0, "step": 0.01, "tooltip": "Nucleus sampling: only sample from the smallest set of tokens covering this cumulative probability. Lower = more focused, higher = more varied."}),
                "repetition_penalty": ("FLOAT", {"default": 1.1, "min": 0.5, "max": 2.0, "step": 0.01, "tooltip": "Penalizes tokens the model has already used, to discourage repetitive or looping output. 1.0 = no penalty."}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 2**32 - 1, "tooltip": "Sampling seed. Same seed + same inputs should reproduce the same output, modulo hardware/threading nondeterminism."}),
                "image_1": ("IMAGE", {"tooltip": "Optional picture the model sees while rewriting (ref_image_0). The Flux 3 edit presets need "
                                                 "it: the picture you edit."}),
                "image_2": ("IMAGE", {"tooltip": "Optional second picture (ref_image_1)."}),
                "layout": ("STRING", {"forceInput": True, "tooltip": "Optional MOSS layout (LC MOSS Layout Prompt's prompt). Plugged in, "
                                                                      "the output is that layout with the boxes kept: your prompt goes first in "
                                                                      "the scene caption, and the scene and every box are enhanced on their own."}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "run"
    CATEGORY = "LC Vision"
    DESCRIPTION = ("Rewrites a prompt through an LC Vision model using a preset instruction. Optional pictures let it see what you "
                   "are editing (the Flux 3 edit presets need them).")

    def _generate(self, vision_model: LCVisionModel, system_prompt: str, user_text: str, max_tokens, temperature, top_p, repetition_penalty, seed,
                  images=()) -> str:
        effective_user = user_text
        if getattr(vision_model, "is_qwen3_family", False):
            effective_user = "/no_think\n" + user_text
        frames = [(i, b64) for i, img in enumerate(images) if img is not None for b64 in _image_input_to_base64_list(img, 1024, 90)[:1]]
        if frames:  # the pictures first, in order, then the request (the way BFL's upsampler sees them)
            content = []
            for i, b64 in frames:
                content.append({"type": "text", "text": f"ref_image_{i}:"})
                content.append({"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}})
            content.append({"type": "text", "text": effective_user})
            effective_user = content

        response = generate_with_recovery(
            vision_model,
            messages=[
                {"role": "system", "content": system_prompt + budget_line(max_tokens)},
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
        raw = (response["choices"][0].get("message", {}).get("content", "") or "").strip()
        text = _strip_think_tags(raw)
        return trim_to_sentence(text, response)

    def run(self, *args, **kwargs):
        try:
            return self._run(*args, **kwargs)
        finally:
            release(kwargs.get("vision_model", args[0] if args else None))

    def _run(
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
        image_1=None,
        image_2=None,
        layout: str = "",
    ) -> tuple[str]:
        if vision_model is None or (getattr(vision_model, "llm", None) is None
                                    and getattr(vision_model, "build_params", None) is None):
            raise ValueError("[LC Vision] Prompt Enhancer received no model -- connect an LC Vision Loader.")

        presets = _load_presets()
        if preset == CUSTOM_PRESET_LABEL:
            system_prompt = custom_system_prompt.strip()
            if not system_prompt:
                system_prompt = presets.get(FALLBACK_PRESET)
                if not system_prompt:
                    raise ValueError(
                        f"[LC Vision] preset is 'Custom' with no custom_system_prompt, and the fallback preset "
                        f"'{FALLBACK_PRESET}' isn't in lc_vision_presets.json -- provide a system prompt, pick a preset, or restore that preset."
                    )
                print(f"[LC Vision] preset is 'Custom' but custom_system_prompt is empty -- falling back to '{FALLBACK_PRESET}'.")
        else:
            system_prompt = presets.get(preset)
            if not system_prompt:
                raise ValueError(f"[LC Vision] Preset '{preset}' not found in lc_vision_presets.json.")

        data = _parse_layout(layout)
        if data is not None:
            return (self._enhance_layout(vision_model, data, system_prompt, prompt_text, style_tag, max_tokens, temperature, top_p,
                                         repetition_penalty, seed, (image_1, image_2)),)

        user_text = prompt_text.strip() or "Describe a scene vividly."
        user_text = apply_style_tag_to_text(user_text, style_tag)
        result = self._generate(vision_model, system_prompt, user_text, max_tokens, temperature, top_p, repetition_penalty, seed,
                                images=(image_1, image_2))

        if _looks_like_leftover_planning(result) and not preset.startswith("Flux 3"):
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

    def _no_think(self, vm, system_prompt, user, tokens, temperature, top_p, repetition_penalty, seed):
        """Qwen3 / 3.5, text only: the chat template lets the model open its own reasoning, and this one can reason
        past any token cap without ever answering. Writing the turn by hand with an empty think block makes it answer
        straight away (the documented way to switch Qwen3 thinking off)."""
        from .lc_vision_generate import reset_model_state
        prompt = (f"<|im_start|>system\n{system_prompt + budget_line(tokens)}<|im_end|>\n<|im_start|>user\n{user}<|im_end|>\n"
                  "<|im_start|>assistant\n<think>\n\n</think>\n\n")
        reset_model_state(vm.llm)
        r = vm.llm.create_completion(prompt=prompt, max_tokens=tokens, temperature=temperature, top_p=top_p,
                                     repeat_penalty=repetition_penalty, seed=seed, stop=["<|im_end|>", "<|im_start|>"])
        text = _strip_think_tags((r["choices"][0].get("text") or "").strip())
        return trim_to_sentence(text, r)

    def _clean(self, vm, system_prompt, user, tokens, temperature, top_p, repetition_penalty, seed, images=(), fallback=""):
        raw_ok = getattr(vm, "is_qwen3_family", False) and getattr(vm, "llm", None) is not None and not any(i is not None for i in images)
        if raw_ok:
            out = self._no_think(vm, system_prompt, user, tokens, temperature, top_p, repetition_penalty, seed)
        else:
            out = self._generate(vm, system_prompt, user, tokens, temperature, top_p, repetition_penalty, seed, images=images)
            if not out.strip() and getattr(vm, "is_qwen3_family", False) and getattr(vm, "llm", None) is not None:
                print("[LC Vision] layout pass came back empty (reasoning ran out the cap): asking again without reasoning")
                out = self._no_think(vm, system_prompt, user, tokens, temperature, top_p, repetition_penalty, seed)
        if _looks_like_leftover_planning(out):
            out = self._generate(vm, "Output only the final text as one paragraph. No analysis, no planning, no <think>.",
                                 f"Rewrite into just the final text:\n\n{out}", tokens, 0.4, 0.95, 1.05, seed + 1)
        out = out.strip()
        if not out:  # never hand MOSS a blank caption: it drops that subject
            print("[LC Vision] layout pass still empty: keeping the original text")
            return fallback
        return out

    def _enhance_layout(self, vm, data, system_prompt, prompt_text, style_tag, max_tokens, temperature, top_p, repetition_penalty,
                        seed, images):
        """A MOSS layout, boxes kept. Rewritten as one string the boxes get lost (or the boxed subjects keep one-line
        captions next to a full paragraph). Here: the prompt in its own pass, then the scene caption, then every box
        caption on its own, and the layout goes back together unchanged."""
        gen = (temperature, top_p, repetition_penalty)
        summary, items = data["summary"], data["items"]
        main = prompt_text.strip()
        if main:  # its own pass (merged into the scene rewrite, the model dropped it), told where it stands
            setting = str(summary.get("caption", "")).strip()
            main_user = apply_style_tag_to_text(main, style_tag) + (
                f"\n\nThe picture's setting, keep it exactly (don't move the subject somewhere else): {setting}" if setting else "")
            main = self._clean(vm, system_prompt + LAYOUT_MAIN_RULES, main_user, max_tokens, *gen, seed, images, fallback=main)
        boxed = [f"- {it.get('label', 'object')}: {it.get('caption', '')}" for it in items if it.get("caption")]
        scene_user = apply_style_tag_to_text(str(summary.get("caption", "")).strip() or "A picture.", style_tag)
        if boxed:
            scene_user += "\n\nBoxed subjects (described elsewhere, do not describe):\n" + "\n".join(boxed)
        scene = self._clean(vm, system_prompt + LAYOUT_SCENE_RULES, scene_user, max_tokens, *gen, seed + 7,
                            fallback=str(summary.get("caption", "")).strip())
        summary["caption"] = f"{main} {scene}".strip() if main else scene
        for n, it in enumerate(items):
            cap = str(it.get("caption", "")).strip()
            if cap and it.get("label") != "text":  # a text box writes exactly its text: left alone
                it["caption"] = self._clean(vm, system_prompt + LAYOUT_BOX_RULES, f"The region: {cap}", min(max_tokens, 200), *gen,
                                            seed + 101 * (n + 1), fallback=cap)
        print(f"[LC Vision] Layout enhanced: scene + {len(items)} box(es), boxes kept.")
        return json.dumps(data, ensure_ascii=False, separators=(",", ":"))


LAYOUT_SCENE_RULES = (
    "\n\nYou are writing the scene caption of a picture that also has boxed regions. The boxed subjects are listed "
    "below: they are described separately, in their own boxes. Do not describe them here and do not add them; at most "
    "say where they are in passing. Describe the setting, light, colour, mood, camera and style. Output only the "
    "caption, one paragraph.")
LAYOUT_BOX_RULES = (
    "\n\nYou are describing ONE boxed region of a picture, not the whole picture. Describe only this region's own "
    "subject: appearance, face, hair, clothing, materials, texture, pose and expression, in vivid concrete detail. "
    "No setting, no background, no scene lighting, no camera or lens words, no other subjects. Keep the identity "
    "and objects the user gave, and every colour exactly as given. Output only the description, one or two sentences.")
LAYOUT_MAIN_RULES = (
    "\n\nDescribe the main subject in the setting you are given: keep that place, light and time of day, and every "
    "colour exactly as given. Do not invent a different location. Output only the description, one paragraph.")


def _parse_layout(layout):
    """The MOSS layout dict, or None (nothing plugged in / not a layout: the enhancer works as before)."""
    if not layout or not str(layout).strip().startswith("{"):
        return None
    try:
        data = json.loads(layout)
    except Exception:
        return None
    if isinstance(data, dict) and isinstance(data.get("summary"), dict) and isinstance(data.get("items"), list):
        return data
    return None


NODE_CLASS_MAPPINGS = {
    NODE_ID: LCVisionPromptEnhancer,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_ID: NODE_DISPLAY_NAME,
}
