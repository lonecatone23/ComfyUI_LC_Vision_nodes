"""
LC Vision Redirect
------------------
Sits between LC Vision Director and LC H3 Segment. Before a CONTINUE segment
is made, it looks at how the previous segment REALLY ended (its saved tail
frames) and rewrites the opening of the planned text to start from that
state. Most jumps at a join come from the plan saying "she opens the door"
when the door is already open: H3 then snaps the pose to match the words.

Runs once per segment: the result is saved into plan.json with the tail it
was made from, and reused until that tail changes (the previous segment was
redone). CUT segments and segment 1 pass straight through.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess

import numpy as np
import torch

from .lc_vision_caption import _image_input_to_base64_list
from .lc_vision_director import PLAN_TYPE, _QUOTE_RE, _norm, project_dir
from .lc_vision_generate import generate_with_recovery, release
from .lc_vision_loader import LCVisionModel, MODEL_TYPE, strip_thinking
from .lc_vision_moviemaker import _timestamps

NODE_ID = "LCVisionRedirect"
NODE_DISPLAY_NAME = "LC Vision Redirect 🔬"

# two calls: a small vision model describes well but rewrites lazily when it also has to look,
# so it first only looks, then rewrites from its own sentence as a text task
LOOK = (
    "You are a film continuity supervisor. These frames, in time order, are the last moments of a shot. "
    "In one or two sentences, say exactly how the shot ends, judged by the LAST frame: where each person is "
    "(inside or outside, standing, sitting, walking), their pose and hands, which way they face, what they "
    "hold or wear open or closed, and how the camera frames them. Facts only."
)
REWRITE = (
    "You fix continuity in a shot list. The next shot continues straight on from the END STATE with no cut, "
    "so its first beat must start from exactly that state.\n"
    "Read the PLANNED text beat by beat. A beat that has already happened by the end state, or that is "
    "impossible from it (sitting down while walking outside, opening a door already open, entering a place "
    "the person is already in), must be replaced by a beat that gets from the end state toward the plan's "
    "later beats. Beats that already fit stay word for word.\n"
    "If the END STATE is somewhere other than the Place line describes (a different spot in the room, a wall "
    "instead of the window), the first beat moves the person or the camera there smoothly (a slow pan, a few "
    "steps), so the shot never jumps. If the END STATE has the main person facing away from the camera, the first "
    "beat turns them back toward the camera (or the camera moves around to their face).\n"
    "Keep every timestamp exactly, keep the order of events, keep every quoted line word for word, keep the lines "
    "that start with \"Place:\", \"Holding:\" or \"Sound:\" exactly as they are, and otherwise describe actions only (never appearance).\n"
    "Example. END STATE: she stands inside the cafe by the counter. PLANNED: At 1.62 seconds, she pushes open "
    "the cafe door and steps inside. At 3.00 seconds, she orders a coffee. REWRITE: At 1.62 seconds, she turns "
    "to the counter and steps up to it. At 3.00 seconds, she orders a coffee.\n"
    "Output only the rewritten text."
)


def _seg_path(folder: str, index: int, suffix: str) -> str:
    """Same file names as the LC_AV segment nodes."""
    return os.path.join(folder, f"seg_{index:03d}{suffix}")


def _resolve_index(plan: dict, index: int) -> int:
    count = len(plan.get("shots", []))
    if index > 0:
        return min(index, count)
    folder = project_dir(plan.get("project", ""))
    for i in range(1, count + 1):
        if not (os.path.exists(_seg_path(folder, i, ".json")) and os.path.exists(_seg_path(folder, i, "_part.mp4"))):
            return i
    return count


def _tail_frames(path: str, picks: int = 3, side: int = 768) -> torch.Tensor | None:
    """A few frames spread over the saved tail (last one included), as an IMAGE batch."""
    ff, fp = shutil.which("ffmpeg"), shutil.which("ffprobe")
    if not ff or not fp or not os.path.exists(path):
        return None
    size = subprocess.run([fp, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", path],
                          capture_output=True, text=True).stdout.strip().split(",")
    w0, h0 = int(size[0]), int(size[1])
    w, h = side, int(round(h0 * side / w0 / 2) * 2)
    raw = subprocess.run([ff, "-v", "error", "-i", path, "-vf", f"scale={w}:{h}", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                         capture_output=True).stdout
    if not raw:
        return None
    arr = np.frombuffer(raw, dtype=np.uint8).reshape(-1, h, w, 3)
    idx = sorted(set(int(round(x)) for x in np.linspace(0, len(arr) - 1, picks)))
    return torch.from_numpy(arr[idx].astype(np.float32) / 255.0)


def _parse(text: str):
    end, nxt = "", ""
    if "###END###" in text and "###NEXT###" in text:
        end = text.split("###END###", 1)[1].split("###NEXT###", 1)[0].strip()
        nxt = text.split("###NEXT###", 1)[1].strip()
    return end, nxt


def _problems(original: str, rewritten: str, seg_s: float) -> list:
    out = []
    if not rewritten:
        return ["empty rewrite"]
    for line in _QUOTE_RE.findall(original):
        if _norm(line) and _norm(line) not in _norm(rewritten):
            out.append(f'lost the line "{line.strip()}"')
    stamps = _timestamps(rewritten)
    if not stamps:
        out.append("lost its timestamps")
    elif max(stamps) > seg_s + 0.01:
        out.append("runs past the segment")
    if len(rewritten) > len(original) * 1.6 + 80:
        out.append("grew too long")
    for label in ("place:", "holding:", "sound:"):
        keep = next((ln.strip() for ln in original.splitlines() if ln.strip().lower().startswith(label)), "")
        if keep and keep not in rewritten:
            out.append(f"changed the {label[:-1].title()} line")
    return out


class LCVisionRedirect:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "vision_model": (MODEL_TYPE, {"tooltip": "Handle from LC Vision Loader. Only loaded when a segment actually needs redirecting."}),
                "plan": (PLAN_TYPE, {"tooltip": "From LC Vision Director 🎬."}),
                "index": ("INT", {"default": 0, "min": 0, "max": 60, "tooltip": "Set it the same as LC H3 Segment. 0 = the next segment not saved yet."}),
                "enabled": ("BOOLEAN", {"default": True, "tooltip": "Off: the plan passes through untouched."}),
            },
            "optional": {
                "max_tokens": ("INT", {"default": 1024, "min": 128, "max": 8192}),
                "temperature": ("FLOAT", {"default": 0.3, "min": 0.0, "max": 2.0, "step": 0.05, "tooltip": "Low keeps the rewrite close to your plan."}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 2**32 - 1}),
            },
        }

    RETURN_TYPES = (PLAN_TYPE, "STRING")
    RETURN_NAMES = ("plan", "notes")
    FUNCTION = "run"
    CATEGORY = "LC Vision"
    DESCRIPTION = ("Looks at how the previous segment really ended and rewrites the opening of the next CONTINUE "
                   "segment to start from there, so H3 doesn't snap the pose at the join.")

    @classmethod
    def IS_CHANGED(cls, plan=None, index=0, enabled=True, **kwargs):
        if not isinstance(plan, dict) or not enabled:
            return ""
        i = _resolve_index(plan, index)
        tail = _seg_path(project_dir(plan.get("project", "")), i - 1, "_tail.mp4")
        return f"{i}:{os.path.getmtime(tail) if os.path.exists(tail) else 0}"

    def run(self, *args, **kwargs):
        try:
            return self._run(*args, **kwargs)
        finally:
            release(kwargs.get("vision_model", args[0] if args else None))

    def _run(self, vision_model: LCVisionModel, plan: dict, index: int, enabled: bool,
             max_tokens: int = 1024, temperature: float = 0.3, seed: int = 0) -> tuple:
        shots = plan.get("shots") or []
        if not enabled or not shots:
            return (plan, "Redirect is off.")
        i = _resolve_index(plan, index)
        shot = shots[i - 1]
        if i == 1 or shot.get("mode") != "CONTINUE":
            return (plan, f"Segment {i} is a {'first segment' if i == 1 else 'CUT'}: nothing to redirect.")
        folder = project_dir(plan["project"])
        tail = _seg_path(folder, i - 1, "_tail.mp4")
        if not os.path.exists(tail):
            return (plan, f"Segment {i - 1} isn't saved yet: nothing to look at.")
        tail_mtime = os.path.getmtime(tail)
        original = shot.get("action_original", shot["action"])

        saved = shot.get("redirect") or {}
        if saved.get("tail_mtime") == tail_mtime and saved.get("action"):
            print(f"[LC Vision] Redirect: reusing the saved rewrite for segment {i}.")
            return (plan, self._notes(i, saved, original))

        if vision_model is None or (getattr(vision_model, "llm", None) is None
                                    and getattr(vision_model, "build_params", None) is None):
            raise ValueError("[LC Vision] Redirect received no model. Connect an LC Vision Loader.")
        frames = _tail_frames(tail)
        if frames is None:
            return (plan, f"Could not read {tail} (is ffmpeg on PATH?).")
        content = []
        b64 = _image_input_to_base64_list(frames, 768, 90)
        for k, img in enumerate(b64, start=1):
            content.append({"type": "text", "text": f"\n<Frame {k} of {len(b64)}>"})
            content.append({"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{img}"}})
        qwen3 = getattr(vision_model, "is_qwen3_family", False)

        def _ask(system, user):
            if qwen3:
                user = [{"type": "text", "text": "/no_think"}] + user
            response = generate_with_recovery(
                vision_model,
                messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
                max_tokens=max_tokens, temperature=temperature, top_p=0.9, repeat_penalty=1.05, seed=seed,
            )
            return strip_thinking(((response or {}).get("choices") or [{}])[0].get("message", {}).get("content", "") or "").strip()

        end = _ask(LOOK, content)
        rewritten = _ask(REWRITE, [{"type": "text", "text": f"END STATE: {end}\nPLANNED: {original}\nREWRITE:"}])
        rewritten = rewritten.split("REWRITE:", 1)[-1].strip()
        problems = _problems(original, rewritten, plan.get("segment_s", 99))
        if problems:
            print(f"[LC Vision] Redirect: rewrite for segment {i} rejected ({'; '.join(problems)}), keeping the plan's text.")
            rewritten = original
        entry = {"tail_mtime": tail_mtime, "end_state": end, "action": rewritten, "rejected": problems}

        new_plan = json.loads(json.dumps(plan))
        s = new_plan["shots"][i - 1]
        s["action_original"] = original
        s["action"] = rewritten
        s["prompt"] = f"{new_plan.get('style', '')}\n\n{rewritten}".strip()
        s["redirect"] = entry
        path = os.path.join(folder, "plan.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(new_plan, f, indent=1, ensure_ascii=False)
        notes = self._notes(i, entry, original)
        print(f"[LC Vision] Redirect:\n{notes}")
        return (new_plan, notes)

    @staticmethod
    def _notes(i: int, entry: dict, original: str) -> str:
        lines = [f"Segment {i - 1} ends: {entry.get('end_state') or '(not described)'}"]
        if entry.get("rejected"):
            lines.append(f"Rewrite rejected ({'; '.join(entry['rejected'])}), segment {i} keeps the planned text.")
        elif entry.get("action") == original:
            lines.append(f"Segment {i} already matches, no change.")
        else:
            lines.append(f"Segment {i} now starts:\n{entry['action']}\n\nPlanned:\n{original}")
        return "\n".join(lines)


NODE_CLASS_MAPPINGS = {
    NODE_ID: LCVisionRedirect,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_ID: NODE_DISPLAY_NAME,
}
