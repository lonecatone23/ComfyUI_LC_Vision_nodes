"""
LC Vision Moviemaker
---------------------
A Prompt Enhancer built for planning a video as N independently-generated
segments instead of one continuous description. The problem this solves:
ask an LLM for one 25-second scene and it writes one flowing paragraph
that doesn't cut cleanly into 5-second pieces; generate each segment with
a fresh independent call and you lose character/setting/camera continuity
between them.

The fix used here: one LLM call, not N. The model sees the whole plan at
once (story, total length, segment count, MiniMax H3 mode) and writes all
N segments in a single response, using a delimiter format this node
controls (###SEGMENT_N###) rather than the fragile after-the-fact
delimiter-guessing a plain text splitter would need. Because it plans the
full arc together, later segments can explicitly continue from earlier
ones while each one still comes out as an independently usable,
self-contained MiniMax H3 prompt.

Output is up to MAX_SEGMENTS separate STRING sockets (segment_1..N). The
JS companion (web/lc_vision_moviemaker.js) adds/removes real output
sockets to match the current `segments` widget value -- ComfyUI's
RETURN_TYPES is fixed at class-definition time, so the Python side always
declares the full MAX_SEGMENTS and returns "" past whatever was requested.

Presets live in lc_vision_moviemaker_presets.json -- see that file's own
comment and README.md's licensing note.
"""

from __future__ import annotations

import difflib
import json
import re
from pathlib import Path

from .lc_vision_caption import _image_input_to_base64_list, _sample_indices
from .lc_vision_generate import generate_with_recovery
from .lc_vision_loader import LCVisionModel, MODEL_TYPE
from .lc_vision_styles import STYLE_TAG_OPTIONS, apply_style_tag_to_content

NODE_ID = "LCVisionMoviemaker"
NODE_DISPLAY_NAME = "LC Vision Moviemaker 🎥"

MAX_SEGMENTS = 20
PRESETS_PATH = Path(__file__).parent / "lc_vision_moviemaker_presets.json"
CUSTOM_PRESET_LABEL = "Custom"

_SEGMENT_RE = re.compile(r"###SEGMENT_(\d+)###\s*(.*?)(?=###SEGMENT_\d+###|\Z)", re.DOTALL)


def _load_presets() -> dict[str, dict]:
    try:
        with open(PRESETS_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        return {name: entry for name, entry in data.get("presets", {}).items() if entry.get("system_prompt")}
    except Exception as exc:
        print(f"[LC Vision] Failed to load lc_vision_moviemaker_presets.json: {exc}")
        return {}


def _base_instructions(segments: int, total_length: float, segment_length: float, reference_count: int, has_video: bool = False) -> str:
    buffer = max(1.0, segment_length * 0.15)
    text = (
        f"You are planning a {total_length:g}-second video as {segments} separate "
        f"{segment_length:g}-second segments -- {segments} SEPARATE generation calls to a "
        f"downstream video renderer that has NO memory of any other segment, later stitched "
        f"together into ONE continuous, unedited shot (not a series of cuts). Four rules follow "
        f"directly from that, and they are different rules, do not blur them together:\n"
        f"1) EACH SEGMENT HAS ITS OWN LOCAL CLOCK: every segment's timestamps restart from "
        f"0.00 -- this is a separate generation call, and the system stitching everything "
        f"together afterward handles the real global timing on its own. Do NOT try to calculate "
        f"or write running/global timestamps, and do not mention segment numbers, stitching, or "
        f"how the timing works anywhere in the text -- just describe your own "
        f"{segment_length:.2f}-second span as its own self-contained clip starting at 0.00, "
        f"exactly as if it were the only video you were asked to plan.\n"
        f"2) PEOPLE REPEAT: every segment's prompt must independently restate the full visual "
        f"description (appearance, clothing) of everyone on screen in it, since the renderer "
        f"cannot see any other segment.\n"
        f"3) SETTING STAYS FIXED: the location, environment, lighting, and time of day "
        f"established in segment 1 must carry over identically into every later segment -- "
        f"restate it the same way each time. Never silently change where the scene is happening "
        f"(e.g. outdoors to indoors) unless the story you were given explicitly says everyone "
        f"moves to a new place.\n"
        f"4) ACTION NEVER REPEATS: the events/poses/movement you describe must always move the "
        f"story forward from exactly where the previous segment ended. Never re-describe an "
        f"action, pose, or moment already covered in an earlier segment -- segment 2 continues "
        f"the story, it does not retell segment 1. This includes PHYSICAL PRESENCE: track exactly "
        f"where each person is and whether they are on-screen at the moment the previous segment "
        f"ended. If someone walked off-frame or left the scene, the next segment must either keep "
        f"them off-frame or show them explicitly re-entering -- they cannot simply be back in "
        f"position with no transition. And if something has already happened once (a kiss, an "
        f"embrace, an arrival), do not have it happen again from scratch in a later segment as if "
        f"for the first time -- move past it to what comes next.\n\n"
        f"Each segment should include several distinct beats spread across close to its own "
        f"full {segment_length:.2f}-second span -- do not stop after only one or two sentences. "
        f"Do NOT treat the segment's main action (e.g. a kiss, an arrival) as the end of the "
        f"segment -- once it happens, keep going: add what happens immediately after it "
        f"(reactions, small movements, repositioning, dialogue-free business) so the segment "
        f"keeps filling time instead of stopping. The LAST new action in a segment MUST land "
        f"within about the final {buffer:.2f} seconds of that segment's own span: late enough "
        f"to use the available time, but never exactly at or after that segment's own "
        f"end-of-range timestamp, which leaves no time to render.\n\n"
    )
    if reference_count > 0:
        text += (
            f"You are shown {reference_count} reference image(s), labeled <Reference 1>, "
            f"<Reference 2>, etc. In every segment where a reference is on screen, describe that "
            f"reference's own visual details (appearance, clothing, distinguishing features) from "
            f"its actual image -- not just narrate the action involving it -- and refer to it as "
            f"<Picture N> (matching Reference N) tied to a [Shot N] label per your preset "
            f"instructions below. [Shot N] is a label identifying which reference a moment "
            f"involves -- it is NOT a directive to cut between camera angles. Describe one "
            f"continuous, unedited take per segment; do not cross-cut between shots or return to "
            f"an earlier shot mid-segment. Give every reference this individual treatment each "
            f"time it appears; never leave one described only generically.\n\n"
        )
    if has_video:
        text += (
            "You are also shown a reference video labeled <Target Video>, sampled as a "
            "sequence of frames. Use it to inform motion, pacing, camera style, and any "
            "subject appearance it establishes -- treat it as source material for how things "
            "move and look, not as a person you must separately describe the way <Reference N> "
            "images are described above.\n\n"
        )
    text += (
        "Output format (follow this exactly, nothing else):\n"
        "###SEGMENT_1###\n<segment 1 prompt text>\n"
        "###SEGMENT_2###\n<segment 2 prompt text>\n"
        f"... continue through ###SEGMENT_{segments}###. No preamble, no numbered-list "
        "formatting beyond the ###SEGMENT_N### markers themselves, no <think> or reasoning of "
        "any kind."
    )
    return text


def _parse_segments(text: str, segments: int) -> list[str]:
    found = {int(num): body.strip() for num, body in _SEGMENT_RE.findall(text)}
    return [found.get(i, "") for i in range(1, segments + 1)]


_TIMESTAMP_RE = re.compile(r"(\d+(?:\.\d+)?)(\s*seconds)")
_META_LEAK_RE = re.compile(
    r"\bsegments?\b|\bstitched\b|\bcorresponds? to\b|\bcontinuity\b|\bwhen stitched\b",
    re.IGNORECASE,
)


def _timestamps(text: str) -> list[float]:
    return [float(v) for v, _ in _TIMESTAMP_RE.findall(text)]


def _shift_timestamps(text: str, offset: float) -> str:
    """Rewrite every local 'X.XX seconds' mention onto the global clock. The
    model plans each segment on its own local 0.00-based clock (rule 1 in
    _base_instructions) -- asking it to do the global running arithmetic
    itself proved unreliable in practice (it kept reverting to a local
    clock despite explicit instructions, or leaking the arithmetic into the
    prose as meta-commentary). Doing it here instead is exact every time."""
    if not text or offset == 0:
        return text

    def _repl(m: re.Match) -> str:
        return f"{float(m.group(1)) + offset:.2f}{m.group(2)}"

    return _TIMESTAMP_RE.sub(_repl, text)


def _segment_issues(parsed: list[str], segment_length: float) -> list[str]:
    """Catch cases the model itself gets wrong: stopping early, repeating one
    segment's action into the next instead of advancing the story, or
    leaking meta-commentary about the segmenting/timing scheme into the
    actual prompt text. Timestamps here are still each segment's own local
    clock (0.00-based) -- the global shift happens after this check."""
    issues: list[str] = []
    min_coverage = segment_length * 0.5
    for i, seg in enumerate(parsed, start=1):
        if not seg:
            issues.append(f"segment {i} is missing")
            continue
        if _META_LEAK_RE.search(seg):
            issues.append(
                f"segment {i} mentions the segmenting/timing scheme itself (e.g. 'segment', "
                f"'stitched', 'corresponds to') -- it must read as plain scene description only"
            )
        stamps = _timestamps(seg)
        if stamps and max(stamps) < min_coverage:
            issues.append(f"segment {i} stopped too early -- it must reach close to {segment_length:g} seconds")
    for i in range(len(parsed) - 1):
        a, b = parsed[i], parsed[i + 1]
        if a and b and difflib.SequenceMatcher(None, a, b).ratio() > 0.6:
            issues.append(f"segment {i + 2} repeats segment {i + 1}'s action instead of advancing the story")
    return issues


def _merge_best_segments(original: list[str], retry: list[str]) -> list[str]:
    """Pick the better version of each segment individually rather than an
    all-or-nothing swap -- a retry that only partially improves coverage
    (e.g. still borderline-short) would otherwise lose to a whole-block
    issue-count tie and the original's truncated segment would stick."""
    merged: list[str] = []
    for i, orig_seg in enumerate(original):
        retry_seg = retry[i] if i < len(retry) else ""
        if not retry_seg:
            merged.append(orig_seg)
        elif not orig_seg:
            merged.append(retry_seg)
        elif _META_LEAK_RE.search(orig_seg) and not _META_LEAK_RE.search(retry_seg):
            merged.append(retry_seg)
        elif _META_LEAK_RE.search(retry_seg) and not _META_LEAK_RE.search(orig_seg):
            merged.append(orig_seg)
        else:
            orig_cov = max(_timestamps(orig_seg), default=0.0)
            retry_cov = max(_timestamps(retry_seg), default=0.0)
            merged.append(retry_seg if retry_cov > orig_cov else orig_seg)
    return merged


class LCVisionMoviemaker:
    @classmethod
    def INPUT_TYPES(cls):
        presets = _load_presets()
        preset_names = [CUSTOM_PRESET_LABEL] + list(presets.keys())
        return {
            "required": {
                "vision_model": (MODEL_TYPE, {"tooltip": "Handle from LC Vision Loader."}),
                "story": ("STRING", {"multiline": True, "default": "", "tooltip": "The overall scene or story to plan across every segment."}),
                "preset": (preset_names, {"tooltip": "Which MiniMax H3 mode/format to write each segment for. 'Custom' reads its system prompt from the custom_system_prompt socket instead. Add more presets in lc_vision_moviemaker_presets.json."}),
                "length_seconds": ("FLOAT", {"default": 10.0, "min": 1.0, "max": 3600.0, "step": 0.5, "tooltip": "Total planned length across every segment combined."}),
                "segments": ("INT", {"default": 1, "min": 1, "max": MAX_SEGMENTS, "tooltip": f"Number of separate generation calls to plan for (max {MAX_SEGMENTS}). Output sockets grow to match -- add another wire and this raises automatically, or set it directly."}),
            },
            "optional": {
                "custom_system_prompt": ("STRING", {"multiline": True, "default": "", "tooltip": "Used only when preset is 'Custom' -- read directly instead of a lc_vision_moviemaker_presets.json entry. The structural timing/continuity/reference rules still apply on top of this."}),
                "style_tag": (STYLE_TAG_OPTIONS, {"default": "None", "tooltip": "Commits every segment to a specific visual style. 'None' leaves style unconstrained."}),
                "reference_image_1": ("IMAGE", {"tooltip": "For R2VA/FL2VA presets. Labeled <Reference 1> to the model, written back as <Picture 1> in segment text."}),
                "reference_image_2": ("IMAGE", {"tooltip": "Labeled <Reference 2> / <Picture 2>."}),
                "reference_image_3": ("IMAGE", {"tooltip": "Labeled <Reference 3> / <Picture 3>."}),
                "reference_image_4": ("IMAGE", {"tooltip": "Labeled <Reference 4> / <Picture 4>."}),
                "reference_video": ("IMAGE", {"tooltip": "A frame-sequence batch, labeled <Target Video>. Informs motion/style/continuity rather than being treated as a person to individually describe. Sampled down to video_max_frames."}),
                "video_max_frames": ("INT", {"default": 8, "min": 1, "max": 64, "tooltip": "Reference video frames are evenly sampled down to this count before sending -- sending every frame of a long clip would blow the token budget."}),
                "max_image_side": ("INT", {"default": 768, "min": 0, "max": 4096, "tooltip": "Downscale any reference longer edge to this before sending. 0 = no resize."}),
                "jpeg_quality": ("INT", {"default": 90, "min": 10, "max": 100, "tooltip": "JPEG encoding quality for references sent to the model."}),
                "end_pad_seconds": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 10.0, "step": 0.1, "tooltip": "LLMs are consistently bad at judging elapsed time and tend to undershoot a stated duration. This much is silently shaved off length_seconds before it's ever shown to the model (proportionally, across every segment), so its own undershoot lands close to your real target instead of well short of it. Raise it if segments still stop noticeably early; 0 disables."}),
                "max_tokens": ("INT", {"default": 4096, "min": 64, "max": 32768, "tooltip": "Upper limit on generated tokens for the WHOLE response (all segments together) -- raise this along with segment count."}),
                "temperature": ("FLOAT", {"default": 0.7, "min": 0.0, "max": 2.0, "step": 0.05, "tooltip": "Sampling randomness. 0 = deterministic and literal, higher = more varied wording at some cost to focus."}),
                "top_p": ("FLOAT", {"default": 0.9, "min": 0.0, "max": 1.0, "step": 0.01, "tooltip": "Nucleus sampling threshold. Lower = more focused, higher = more varied."}),
                "repetition_penalty": ("FLOAT", {"default": 1.1, "min": 0.5, "max": 2.0, "step": 0.01, "tooltip": "Penalizes tokens the model has already used. 1.0 = no penalty."}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 2**32 - 1, "tooltip": "Sampling seed."}),
            },
        }

    RETURN_TYPES = tuple(["STRING"] * MAX_SEGMENTS)
    RETURN_NAMES = tuple(f"segment_{i}" for i in range(1, MAX_SEGMENTS + 1))
    FUNCTION = "run"
    CATEGORY = "LC Vision"
    DESCRIPTION = (
        "Plans a video as N independently-generated segments in one LLM call, so each "
        "segment is a self-contained MiniMax H3 prompt while the whole arc stays continuous."
    )

    def run(
        self,
        vision_model: LCVisionModel,
        story: str,
        preset: str,
        length_seconds: float,
        segments: int,
        custom_system_prompt: str = "",
        style_tag: str = "None",
        reference_image_1=None,
        reference_image_2=None,
        reference_image_3=None,
        reference_image_4=None,
        reference_video=None,
        video_max_frames: int = 8,
        max_image_side: int = 768,
        jpeg_quality: int = 90,
        end_pad_seconds: float = 0.5,
        max_tokens: int = 4096,
        temperature: float = 0.7,
        top_p: float = 0.9,
        repetition_penalty: float = 1.1,
        seed: int = 0,
    ) -> tuple:
        if vision_model is None or getattr(vision_model, "llm", None) is None:
            raise ValueError("[LC Vision] Moviemaker received no model -- connect an LC Vision Loader.")

        references = [reference_image_1, reference_image_2, reference_image_3, reference_image_4]
        reference_count = sum(1 for r in references if r is not None)
        has_video = reference_video is not None

        if preset == CUSTOM_PRESET_LABEL:
            preset_system_text = custom_system_prompt.strip()
            if not preset_system_text:
                raise ValueError("[LC Vision] preset is 'Custom' but custom_system_prompt is empty -- provide a system prompt or pick a preset.")
        else:
            presets = _load_presets()
            preset_entry = presets.get(preset)
            if not preset_entry:
                raise ValueError(f"[LC Vision] Preset '{preset}' not found in lc_vision_moviemaker_presets.json.")
            preset_system_text = preset_entry["system_prompt"]
            if preset_entry.get("needs_reference") and not reference_count:
                print(f"[LC Vision] Warning: preset '{preset}' expects reference image(s), but none were connected.")

        segments = max(1, min(MAX_SEGMENTS, int(segments)))
        # LLMs consistently undershoot a stated duration -- rather than describe the
        # real length_seconds and hope the model's own pacing lands on it, plan
        # against a slightly shorter number so its natural undershoot lands close
        # to the real target instead of well short of it. Applied to the total (not
        # per-segment) so it shrinks every segment proportionally and the clock math
        # in _base_instructions/_segment_issues stays internally consistent -- the
        # model is never shown a number our own validation doesn't also use.
        planned_length = max(1.0, length_seconds - max(0.0, end_pad_seconds))
        segment_length = planned_length / segments

        system_prompt = _base_instructions(segments, planned_length, segment_length, reference_count, has_video) + "\n\n" + preset_system_text

        content: list[dict] = [{"type": "text", "text": story.strip() or "Plan a scene."}]
        for idx, ref in enumerate(references, start=1):
            if ref is None:
                continue
            frames = _image_input_to_base64_list(ref, max_image_side, jpeg_quality)
            if not frames:
                continue
            content.append({"type": "text", "text": f"\n<Reference {idx}>"})
            for b64 in frames:
                content.append({"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}})

        if reference_video is not None:
            all_frames = _image_input_to_base64_list(reference_video, max_image_side, jpeg_quality)
            if all_frames:
                keep = _sample_indices(len(all_frames), video_max_frames)
                content.append({"type": "text", "text": f"\n<Target Video> ({len(keep)} of {len(all_frames)} frames)"})
                for i in keep:
                    content.append({"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{all_frames[i]}"}})

        content = apply_style_tag_to_content(content, style_tag)

        effective_content = content
        if getattr(vision_model, "is_qwen3_family", False):
            effective_content = [{"type": "text", "text": "/no_think"}] + content

        def _call(sys_prompt, user_content, temp, seed_val):
            response = generate_with_recovery(
                vision_model,
                messages=[
                    {"role": "system", "content": sys_prompt},
                    {"role": "user", "content": user_content},
                ],
                max_tokens=max_tokens,
                temperature=temp,
                top_p=top_p,
                repeat_penalty=repetition_penalty,
                seed=seed_val,
            )
            if not response or "choices" not in response or not response["choices"]:
                raise RuntimeError("[LC Vision] Model returned an empty response.")
            return (response["choices"][0].get("message", {}).get("content", "") or "").strip()

        raw = _call(system_prompt, effective_content, temperature, seed)
        parsed = _parse_segments(raw, segments)

        issues = _segment_issues(parsed, segment_length)
        if issues:
            print(f"[LC Vision] Moviemaker: issues on first pass ({'; '.join(issues)}); retrying once.")
            retry_system = system_prompt + (
                "\n\nYour previous response had specific problems: " + "; ".join(issues) + ". "
                "Fix exactly these problems this time -- every segment from 1 through the total "
                "must be present with its own ###SEGMENT_N### marker, cover close to its full "
                "duration, and advance the story rather than repeating an earlier segment."
            )
            raw_retry = _call(retry_system, effective_content, max(0.2, temperature - 0.2), seed + 1)
            parsed_retry = _parse_segments(raw_retry, segments)
            parsed = _merge_best_segments(parsed, parsed_retry)

        # The model plans each segment on its own local 0.00-based clock (see rule 1
        # in _base_instructions) -- shift each one onto the global timeline here,
        # deterministically, rather than asking the model to track running totals.
        parsed = [_shift_timestamps(seg, segment_length * i) for i, seg in enumerate(parsed)]

        padded = list(parsed) + [""] * (MAX_SEGMENTS - len(parsed))
        return tuple(padded[:MAX_SEGMENTS])


NODE_CLASS_MAPPINGS = {
    NODE_ID: LCVisionMoviemaker,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_ID: NODE_DISPLAY_NAME,
}
