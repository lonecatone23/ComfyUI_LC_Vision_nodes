"""
LC Vision Director
------------------
Plans a long MiniMax H3 video as a chain of short segments, each generated in
its own queue run and seeded from the end of the one before (the LC_AV
segment nodes do the generating). Moviemaker plans independent clips; the
Director plans a chain, which changes the rules:

- one shared STYLE block (people, setting, light, camera) written once and
  pasted word for word into every segment, so nothing gets reworded
- every segment is tagged CUT (fresh shot) or CONTINUE (camera keeps rolling
  from the previous segment's last frames)
- a CONTINUE segment's first `overlap` seconds are the held end of the
  previous segment, so its new action is planned on a shorter local clock
  and shifted past the overlap afterwards
- every segment ends settled (stable pose, face visible) so the next one
  has a clean handoff; a line of dialogue never spans two segments

The plan is saved to output/LC_H3/<project>/plan.json and reused on later
runs (no LLM call) until the story or the timing changes, or `replan` is on.
"""

from __future__ import annotations

import difflib
import json
import os
import re
import time

import folder_paths

from .lc_vision_caption import _image_input_to_base64_list
from .lc_vision_generate import generate_with_recovery, release
from .lc_vision_loader import LCVisionModel, MODEL_TYPE, strip_thinking
from .lc_vision_moviemaker import CUSTOM_PRESET_LABEL, FALLBACK_PRESET, _META_LEAK_RE, _TIMESTAMP_RE, _load_presets, _shift_timestamps, _timestamps
from .lc_vision_styles import STYLE_TAG_OPTIONS, apply_style_tag_to_content

NODE_ID = "LCVisionDirector"
NODE_DISPLAY_NAME = "LC Vision Director 🎬"

PLAN_TYPE = "LC_H3_PLAN"
MAX_SEGMENTS = 60
FPS = 24
WORDS_PER_SECOND = 2.5

_STYLE_RE = re.compile(r"###STYLE###\s*(.*?)(?=###SEGMENT_\d+###|\Z)", re.DOTALL)
_SEG_RE = re.compile(r"###SEGMENT_(\d+)###[ \t]*\[?(CUT|CONTINUE)?\]?[ \t]*\n?(.*?)(?=###SEGMENT_\d+###|\Z)", re.DOTALL | re.IGNORECASE)
_QUOTE_RE = re.compile(r"[\"“](.+?)[\"”]", re.DOTALL)


def snap_frames(seconds: float, minimum: int = 5) -> int:
    """H3 frame counts sit on a 17k+5 grid."""
    k = max(0, round((seconds * FPS - 5) / 17))
    return max(minimum, 17 * k + 5)


def project_dir(project: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9 _.-]", "_", project.strip()) or "untitled"
    return os.path.join(folder_paths.get_output_directory(), "LC_H3", safe)


def _instructions(segments: int, seg_s: float, new_s: float, overlap_s: float, reference_count: int) -> str:
    text = (
        f"You are directing a {segments}-segment video. Each segment is a separate {seg_s:.2f}-second "
        f"generation by a video renderer that remembers nothing between calls. The segments are "
        f"joined afterwards, so you plan the whole story at once and write each segment as its own "
        f"prompt.\n\n"
        f"First write a STYLE block, once. It describes everything that stays the same: every person "
        f"on screen (face, hair, build, clothing, distinguishing details), the location, the lighting "
        f"and time of day, the camera style and the visual style. It is pasted word for word in front "
        f"of every segment, so the segments themselves must NOT describe anyone's appearance or the "
        f"setting again, only what happens.\n\n"
        f"Then write every segment, tagged CUT or CONTINUE:\n"
        f"- CONTINUE: the camera keeps rolling. The renderer is shown the last {overlap_s:.2f} seconds "
        f"of the previous segment, so this segment picks up exactly where the previous one ended: "
        f"same pose, same position, same camera. Plan {new_s:.2f} seconds of NEW action on a local "
        f"clock from 0.00 to {new_s:.2f} seconds.\n"
        f"- CUT: a new camera angle or a new moment, same people and place unless the story moves "
        f"them. Plan {seg_s:.2f} seconds of action on a local clock from 0.00 to {seg_s:.2f} seconds.\n"
        f"- Segment 1 is always CUT. Prefer CONTINUE; use CUT only for a real change of angle, place "
        f"or time.\n\n"
        f"Rules for every segment:\n"
        f"0) FOLLOW THE STORY'S ORDER: events happen in the order the story gives them, and a quoted "
        f"line belongs at the exact moment the story puts it. If the story runs out before the last "
        f"segment, slow it down (smaller steps, reactions) rather than inventing new people or events.\n"
        f"1) Use explicit local timestamps (\"at 0.00 seconds ...\", \"at 1.50 seconds ...\"), several "
        f"beats spread over the segment's span.\n"
        f"2) ACTION NEVER REPEATS: always move forward from exactly where the previous segment ended. "
        f"Track where each person is; someone who left the frame stays out or visibly re-enters. "
        f"Something that already happened (an arrival, a hug) never happens again from scratch.\n"
        f"3) END SETTLED: in the last second of every segment the main person holds a clear, stable "
        f"pose with the face visible and the camera steady. No new action starts in that last second.\n"
        f"4) DIALOGUE: at most one quoted line per segment, said once, verbatim, in quotes, inside an "
        f"explicit short time window that finishes before the last second. A sentence is never split "
        f"across two segments. Keep a line to about {WORDS_PER_SECOND:g} words per second of its "
        f"window. No other mouth business (sighing, sipping, muttering) in a segment with a line.\n"
        f"5) Say what happens, never what does not happen (no \"without\", \"no\", \"doesn't\").\n"
        f"6) Plain scene description only: never mention segments, cuts, overlap, stitching or "
        f"timing schemes in the text.\n\n"
    )
    if reference_count > 0:
        text += (
            f"You are shown {reference_count} reference image(s), labeled <Reference 1>, <Reference 2>, "
            f"etc. Describe each one's real visual details in the STYLE block and refer to it as "
            f"<Picture N> (matching Reference N), following the preset instructions below.\n\n"
        )
    text += (
        "Output format (exactly this, nothing else):\n"
        "###STYLE###\n<style block>\n"
        "###SEGMENT_1### CUT\n<segment 1 action>\n"
        "###SEGMENT_2### CONTINUE\n<segment 2 action>\n"
        f"... through ###SEGMENT_{segments}###. No preamble, no lists, no reasoning."
    )
    return text


def _parse(text: str, segments: int):
    m = _STYLE_RE.search(text)
    style = m.group(1).strip() if m else ""
    found = {}
    for num, mode, body in _SEG_RE.findall(text):
        found[int(num)] = ((mode or "CONTINUE").upper(), body.strip())
    shots = []
    for i in range(1, segments + 1):
        mode, body = found.get(i, ("CONTINUE", ""))
        shots.append({"mode": "CUT" if i == 1 else mode, "action": body})
    return style, shots


def _norm(text: str) -> str:
    return re.sub(r"[^a-z0-9 ]", "", text.lower()).strip()


def _issues(style: str, shots: list, seg_s: float, new_s: float, story: str = "") -> list:
    out = []
    if not style:
        out.append("the STYLE block is missing")
    everything = _norm(" ".join(s["action"] for s in shots))
    for line in _QUOTE_RE.findall(story):
        if _norm(line) and _norm(line) not in everything:
            out.append(f"the story's line \"{line.strip()}\" is missing; say it verbatim, in quotes, where the story puts it")
    for i, s in enumerate(shots, start=1):
        body = s["action"]
        if not body:
            out.append(f"segment {i} is missing")
            continue
        if _META_LEAK_RE.search(body):
            out.append(f"segment {i} mentions segments / stitching / timing; it must be plain scene description")
        span = seg_s if s["mode"] == "CUT" else new_s
        stamps = _timestamps(body)
        if stamps and max(stamps) < span * 0.5:
            out.append(f"segment {i} stopped too early; it must reach close to {span:.2f} seconds")
        if body.count('"') % 2:
            out.append(f"segment {i} has an unclosed quote; a line of dialogue must start and finish in the same segment")
        lines = _QUOTE_RE.findall(body)
        if len(lines) > 1:
            out.append(f"segment {i} has {len(lines)} lines of dialogue; one at most")
        for line in lines:
            if len(line.split()) > WORDS_PER_SECOND * max(1.0, span - 1.0):
                out.append(f"segment {i}'s line is too long for {span:.2f} seconds; shorten it")
    for i in range(len(shots) - 1):
        # compare without the "at X.XX seconds" scaffolding, which every segment shares
        a, b = (re.sub(r"at \d+(?:\.\d+)? seconds,?", "", s["action"]) for s in shots[i:i + 2])
        if a.strip() and b.strip() and difflib.SequenceMatcher(None, a, b).ratio() > 0.6:
            out.append(f"segment {i + 2} repeats segment {i + 1}'s action instead of moving forward")
    return out


def _merge(orig, retry):
    """Keep the better version of each piece rather than an all-or-nothing swap."""
    style = retry[0] or orig[0]
    shots = []
    for a, b in zip(orig[1], retry[1]):
        if not b["action"]:
            shots.append(a)
        elif not a["action"]:
            shots.append(b)
        elif _META_LEAK_RE.search(a["action"]) and not _META_LEAK_RE.search(b["action"]):
            shots.append(b)
        elif a["action"].count('"') % 2 and not b["action"].count('"') % 2:
            shots.append(b)
        else:
            shots.append(b if max(_timestamps(b["action"]), default=0) > max(_timestamps(a["action"]), default=0) else a)
    return style, shots


def _fit_clock(text: str, span: float) -> str:
    """LLMs often plan a CONTINUE segment on the full segment clock anyway. Squeeze the
    timestamps back into the span (keeping 0.3 s of settled hold at the end) instead of
    retrying, which rarely fixes it."""
    stamps = _timestamps(text)
    if not stamps or max(stamps) <= span - 0.3:
        return text
    scale = (span - 0.3) / max(stamps)
    return _TIMESTAMP_RE.sub(lambda m: f"{float(m.group(1)) * scale:.2f}{m.group(2)}", text)


def plan_text(plan: dict) -> str:
    lines = []
    for w in plan.get("warnings", []):
        lines.append(f"⚠️ {w}")
    if lines:
        lines.append("")
    lines.append(f"STYLE (in every segment):\n{plan['style']}\n")
    for s in plan["shots"]:
        lines.append(f"--- Segment {s['index']} | {s['mode']} | {s['start_s']:.2f}-{s['start_s'] + plan['segment_s']:.2f} s on the final video")
        lines.append(s["action"] + "\n")
    return "\n".join(lines)


class LCVisionDirector:
    @classmethod
    def INPUT_TYPES(cls):
        presets = _load_presets()
        preset_names = [CUSTOM_PRESET_LABEL] + list(presets.keys())
        default_preset = FALLBACK_PRESET if FALLBACK_PRESET in presets else preset_names[0]
        return {
            "required": {
                "vision_model": (MODEL_TYPE, {"tooltip": "Handle from LC Vision Loader. Not loaded at all when a saved plan is reused."}),
                "project": ("STRING", {"default": "parka_test", "tooltip": "Project name. The plan and every segment are saved in output/LC_H3/<project>/."}),
                "story": ("STRING", {"multiline": True, "default": "", "tooltip": "The whole story, start to finish. Say who is in it, where, and what happens."}),
                "preset": (preset_names, {"default": default_preset, "tooltip": "Which MiniMax H3 mode the segments are written for. Add more in lc_vision_moviemaker_presets.json (shared with Moviemaker)."}),
                "segments": ("INT", {"default": 3, "min": 1, "max": MAX_SEGMENTS, "tooltip": "How many segments. 12 segments of 5 s is about a minute (the overlap is shared)."}),
                "segment_seconds": ("FLOAT", {"default": 5.0, "min": 2.0, "max": 20.0, "step": 0.5, "tooltip": "Length of each generated segment. Snapped to H3's frame grid (5.0 = 124 frames). Shorter = less VRAM."}),
                "overlap_seconds": ("FLOAT", {"default": 1.6, "min": 0.2, "max": 6.0, "step": 0.1, "tooltip": "How much of the previous segment a CONTINUE segment starts from. 1.6 s (39 frames) is a good default."}),
                "replan": ("BOOLEAN", {"default": False, "tooltip": "On: always write a new plan. Off: reuse this project's saved plan as long as the story and timing are unchanged."}),
            },
            "optional": {
                "custom_system_prompt": ("STRING", {"multiline": True, "default": "", "tooltip": "Used only when preset is 'Custom'."}),
                "style_tag": (STYLE_TAG_OPTIONS, {"default": "None", "tooltip": "Commits every segment to one visual style."}),
                "reference_image_1": ("IMAGE", {"tooltip": "For R2VA / FL2VA presets. Labeled <Reference 1>, written back as <Picture 1>."}),
                "reference_image_2": ("IMAGE", {"tooltip": "Labeled <Reference 2> / <Picture 2>."}),
                "reference_image_3": ("IMAGE", {"tooltip": "Labeled <Reference 3> / <Picture 3>."}),
                "reference_image_4": ("IMAGE", {"tooltip": "Labeled <Reference 4> / <Picture 4>."}),
                "max_tokens": ("INT", {"default": 8192, "min": 256, "max": 32768, "tooltip": "Token limit for the whole plan. Raise it for many segments."}),
                "temperature": ("FLOAT", {"default": 0.7, "min": 0.0, "max": 2.0, "step": 0.05}),
                "top_p": ("FLOAT", {"default": 0.9, "min": 0.0, "max": 1.0, "step": 0.01}),
                "repetition_penalty": ("FLOAT", {"default": 1.1, "min": 0.5, "max": 2.0, "step": 0.01}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 2**32 - 1}),
            },
        }

    RETURN_TYPES = (PLAN_TYPE, "STRING")
    RETURN_NAMES = ("plan", "plan_text")
    FUNCTION = "run"
    CATEGORY = "LC Vision"
    DESCRIPTION = ("Plans a long MiniMax H3 video as a chain of short CUT / CONTINUE segments with one shared style block. "
                   "Saves the plan to the project folder and reuses it.")

    @classmethod
    def IS_CHANGED(cls, project="", replan=False, **kwargs):
        if replan:
            return float("nan")
        path = os.path.join(project_dir(project), "plan.json")
        return os.path.getmtime(path) if os.path.exists(path) else ""

    def run(self, *args, **kwargs):
        try:
            return self._run(*args, **kwargs)
        finally:
            release(kwargs.get("vision_model", args[0] if args else None))

    def _run(self, vision_model: LCVisionModel, project: str, story: str, preset: str, segments: int,
             segment_seconds: float, overlap_seconds: float, replan: bool, custom_system_prompt: str = "",
             style_tag: str = "None", reference_image_1=None, reference_image_2=None, reference_image_3=None,
             reference_image_4=None, max_tokens: int = 8192, temperature: float = 0.7, top_p: float = 0.9,
             repetition_penalty: float = 1.1, seed: int = 0) -> tuple:
        segments = max(1, min(MAX_SEGMENTS, int(segments)))
        seg_frames = snap_frames(segment_seconds, minimum=22)
        overlap_frames = min(snap_frames(overlap_seconds), seg_frames - 17)
        seg_s = seg_frames / FPS
        overlap_s = overlap_frames / FPS
        new_s = (seg_frames - overlap_frames) / FPS
        key = {"story": story.strip(), "preset": preset, "segments": segments, "segment_frames": seg_frames,
               "overlap_frames": overlap_frames, "style_tag": style_tag}

        folder = project_dir(project)
        path = os.path.join(folder, "plan.json")
        if not replan and os.path.exists(path):
            try:
                with open(path, "r", encoding="utf-8") as f:
                    saved = json.load(f)
                if all(saved.get(k) == v for k, v in key.items()):
                    print(f"[LC Vision] Director: reusing the saved plan for '{project}'.")
                    return (saved, plan_text(saved))
                print(f"[LC Vision] Director: story or timing changed for '{project}', writing a new plan.")
            except Exception as exc:
                print(f"[LC Vision] Director: could not read {path} ({exc}), writing a new plan.")

        if vision_model is None or (getattr(vision_model, "llm", None) is None
                                    and getattr(vision_model, "build_params", None) is None):
            raise ValueError("[LC Vision] Director received no model. Connect an LC Vision Loader.")

        references = [reference_image_1, reference_image_2, reference_image_3, reference_image_4]
        reference_count = sum(1 for r in references if r is not None)
        presets = _load_presets()
        if preset == CUSTOM_PRESET_LABEL and custom_system_prompt.strip():
            preset_text = custom_system_prompt.strip()
        else:
            entry = presets.get(preset if preset != CUSTOM_PRESET_LABEL else FALLBACK_PRESET)
            if not entry:
                raise ValueError(f"[LC Vision] Preset '{preset}' not found in lc_vision_moviemaker_presets.json.")
            preset_text = entry["system_prompt"]
            if entry.get("needs_reference") and not reference_count:
                print(f"[LC Vision] Warning: preset '{preset}' expects reference image(s), but none were connected.")

        system_prompt = _instructions(segments, seg_s, new_s, overlap_s, reference_count) + "\n\n" + preset_text
        story_lines = [ln.strip() for ln in _QUOTE_RE.findall(story) if ln.strip()]
        if story_lines:
            system_prompt += ("\n\nThe story has these spoken lines. Each one MUST appear exactly once, verbatim and in "
                              "quotes, in the segment where the story puts it: " + " | ".join(f'"{ln}"' for ln in story_lines))
        content = [{"type": "text", "text": story.strip() or "Plan a short scene."}]
        for idx, ref in enumerate(references, start=1):
            if ref is None:
                continue
            frames = _image_input_to_base64_list(ref, 768, 90)
            if frames:
                content.append({"type": "text", "text": f"\n<Reference {idx}>"})
                for b64 in frames:
                    content.append({"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}})
        content = apply_style_tag_to_content(content, style_tag)
        if getattr(vision_model, "is_qwen3_family", False):
            content = [{"type": "text", "text": "/no_think"}] + content

        def _call(sys_prompt, temp, seed_val):
            response = generate_with_recovery(
                vision_model,
                messages=[{"role": "system", "content": sys_prompt}, {"role": "user", "content": content}],
                max_tokens=max_tokens, temperature=temp, top_p=top_p, repeat_penalty=repetition_penalty, seed=seed_val,
            )
            if not response or not response.get("choices"):
                raise RuntimeError("[LC Vision] Director: the model returned an empty response.")
            return strip_thinking(response["choices"][0].get("message", {}).get("content", "") or "")

        parsed = _parse(_call(system_prompt, temperature, seed), segments)
        issues = _issues(parsed[0], parsed[1], seg_s, new_s, story)
        if issues:
            print(f"[LC Vision] Director: issues on the first pass ({'; '.join(issues)}); retrying once.")
            retry_prompt = system_prompt + ("\n\nYour previous plan had these problems: " + "; ".join(issues) +
                                            ". Fix exactly these, keep the same output format, and write every segment.")
            retry = _parse(_call(retry_prompt, max(0.2, temperature - 0.2), seed + 1), segments)
            retry_issues = _issues(retry[0], retry[1], seg_s, new_s, story)
            # a whole plan with fewer problems wins; mixing segments from two plans can lose or double a line
            if len(retry_issues) < len(issues):
                parsed, issues = retry, retry_issues
            elif len(retry_issues) == len(issues):
                merged = _merge(parsed, retry)
                merged_issues = _issues(merged[0], merged[1], seg_s, new_s, story)
                if len(merged_issues) <= len(issues):
                    parsed, issues = merged, merged_issues

        style, raw_shots = parsed
        shots, end = [], 0.0
        for i, s in enumerate(raw_shots):
            # a CONTINUE segment's first overlap_s is the held tail: its local clock starts after it,
            # and on the final video it starts overlap_s before the previous segment ends
            cont = s["mode"] == "CONTINUE"
            action = _fit_clock(s["action"], new_s if cont else seg_s)
            action = _shift_timestamps(action, overlap_s) if cont else action
            start = end - overlap_s if cont else end
            end = start + seg_s
            shots.append({"index": i + 1, "mode": s["mode"], "action": action, "start_s": round(start, 3),
                          "prompt": f"{style}\n\n{action}".strip()})
        plan = {**key, "version": 1, "project": project, "fps": FPS, "segment_s": seg_s, "overlap_s": overlap_s,
                "style": style, "shots": shots, "warnings": issues, "created": time.strftime("%Y-%m-%d %H:%M:%S")}
        os.makedirs(folder, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(plan, f, indent=1, ensure_ascii=False)
        return (plan, plan_text(plan))


NODE_CLASS_MAPPINGS = {
    NODE_ID: LCVisionDirector,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_ID: NODE_DISPLAY_NAME,
}
