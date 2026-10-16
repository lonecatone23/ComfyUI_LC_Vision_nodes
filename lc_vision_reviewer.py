"""
LC Vision Reviewer
------------------
A quality gate. Asks the loaded vision model a few yes/no questions about a finished image (or video) and
passes it on, with a pass/fail flag and a short report. on_fail = block stops everything wired after it, so a
bad render never reaches the save or the upscaler.

A vision model is a shortlist, not a judge: it misses things and over-rewards texture. Flag is the default.
"""

from __future__ import annotations

import re

from .lc_vision_caption import _image_input_to_base64_list, _sample_indices
from .lc_vision_generate import generate_with_recovery, release
from .lc_vision_loader import LCVisionModel, MODEL_TYPE, strip_thinking

NODE_ID = "LCVisionReviewer"
NODE_DISPLAY_NAME = "LC Vision Reviewer 🕵️ (BETA)"

CHECKS = {
    "hands": "Are all visible hands drawn correctly (five fingers each, no extra, missing or fused fingers)? "
             "Answer yes if no hands are visible.",
    "faces": "Do all visible faces look correct (symmetrical eyes, no melted or doubled features)? "
             "Answer yes if no faces are visible.",
    "text": "Is all visible writing spelled correctly and readable? Answer yes if there is no writing.",
    "artifacts": "Is the image free of obvious AI artifacts (warped objects, extra limbs, smeared patches, "
                 "seams or tiling)?",
}
ON_FAIL = ["flag", "block"]
SYSTEM = ("You are a strict quality inspector for AI generated images. Look carefully before you answer. "
          "Answer every question with only yes or no, one numbered answer per line, nothing else.")


def _questions(hands, faces, text, artifacts, prompt, custom_checks):
    qs = [(k, CHECKS[k]) for k, on in (("hands", hands), ("faces", faces), ("text", text), ("artifacts", artifacts)) if on]
    if (prompt or "").strip():
        qs.append(("prompt", "Does the image show what this prompt asks for (the main subject, action and setting)? "
                             f"Prompt: {prompt.strip()}"))
    for line in (custom_checks or "").splitlines():
        line = line.strip().lstrip("-•* ").strip()
        if line:
            qs.append((line[:40], line if line.endswith("?") else line + "?"))
    return qs


def _answers(text, n):
    """yes/no per question, from a numbered list ("1. yes"), falling back to the yes/no words in order."""
    t = (text or "").lower()
    found = {int(m.group(1)): m.group(2) for m in re.finditer(r"(\d+)\s*[.):-]?\s*\**\s*(yes|no)\b", t)}
    if len(found) < n:
        words = re.findall(r"\b(yes|no)\b", t)
        found = {i + 1: w for i, w in enumerate(words)}
    return [found.get(i + 1) for i in range(n)]


class LCVisionReviewer:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "vision_model": (MODEL_TYPE, {"tooltip": "Handle from LC Vision Loader."}),
                "image": ("IMAGE", {"tooltip": "The finished image. A batch of more than 4 frames is read as a video: "
                                               "a few frames across the clip are checked together."}),
                "hands": ("BOOLEAN", {"default": True, "tooltip": "Fingers: extra, missing or fused."}),
                "faces": ("BOOLEAN", {"default": True, "tooltip": "Melted or doubled features, mismatched eyes."}),
                "text": ("BOOLEAN", {"default": False, "tooltip": "Signs, labels and logos spelled right."}),
                "artifacts": ("BOOLEAN", {"default": False, "tooltip": "Warped objects, extra limbs, seams, smears."}),
                "on_fail": (ON_FAIL, {"default": "flag",
                                      "tooltip": "flag: always pass the image on, just set passed to false and say why "
                                                 "in the report. block: stop every node wired after this one when a "
                                                 "check fails (the save, the upscaler, etc.)."}),
            },
            "optional": {
                "prompt": ("STRING", {"forceInput": True,
                                      "tooltip": "Wire the positive prompt here to also check the image matches it."}),
                "custom_checks": ("STRING", {"multiline": True, "default": "",
                                             "tooltip": "Your own checks, one per line, written so yes = good. "
                                                        "e.g. Is she wearing a parka?"}),
                "max_failures": ("INT", {"default": 0, "min": 0, "max": 20,
                                         "tooltip": "How many failed checks are allowed before it counts as a fail."}),
                "video_frames": ("INT", {"default": 6, "min": 1, "max": 32,
                                         "tooltip": "For a video: how many frames across the clip to look at."}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 2**32 - 1}),
            },
        }

    RETURN_TYPES = ("IMAGE", "BOOLEAN", "STRING")
    RETURN_NAMES = ("image", "passed", "report")
    FUNCTION = "run"
    CATEGORY = "LC Vision"
    OUTPUT_NODE = True
    DESCRIPTION = ("Quality gate: asks the vision model yes/no questions (hands, faces, text, artifacts, prompt match, "
                   "your own) and flags or blocks a bad render. A shortlist, not a judge: trust your eye over it.")

    def run(self, vision_model, image, *args, **kwargs):
        try:
            return self._run(vision_model, image, *args, **kwargs)
        finally:
            release(vision_model)

    def _run(self, vision_model: LCVisionModel, image, hands, faces, text, artifacts, on_fail, prompt="",
             custom_checks="", max_failures=0, video_frames=6, seed=0):
        if vision_model is None:
            raise ValueError("[LC Vision] Reviewer received no model -- connect an LC Vision Loader.")
        qs = _questions(hands, faces, text, artifacts, prompt, custom_checks)
        if not qs:
            return {"ui": {"text": ["Nothing to check: turn on a check or add your own."]},
                    "result": (image, True, "Nothing to check.")}
        frames = _image_input_to_base64_list(image, 1024, 92)
        video = len(frames) > 4
        if video:
            frames = [frames[i] for i in _sample_indices(len(frames), video_frames)]
        ask = ("These are frames from one video. " if video else "") + "Answer each question:\n" + \
              "\n".join(f"{i + 1}. {q}" for i, (_, q) in enumerate(qs))

        groups = [frames] if video else [[f] for f in frames]
        fails, lines = [], []
        for gi, group in enumerate(groups):
            content = [{"type": "text", "text": ask}] + \
                      [{"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b}"}} for b in group]
            if getattr(vision_model, "is_qwen3_family", False):
                content = [{"type": "text", "text": "/no_think"}] + content
            resp = generate_with_recovery(vision_model, messages=[{"role": "system", "content": SYSTEM},
                                                                  {"role": "user", "content": content}],
                                          max_tokens=16 + 8 * len(qs), temperature=0.0, top_p=1.0, repeat_penalty=1.0,
                                          seed=seed)
            raw = strip_thinking(((resp or {}).get("choices") or [{}])[0].get("message", {}).get("content", "") or "")
            ans = _answers(raw, len(qs))
            tag = "" if len(groups) == 1 else f"image {gi + 1}: "
            for (name, _), a in zip(qs, ans):
                ok = a == "yes"
                if not ok:
                    fails.append(f"{tag}{name}")
                lines.append(f"{'✅' if ok else ('❌' if a == 'no' else '❔')} {tag}{name}")

        passed = len(fails) <= max_failures
        head = "PASSED" if passed else "FAILED: " + ", ".join(fails)
        report = head + "\n" + "\n".join(lines)
        out = image
        if not passed and on_fail == "block":
            from comfy_execution.graph_utils import ExecutionBlocker
            out = ExecutionBlocker(None)
            report = "BLOCKED. " + report
        return {"ui": {"text": [report]}, "result": (out, passed, report)}


NODE_CLASS_MAPPINGS = {NODE_ID: LCVisionReviewer}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_ID: NODE_DISPLAY_NAME}
