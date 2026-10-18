"""
LC Vision Showrunner
------------------
Plans a long MiniMax H3 video as a chain of short segments, each generated in
its own queue run and seeded from the end of the one before (the LC_AV
segment nodes do the generating). Moviemaker plans independent clips; the
Showrunner plans a chain, which changes the rules:

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
NODE_DISPLAY_NAME = "LC Vision Showrunner (BETA) 🎬"

PLAN_TYPE = "LC_H3_PLAN"
MAX_SEGMENTS = 60
FPS = 24
WORDS_PER_SECOND = 2.5
MAX_EXTENDED_S = 10.0  # extend_segments: the longest a long-line segment gets (H3 trained to about 15 s, VRAM grows)

_STYLE_RE = re.compile(r"###STYLE###\s*(.*?)(?=###SEGMENT_\d+###|\Z)", re.DOTALL)
_SEG_RE = re.compile(r"###SEGMENT_(\d+)###[ \t]*\[?(CUT|CONTINUE)?\]?[ \t]*\n?(.*?)(?=###SEGMENT_\d+###|\Z)", re.DOTALL | re.IGNORECASE)
_ROLL_RE = re.compile(r"\bthe camera keeps rolling\b", re.I)  # a Shot List shot that carries straight on (no cut)
_CUT_RE = re.compile(r"\bcuts?\s+(?:back\s+)?to\b|\bscene\s+\d+\b|\blater\s+that\b|\bthe\s+next\s+(?:day|morning)\b", re.I)
_LEAD_RE = re.compile(r"[\s\"“”'(\[*_-]*(?:(?:and|then|suddenly|meanwhile),?\s+)?", re.I)  # what may come before a sentence-opening cut
_QUOTE_RE = re.compile(r"[\"“](.+?)[\"”]", re.DOTALL)
_MOUTH_RE = re.compile(r",?\s*(?:with\s+)?(?:(?:his|her|their)\s+)?(?:mouth|lips)\s+(?:slightly\s+)?(?:open|opening|parted|parting)"
                       r"(?:\s+(?:as if about to speak|in [^,.;]+))?|,?\s*as if about to speak", re.I)


def snap_frames(seconds: float, minimum: int = 5) -> int:
    """H3 frame counts sit on a 17k+5 grid."""
    k = max(0, round((seconds * FPS - 5) / 17))
    return max(minimum, 17 * k + 5)


def _line_need(action: str) -> float:
    """Seconds the longest quoted line needs, with a second of room around it (0 when there is no line)."""
    words = max((len(q.split()) for q in _QUOTE_RE.findall(action or "")), default=0)
    return words / WORDS_PER_SECOND + 1.0 if words else 0.0


def shot_frames(action: str, cont: bool, seg_frames: int, overlap_frames: int, extend: bool) -> int:
    """The segment length for one shot: the project's, or (extend) long enough for its line, up to MAX_EXTENDED_S."""
    base_new = (seg_frames - (overlap_frames if cont else 0)) / FPS
    need = _line_need(action)
    if not extend or need <= base_new:
        return seg_frames
    want = min(MAX_EXTENDED_S, need) + (overlap_frames / FPS if cont else 0.0)
    return max(seg_frames, snap_frames(want))


_AT_RE = re.compile(r"This shot is at ([^.]+)\.", re.I)


_CAST_RE = re.compile(r"\b([A-Z][a-z]+),\s+an?\s+(man|woman|boy|girl|guy|lady)\b")
_GROUP_RE = re.compile(r"\b(both|two|them|couple|together|everyone|all of them|three|group)\b", re.I)
_SAY_RE = r"(speaks|says|talks|whispers|murmurs|replies|answers|calls out|continues|adds)"


def _solo_line(action: str, names: list) -> bool:
    """True when the Camera line frames one person."""
    cam = next((ln for ln in str(action or "").split("\n") if ln.strip().lower().startswith("camera:")), "")
    if not cam or _GROUP_RE.search(cam):
        return False
    hits = [n for n in names if re.search(rf"\b{re.escape(n)}\b", cam)]
    return len(hits) == 1 or (not hits and len(re.findall(r"\bthe (man|woman|girl|boy|guy|lady)\b", cam, re.I)) == 1)


def solo_speech(plan: dict) -> bool:
    """One person in the frame talks to nobody we can see: "he speaks to her" makes H3 bring her in. Outside the quoted
    line, "says to her / speaks to Claire" becomes "says / speaks" and "tells her" becomes "says". True when anything
    changed."""
    names = [m.group(1) for m in _CAST_RE.finditer(plan.get("story", ""))]
    who = "|".join(["her", "him", "them", r"the (?:man|woman|other person|others)"] + [re.escape(n) for n in names])
    to_re = re.compile(rf"\b{_SAY_RE}((?:\s+\w+ly)?)\s+(?:to|at|toward|towards)\s+(?:{who})\b")
    tell_re = re.compile(rf"\b(tells|asks)\s+(?:{who})\b")
    changed = False
    for s in plan.get("shots", []):
        a = s.get("action", "")
        if not _solo_line(a, names):
            continue
        parts = re.split(r"([\"“][^\"”]*[\"”])", a)  # quoted lines stay as written
        for k in range(0, len(parts), 2):
            p = to_re.sub(lambda m: m.group(1) + m.group(2), parts[k])
            parts[k] = tell_re.sub(lambda m: "says" if m.group(1) == "tells" else "asks", p)
        new = "".join(parts)
        if new != a:
            s["action"] = new
            changed = True
    return changed


_SAYS_RE = re.compile(r"\b([A-Z][a-z]+|Someone) says [\"“](.+?)[\"”]")


def restore_lines(story: str, shots: list, warnings: list | None = None) -> bool:
    """A Shot List story fixes which shot says which line. When the planner drops one, put it back at the start of
    that shot's first segment ("At 0.50 seconds, Vince says "..."") instead of only warning, and drop the warning.
    Skipped when that segment already has a quoted line. True when anything changed."""
    sl = _shot_list(story, len(shots))
    if not sl:
        return False
    chunks, spans = sl
    everything = _norm(" ".join(s.get("action", "") for s in shots))
    changed, first = False, 0
    for chunk, span in zip(chunks, spans):
        for m in _SAYS_RE.finditer(chunk):
            who, line = m.group(1), m.group(2).strip()
            s = shots[first] if first < len(shots) else None
            if not s or not _norm(line) or _norm(line) in everything or _QUOTE_RE.search(s.get("action", "")):
                continue
            head, sep, body = s["action"].partition("\n\n")
            said = f"At 0.50 seconds, {who} says \"{line}\""
            # after a 0.00 opening beat, so the clock still reads in order
            m0 = re.match(r"(At 0(?:\.0+)? seconds,[^.!?]*[.!?])\s*", body)
            body = f"{m0.group(1)} {said} {body[m0.end():]}" if m0 else f"{said} {body}"
            s["action"] = f"{head}\n\n{body}".rstrip() if sep else f"{s['action']}\n\n{said}"
            s["action"] = re.sub(r"Nobody speaks\.?", "The only voice is the quoted line.", s["action"])
            everything = _norm(" ".join(x.get("action", "") for x in shots))
            if warnings is not None:
                warnings[:] = [w for w in warnings if line not in w]
            changed = True
        first += span
    return changed


class LockedPlan(ValueError):
    """The plan would be written again over segments locked on the Proof Sheet."""


def tag_places(plan: dict) -> bool:
    """A Shot List story says where each shot is ("This shot is at the bank lobby."). Each segment keeps that name
    (place_name), so LC H3 Segment groups a place's shots exactly instead of guessing from the Place line's wording.
    True when anything changed."""
    sl = _shot_list(plan.get("story", ""), len(plan.get("shots", [])))
    if not sl:
        return False
    chunks, spans = sl
    names, here = [], ""
    for chunk, span in zip(chunks, spans):
        m = _AT_RE.search(chunk)
        here = m.group(1).strip() if m else here
        names += [here] * span
    changed = False
    for s, name in zip(plan.get("shots", []), names):
        if name and s.get("place_name") != name:
            s["place_name"] = name
            changed = True
    return changed


def apply_extend(plan: dict, extend: bool) -> bool:
    """Per-shot lengths and start times for a plan (a saved one too). True when anything changed."""
    seg_frames = plan.get("segment_frames") or snap_frames(plan.get("segment_s", 5.0))
    ovl = plan.get("overlap_frames") or snap_frames(plan.get("overlap_s", 1.6))
    changed, end = False, 0.0
    for s in plan.get("shots", []):
        cont = s.get("mode") == "CONTINUE"
        f = shot_frames(s.get("action", ""), cont, seg_frames, ovl, extend)
        if f != seg_frames:
            changed |= s.get("frames") != f
            s["frames"] = f
        elif "frames" in s:
            s.pop("frames")
            changed = True
        start = round(end - plan.get("overlap_s", ovl / FPS), 3) if cont else round(end, 3)
        changed |= s.get("start_s") != start
        s["start_s"] = start
        end = start + f / FPS
    if extend:
        keep = []
        for w in plan.get("warnings", []):
            m = re.match(r"segment (\d+)'s line is too long", w)
            if m and int(m.group(1)) <= len(plan["shots"]):
                sh = plan["shots"][int(m.group(1)) - 1]
                if _line_need(sh.get("action", "")) <= MAX_EXTENDED_S:
                    continue  # it got its own longer segment
            keep.append(w)
        changed |= len(keep) != len(plan.get("warnings", []))
        plan["warnings"] = keep
    return changed


_OLD_PLAN_DIR = "old_plan_"


def _set_aside_old_renders(folder: str) -> int:
    """A new plan in a folder that already has renders: those were made for the old plan (other shots, other
    lengths), and LC H3 Segment would take them as done. Move them (never delete) to takes/old_plan_<time>/."""
    import shutil

    if not os.path.isdir(folder):
        return 0
    name = os.path.basename(folder)
    pick = lambda d, top: [os.path.join(d, f) for f in os.listdir(d) if os.path.isfile(os.path.join(d, f)) and (  # noqa: E731
        re.match(r"seg_\d{3}", f) or f.startswith("cast_") or f.startswith(name + "_full") or f == "seams.json"
    )] if os.path.isdir(d) else []  # finished movies at the top always stay put
    old = pick(folder, True) + pick(os.path.join(folder, "work"), False) + pick(os.path.join(folder, "takes"), False)
    segs = len({os.path.basename(f)[:7] for f in old if os.path.basename(f).startswith("seg_") and f.endswith(".json")})
    if not segs:
        return 0
    dest = os.path.join(folder, "takes", _OLD_PLAN_DIR + time.strftime("%Y%m%d_%H%M%S"))
    os.makedirs(dest, exist_ok=True)
    for f in old:
        shutil.move(f, os.path.join(dest, os.path.basename(f)))
    print(f"[LC Vision] Showrunner: new plan, so the {segs} segments of the old one moved to {dest}.")
    return segs


def project_dir(project: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9 _.-]", "_", project.strip())
    if not safe.strip(" ."):  # "" / "." / ".." would be LC_H3 itself or the output folder
        safe = "untitled"
    return os.path.join(folder_paths.get_output_directory(), "LC_H3", safe)


def _instructions(segments: int, seg_s: float, new_s: float, overlap_s: float, reference_count: int) -> str:
    text = (
        f"You are directing a {segments}-segment video. Each segment is a separate {seg_s:.2f}-second "
        f"generation by a video renderer that remembers nothing between calls. The segments are "
        f"joined afterwards, so you plan the whole story at once and write each segment as its own "
        f"prompt.\n\n"
        f"First write a STYLE block, once. It describes what never changes: every person on screen "
        f"(face, hair, build, clothing, distinguishing details), each starting with their name from the story "
        f"(\"Vince: a tall man ...; Maya: a young woman ...\") and ending with a semicolon, then the camera style and "
        f"the visual style. "
        f"It does NOT describe the place or the light, because the story can move. It is pasted word "
        f"for word in front of every segment, so the segments themselves must NOT describe anyone's "
        f"appearance again.\n\n"
        f"Every segment starts with one line \"Place: ...\" saying where it happens, the time of day and the "
        f"light there (for example \"Place: a snowy city street at night, neon signs reflecting on wet "
        f"pavement.\" or \"Place: inside a small cafe at night, warm pendant lights, dark snowy street "
        f"outside the windows.\"). The time of day carries over when the place changes (going indoors at "
        f"night stays night, and windows show it). It also says who is there besides the cast: the bystanders any "
        f"shot at that place shows (customers in line, diners, people on the sidewalk), from the FIRST segment at "
        f"that place, so nobody appears out of nowhere after a cut. Never the camera on this line. Keep that line "
        f"word for word the same while the story stays in one place, and change it the moment the story moves "
        f"somewhere else. Then the action.\n\n"
        f"The video is ONE continuous take. Write every segment, tagged CUT or CONTINUE:\n"
        f"- CONTINUE: the camera keeps rolling. The renderer is shown the last {overlap_s:.2f} seconds "
        f"of the previous segment, so this segment picks up exactly where the previous one ended: "
        f"same pose, same position, same camera. Plan {new_s:.2f} seconds of NEW action on a local "
        f"clock from 0.00 to {new_s:.2f} seconds.\n"
        f"- CUT: only where the story itself says so (\"cut to ...\"). Every \"cut to\" in the story starts a NEW "
        f"segment at exactly that point, with the framing it names on the Camera line. Plan {seg_s:.2f} seconds of "
        f"action on a local clock from 0.00 to {seg_s:.2f} seconds.\n"
        f"- Segment 1 is CUT. Every other segment is CONTINUE unless the story writes a cut at that point. "
        f"Moving to a new place (walking into a cafe) happens inside the take, not with a cut.\n\n"
        f"Staging: the camera leads the main person, so their face stays visible to the camera most of "
        f"the time. Never write them walking away from the camera. Going through a door: the camera is "
        f"already inside, facing the door, and they walk in toward it (or the camera turns with them as "
        f"they enter), so their face is seen as they come through. Another person (a barista, a friend, a "
        f"waiter) stays in their own spot (behind the counter, at their table) and never walks over to the main "
        f"person. Like the door: the camera is already on the far side (behind the counter, next to the "
        f"barista), facing the way the main person comes, so they walk up toward the camera and stay facing it "
        f"while they talk or are handed something (for example \"she walks up to the counter toward the camera "
        f"and smiles at the barista beside it, who hands her the mug\"). The camera never moves to a new angle "
        f"for this. Only the object on the Holding line changes hands, nothing else (no trays, no plates).\n\n"
        f"Objects: the STYLE block never mentions objects people pick up or are handed, because it goes into "
        f"every segment. Instead, the second line of every segment is \"Holding: ...\": \"Holding: nothing\" "
        f"until the story gives the main person something, then the object with its material, color and "
        f"shape (for example \"Holding: a white ceramic mug of hot chocolate with a saucer\"), word for word "
        f"the same in every later segment, until they put it down.\n\n"
        f"Add nothing the story doesn't do: a gun is never fired, a trigger never pulled, nobody is hit, unless the "
        f"story says so. Clothing that changes in the story (a mask pulled on, a hood put up) is described in the "
        f"segment where it changes, saying how it starts and how it ends. When a crowd or bystanders react (duck, "
        f"run, scream), name the cast in that shot and say what they do instead (\"Vince stands with his pistol "
        f"raised while the customers drop to the floor\"), or the renderer has them react too.\n\n"
        f"Sound: the third line of every segment is \"Sound: ...\", the soft background ambience of that place "
        f"in a few words (for example \"Sound: a quiet snowy street at night, soft distant traffic.\" or "
        f"\"Sound: the soft hum of a quiet cafe.\"). Keep it low-key: no list of separate noises (footsteps, "
        f"clinks, taps), because named sounds take over the quiet moments; name one only when it is the point "
        f"of the moment. Never music, voices, chatter, crowds or singing. End it "
        f"with \"No music. The only voice is the quoted line.\" in a segment with a quoted line, or \"No music. Nobody "
        f"speaks.\" in every other segment. Keep it word for word the same while the place stays the same. "
        f"The renderer makes up talking whenever a mouth moves, so outside a quoted line nobody's mouth "
        f"moves: closed-mouth smiles only, no sighs, no lip movements, no muttering, no sipping. In a segment without "
        f"a quoted line nobody eats, chews or drinks on screen either: they hold the fork or the glass, mouths closed. "
        f"In a shot of one person the line has no listener: write \"he says\", never \"he says to her\" (it brings "
        f"her into the frame).\n\n"
        f"Camera: the fourth line of every segment is \"Camera: ...\", the shot size and angle (for example "
        f"\"Camera: wide side view of both at the table, at table height.\", \"Camera: close-up of the man, framed "
        f"from the chest up.\" or \"Camera: slow push-in on the two of them.\"). Take it from the story whenever the "
        f"story says how the shot looks. Keep it word for word the same while the shot stays the same; a CUT gets "
        f"the framing the story names; a camera move the story names goes on this line. A CONTINUE segment keeps "
        f"the framing of the segment before it (a slow camera move is fine); only a CUT changes the shot.\n\n"
        f"Rules for every segment:\n"
        f"0) FOLLOW THE STORY'S ORDER: events happen in the order the story gives them, and a quoted "
        f"line belongs at the exact moment the story puts it. If the story runs out before the last "
        f"segment, slow it down (smaller steps, reactions) rather than inventing new people or events.\n"
        f"1) Use explicit local timestamps (\"at 0.00 seconds ...\", \"at 1.50 seconds ...\"), several "
        f"beats spread over the segment's span.\n"
        f"2) ACTION NEVER REPEATS: always move forward from exactly where the previous segment ended. "
        f"Track where each person is; someone who left the frame stays out or visibly re-enters. "
        f"Something that already happened (an arrival, a hug) never happens again from scratch.\n"
        f"3) END FLOWING: in the last second the movement eases but keeps going (a slow step, a turn of "
        f"the head); the main person stays in frame, face to the camera where it fits. No new action "
        f"starts in that last second, and nobody freezes and stares at the camera.\n"
        f"4) DIALOGUE: at most one quoted line per segment, said once, verbatim, in quotes, inside an "
        f"explicit short time window that finishes before the last second. A sentence is never split "
        f"across two segments. Keep a line to about {WORDS_PER_SECOND:g} words per second of its "
        f"window. No other mouth business (sighing, sipping, muttering) in a segment with a line.\n"
        f"5) Say what happens, never what does not happen (no \"without\", \"no\", \"doesn't\").\n"
        f"6) Plain scene description only: never mention segments, cuts, overlap, stitching or "
        f"timing schemes in the text.\n"
        f"7) ONLY WHAT YOU ARE GIVEN: never invent names, extra people, animals, objects, relationships, "
        f"dialogue or events that are not in the story or the pictures. Quoted lines come only from the story, "
        f"word for word. Call people what the story calls them, or \"the woman\", \"the man\" when it names no one. "
        f"Where the story says little, only small motion fits (breathing, blinking, a glance, a shift of weight, "
        f"hair or a coat moving in the wind), never a new activity.\n\n"
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


def _shot_list(story: str, segments: int):
    """A story written as a shot list ("... Cut to a close-up of Daniel. ... Cut back to ..."): the story split at
    every cut, and how many segments each shot gets (at least one; spare segments go to the longest shots). None
    when the story has no cut or more shots than segments."""
    marks = sorted([m.start() for m in _CUT_RE.finditer(story)] + [m.start() for m in _ROLL_RE.finditer(story)])
    if not marks:
        return None
    # sentence starts outside quotes ("They let me go today. Twelve years..." is one line, not two sentences)
    bounds, in_q = [0], False
    for k, ch in enumerate(story):
        if ch in "\"“”":
            in_q = not in_q
            if not in_q and k > 0 and story[k - 1] in ".!?":
                bounds.append(k + 1)
        elif ch in ".!?\n" and not in_q:
            bounds.append(k + 1)
    # each cut starts its own shot, but only a cut that opens its sentence ("Cut to the van." / "Then the next day...");
    # "she says she'll call him the next day" inside an action stays in its shot
    starts = [0]
    for pos in marks:
        b = max(b for b in bounds if b <= pos)
        if _LEAD_RE.fullmatch(story[b:pos]):
            starts.append(b)
    starts = sorted(set(starts))
    if len(starts) < 2:
        return None
    chunks = [story[a:b].strip() for a, b in zip(starts, starts[1:] + [len(story)]) if story[a:b].strip()]
    if len(chunks) > segments:
        return None
    spans = [1] * len(chunks)
    for _ in range(segments - len(chunks)):
        # the shot with the most words per segment gets the next spare segment
        k = max(range(len(chunks)), key=lambda i: len(chunks[i].split()) / spans[i])
        spans[k] += 1
    return chunks, spans


def _shot_modes(story: str, segments: int):
    """CUT / CONTINUE per segment from the story's shot list, or None."""
    sl = _shot_list(story, segments)
    if not sl:
        return None
    modes = []
    for k, (chunk, span) in enumerate(zip(*sl)):
        rolls = k > 0 and _ROLL_RE.match(chunk.strip())  # "The camera keeps rolling ...": no cut into this shot
        modes += ["CONTINUE" if rolls else "CUT"] + ["CONTINUE"] * (span - 1)
    return modes


def _beat_map(story: str, segments: int) -> str:
    """The story's sentences spread evenly over the segments ("Segments 3-4: ..."). Left alone, a model rushes the
    first half of a story into two segments and then stalls for ten on the last event."""
    # split on sentence ends that are not inside quotes
    sentences, buf, in_q = [], "", False
    for ch in story.strip():
        buf += ch
        if ch in "\"“”":
            in_q = not in_q
            if not in_q and len(buf) > 1 and buf[-2] in ".!?":  # a sentence that ends inside its closing quote
                sentences.append(buf.strip())
                buf = ""
            continue
        if ch in ".!?" and not in_q:
            if buf.strip():
                sentences.append(buf.strip())
            buf = ""
    if buf.strip():
        sentences.append(buf.strip())
    sentences = [x for x in sentences if len(x) > 3]
    sl = _shot_list(story, segments)
    if sl:
        lines, start = [], 1
        for chunk, span in zip(*sl):
            end = start + span - 1
            tag = "CUT" if span == 1 else f"CUT, then {span - 1} CONTINUE"
            lines.append(f"Segment {start} ({tag}): {chunk}" if span == 1 else f"Segments {start}-{end} ({tag}): {chunk}")
            start = end + 1
        return "\n".join(lines)
    if len(sentences) < 2 or segments < 2:
        return ""
    lines = []
    if len(sentences) <= segments:
        base, extra = divmod(segments, len(sentences))
        start = 1
        for k, sent in enumerate(sentences):
            span = base + (1 if k < extra else 0)
            end = start + span - 1
            lines.append(f"Segment {start}: {sent}" if span == 1 else f"Segments {start}-{end}: {sent}")
            start = end + 1
    else:
        per = len(sentences) / segments
        for k in range(segments):
            chunk = sentences[int(round(k * per)):int(round((k + 1) * per))]
            lines.append(f"Segment {k + 1}: {' '.join(chunk)}")
    return "\n".join(lines)


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


_LABEL_START = re.compile(r"[ \t]*\b(Place|Holding|Sound|Camera)\s*:\s*", re.I)
_SOUND_TAIL = re.compile(r"(no music|nobody speaks|the only voice|no voices|no dialogue|no other)", re.I)


def _sentences(text: str) -> list:
    """Split at sentence ends outside quotes, so a line of dialogue ("Hey. Look at me.") stays in one piece."""
    out, cur, depth = [], "", False
    i = 0
    while i < len(text):
        ch = text[i]
        cur += ch
        if ch in "\u201c\u201d\"":
            depth = ch == "\u201c" or (ch == '"' and not depth)
        closed = ch in "”\"" and not depth and len(cur) > 1 and cur[-2] in ".!?"  # 'me." He nods'
        if (ch in ".!?" or closed) and not depth:
            m = re.match(r"\s+(?=[A-Z\u201c\"])", text[i + 1:])
            if m:
                out.append(cur.strip())
                cur = ""
                i += len(m.group(0))
        i += 1
    if cur.strip():
        out.append(cur.strip())
    return out


def _camera_split(rest: str):
    """A Camera line says where the camera is. When the model put the action or a line of dialogue on it ("slow
    push-in as Claire says: ..."), the camera part stays and the rest goes to the action."""
    q = re.search(r"[\u201c\"]", rest)
    if not q:
        return rest, ""
    head = rest[:q.start()]
    m = list(re.finditer(r"\s+(?:as|while|when)\s+", head))
    cut = m[-1] if m else None
    if not cut:
        return rest, ""
    return rest[:cut.start()].rstrip(" ,;:") + ".", rest[cut.end():].strip()


def _label_lines(text: str) -> str:
    """Place / Holding / Sound each on their own line and the action as its own paragraph, even when the model
    wrote a whole segment on one line. Otherwise "Place: same as before" (which replaces its whole line) replaced
    the entire segment with the previous one."""
    t = _LABEL_START.sub(lambda m: "\n" + m.group(1).capitalize() + ": ", text).strip()
    out, action = [], []
    for line in t.split("\n"):
        m = re.match(r"(Place|Holding|Sound|Camera): (.*)", line)
        if not m:
            action.append(line)
            continue
        label, rest = m.group(1), m.group(2).strip()
        moved = ""
        if label == "Camera":
            rest, moved = _camera_split(rest)
        sentences = _sentences(rest) or [rest]
        keep = [sentences[0]]
        for sent in sentences[1:]:
            if label == "Sound" and _SOUND_TAIL.match(sent) and len(keep) == len(sentences[:len(keep)]):
                keep.append(sent)
            else:
                break
        out.append(f"{label}: {' '.join(keep).strip()}")
        leftover = " ".join(sentences[len(keep):] + ([moved[:1].upper() + moved[1:]] if moved else [])).strip()
        if leftover:
            action.append(leftover)
    body = "\n".join(x for x in action if x.strip()).strip()
    if not body:  # the whole action went on the Camera line ("pushing in as Claire takes his hand"): move it down
        for k, ln in enumerate(out):
            m = re.match(r"Camera: (.*?),?\s+(?:as|while|when)\s+((?:[A-Z][a-z]+|he|she|they|his|her|their)\b.*)$", ln)
            if m:
                out[k] = f"Camera: {m.group(1).rstrip(' ,;')}."
                body = m.group(2)[:1].upper() + m.group(2)[1:]
                break
    return ("\n".join(out) + ("\n\n" + body if body else "")).strip() if out else text.strip()


def _timed(text: str, start: float, span: float) -> str:
    """A segment whose action has no "At X.XX seconds" beats (the model wrote plain sentences): spread its sentences
    over the segment, from start (0, or the overlap on a CONTINUE) to near the end."""
    t = _label_lines(text)
    head, body = (t.split("\n\n", 1) + [""])[:2] if "\n\n" in t else (t, "")
    if not body.strip() or re.search(r"\bat \d+(?:\.\d+)? seconds", body, re.I):
        return text
    parts = [x.strip() for x in _sentences(body) for x in re.split(r";\s+(?=[^\u201d\"]*(?:[\u201c\"]|$))", x) if x.strip()]
    step = max(0.5, (span - 0.6 - start) / max(1, len(parts)))
    beats = []
    for k, x in enumerate(parts):
        if x.split()[0] in ("He", "She", "They", "The", "A", "An", "His", "Her", "Their", "It", "Both"):  # names keep their capital
            x = x[:1].lower() + x[1:]
        x = x.rstrip(" ;") + ("" if x.rstrip().endswith((".", "!", "?", "\u201d", '"')) else ".")
        beats.append(f"At {start + k * step:.2f} seconds, {x}")
    return head + "\n\n" + " ".join(beats)


def _action_of(text: str) -> str:
    """The timed action of a segment: everything after the Place / Holding / Sound / Camera lines."""
    t = _label_lines(text)
    return t.split("\n\n", 1)[1] if "\n\n" in t else ("" if re.match(r"\s*(place|holding|sound|camera)\s*:", t, re.I) else t)


def _norm(text: str) -> str:
    return re.sub(r"[^a-z0-9 ]", "", text.lower()).strip()


def _issues(style: str, shots: list, seg_s: float, new_s: float, story: str = "", extend: bool = False) -> list:
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
            if extend and len(line.split()) / WORDS_PER_SECOND + 1.0 <= MAX_EXTENDED_S:
                continue  # extend_segments gives it a longer segment instead
            if len(line.split()) > WORDS_PER_SECOND * max(1.0, span - 1.0):
                out.append(f"segment {i}'s line is too long for {span:.2f} seconds; shorten it")
    for i in range(len(shots) - 1):
        # compare without the "at X.XX seconds" scaffolding, which every segment shares
        # and without the four label lines, which neighbours share on purpose
        a, b = (re.sub(r"at \d+(?:\.\d+)? seconds,?", "", _action_of(s["action"]), flags=re.I) for s in shots[i:i + 2])
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


def _fix_next_join(vision_model, plan: dict, seed: int = 0):
    """Before the next CONTINUE segment is made: look at how the segment before it really ended and rewrite its
    opening to start from there, so H3 doesn't snap the pose at the join (what LC Vision Redirect did as its own
    node). Saved into plan.json with the ending it was made from, and reused until that ending changes."""
    from .lc_vision_redirect import LCVisionRedirect, _resolve_index, _seg_path

    shots = plan.get("shots") or []
    if not shots:
        return plan, ""
    i = _resolve_index(plan, 0)
    if i == 1 or shots[i - 1].get("mode") != "CONTINUE":
        return plan, ""
    if shots[i - 1].get("locked"):  # every segment made: index 0 lands on the last one, whose words a lock keeps
        return plan, ""
    if not os.path.exists(_seg_path(project_dir(plan.get("project", "")), i - 1, "_tail.mp4")):
        return plan, ""
    try:
        return LCVisionRedirect()._run(vision_model, plan, 0, True, seed=seed)
    except Exception as exc:
        print(f"[LC Vision] Showrunner: could not check the join before segment {i} ({exc}), keeping the plan's text.")
        return plan, ""


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
                "segments": ("INT", {"default": 3, "min": 1, "max": MAX_SEGMENTS, "tooltip": "How many segments. With 5 s segments the first one is 5 s and each CONTINUE adds about 3.5 s (the overlap is shared): 12 segments is about 44 s, about 16 make a minute."}),
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
                "extend_segments": ("BOOLEAN", {"default": True, "tooltip": "A shot with a long line gets its own longer segment (up to 10 s) instead of a warning to shorten the line. Off: every segment is segment_seconds long."}),
            },
        }

    RETURN_TYPES = (PLAN_TYPE, "STRING", "STRING")
    RETURN_NAMES = ("plan", "plan_text", "project_name")
    FUNCTION = "run"
    CATEGORY = "LC Vision"
    DESCRIPTION = ("Plans a long MiniMax H3 video as a chain of short CUT / CONTINUE segments with one shared style block. "
                   "Saves the plan to the project folder and reuses it.")

    @classmethod
    def IS_CHANGED(cls, project="", replan=False, **kwargs):
        if replan or not isinstance(project, str):  # a project name on a wire isn't handed to IS_CHANGED
            return float("nan")
        folder = project_dir(project)
        path = os.path.join(folder, "plan.json")
        # the newest saved segment ending too: a new one means the next CONTINUE may need its opening fixed
        dirs = [folder, os.path.join(folder, "takes"), os.path.join(folder, "work")]
        tails = [os.path.getmtime(os.path.join(d, f)) for d in dirs if os.path.isdir(d) for f in os.listdir(d) if re.match(r"seg_\d{3}_tail\.mp4$", f)]
        return f"{os.path.getmtime(path) if os.path.exists(path) else ''}:{max(tails, default=0)}"

    def run(self, *args, **kwargs):
        try:
            return self._run(*args, **kwargs)
        finally:
            release(kwargs.get("vision_model", args[0] if args else None))

    def _run(self, vision_model: LCVisionModel, *args, seed: int = 0, **kwargs) -> tuple:
        project = str(kwargs.get("project", args[0] if args else "") or "").strip()
        try:
            plan, text = self._plan(vision_model, *args, seed=seed, **kwargs)
        except LockedPlan as exc:
            # not an error: the canvas just holds a different Shot List than the project's plan. Stop quietly and let
            # the browser offer the way out (📂 Load the project's Shot List, or unlock and plan again)
            from comfy_execution.graph import ExecutionBlocker
            msg = str(exc).replace("[LC Vision] Showrunner: ", "")
            try:
                from server import PromptServer
                PromptServer.instance.send_sync("lc_vision_locked_plan", {"project": project, "message": msg},
                                                getattr(PromptServer.instance, "client_id", None))
            except Exception:
                pass
            print(f"[LC Vision] Showrunner: {msg}")
            b = ExecutionBlocker(None)
            return {"ui": {"text": [msg]}, "result": (b, msg, project)}
        plan, notes = _fix_next_join(vision_model, plan, seed)
        return (plan, text + ("\n\n" + notes if notes else ""), project)

    def _plan(self, vision_model: LCVisionModel, project: str, story: str, preset: str, segments: int,
             segment_seconds: float, overlap_seconds: float, replan: bool, custom_system_prompt: str = "",
             style_tag: str = "None", reference_image_1=None, reference_image_2=None, reference_image_3=None,
             reference_image_4=None, max_tokens: int = 8192, temperature: float = 0.7, top_p: float = 0.9,
             repetition_penalty: float = 1.1, seed: int = 0, extend_segments: bool = True) -> tuple:
        if len(str(project)) > 80 or chr(10) in str(project):
            raise ValueError("[LC Vision] Showrunner: project got a long text (the story?). project is the folder name, "
                             "like dinner_scene: wire the story into story, not project.")
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
                    print(f"[LC Vision] Showrunner: reusing the saved plan for '{project}'.")
                    if restore_lines(saved.get("story", ""), saved.get("shots", []), saved.setdefault("warnings", [])) \
                            | apply_extend(saved, extend_segments) | tag_places(saved) | solo_speech(saved):  # switched on or off since the plan was written
                        for s in saved.get("shots", []):
                            if "prompt" in s:
                                s["prompt"] = f"{saved.get('style', '')}\n\n{s['action']}".strip()
                        with open(path, "w", encoding="utf-8") as f:
                            json.dump(saved, f, indent=1, ensure_ascii=False)
                    return (saved, plan_text(saved))
                locked = [k for k, sh in enumerate(saved.get("shots", []), start=1) if sh.get("locked")]
                if locked:  # a new plan sets the renders aside: never over segments you locked
                    raise LockedPlan(f"[LC Vision] Showrunner: '{project}' has locked segments ({', '.join(map(str, locked))}) and "
                                     "the story or timing changed, which would write a new plan over them. Unlock them on the "
                                     "Proof Sheet, or put the Shot List back (↶ Undo there, or 📂 Load the project).")
                print(f"[LC Vision] Showrunner: story or timing changed for '{project}', writing a new plan.")
            except LockedPlan:
                raise
            except Exception as exc:
                print(f"[LC Vision] Showrunner: could not read {path} ({exc}), writing a new plan.")

        if vision_model is None or (getattr(vision_model, "llm", None) is None
                                    and getattr(vision_model, "build_params", None) is None):
            raise ValueError("[LC Vision] Showrunner received no model. Connect an LC Vision Loader.")

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
        beats = _beat_map(story, segments)
        if beats:
            system_prompt += ("\n\nPACING: spread the story evenly over the segments, following this map. Each event "
                              "gets the segments listed for it: slow it down with small steps, glances and reactions "
                              "to fill them, and never jump ahead to a later event early.\n" + beats)
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
                raise RuntimeError("[LC Vision] Showrunner: the model returned an empty response.")
            return strip_thinking(response["choices"][0].get("message", {}).get("content", "") or "")

        parsed = _parse(_call(system_prompt, temperature, seed), segments)
        issues = _issues(parsed[0], parsed[1], seg_s, new_s, story, extend_segments)
        if issues:
            print(f"[LC Vision] Showrunner: issues on the first pass ({'; '.join(issues)}); retrying once.")
            retry_prompt = system_prompt + ("\n\nYour previous plan had these problems: " + "; ".join(issues) +
                                            ". Fix exactly these, keep the same output format, and write every segment.")
            retry = _parse(_call(retry_prompt, max(0.2, temperature - 0.2), seed + 1), segments)
            retry_issues = _issues(retry[0], retry[1], seg_s, new_s, story, extend_segments)
            # a whole plan with fewer problems wins; mixing segments from two plans can lose or double a line
            if len(retry_issues) < len(issues):
                parsed, issues = retry, retry_issues
            elif len(retry_issues) == len(issues):
                merged = _merge(parsed, retry)
                merged_issues = _issues(merged[0], merged[1], seg_s, new_s, story, extend_segments)
                if len(merged_issues) <= len(issues):
                    parsed, issues = merged, merged_issues

        style, raw_shots = parsed
        restore_lines(story, raw_shots, issues)  # a line the planner dropped goes back into its shot
        # each segment is rendered on its own, so "Place: same cafe as before" means nothing to H3: repeat the
        # last full Place line instead
        # the same goes for "Holding: still the same mug" and "Sound: same as before"
        last = {}
        for s in raw_shots:
            s["action"] = _label_lines(s["action"])
            lines = s["action"].split("\n")
            for k, ln in enumerate(lines[:4]):
                m = re.match(r"\s*(place|holding|sound|camera)\s*:\s*(.*)", ln, re.I)
                if not m:
                    continue
                label = m.group(1).lower()
                if label in last and re.match(r"(the\s+)?(same|still)\b", m.group(2), re.I):
                    lines[k] = last[label]
                else:
                    last[label] = ln.strip()
            s["action"] = "\n".join(lines)
            if _QUOTE_RE.search(s["action"]):  # a segment with a line never says "Nobody speaks"
                s["action"] = re.sub(r"Nobody speaks\.?", "The only voice is the quoted line.", s["action"])
            else:  # and one without a line never mentions one, or a mouth about to speak (H3 invents talking)
                s["action"] = re.sub(r"The only voice is the quoted line\.?", "Nobody speaks.", s["action"])
                s["action"] = _MOUTH_RE.sub("", s["action"])
        # a shot list fixes CUT / CONTINUE per segment; otherwise one continuous take with a CUT only where the story
        # writes one ("cut to", "later that night", "scene 2")
        modes = _shot_modes(story, segments)
        if modes:
            for s, mode in zip(raw_shots, modes):
                s["mode"] = mode
        allowed = 0 if modes else len(_CUT_RE.findall(story))
        for k, s in enumerate(raw_shots[1:], start=2) if not modes else []:
            if s["mode"] == "CUT":
                if allowed > 0:
                    allowed -= 1
                else:
                    s["mode"] = "CONTINUE"
                    issues.append(f"segment {k} was planned as a CUT the story doesn't ask for; it continues instead")
        shots, end = [], 0.0
        for i, s in enumerate(raw_shots):
            # a CONTINUE segment's first overlap_s is the held tail: its local clock starts after it,
            # and on the final video it starts overlap_s before the previous segment ends
            cont = s["mode"] == "CONTINUE"
            frames_i = shot_frames(s["action"], cont, seg_frames, overlap_frames, extend_segments)
            len_i = frames_i / FPS
            span_i = len_i - overlap_s if cont else len_i
            action = _timed(s["action"], 0.0, span_i)  # plain sentences get their beats
            action = _fit_clock(action, span_i)
            action = _shift_timestamps(action, overlap_s) if cont else action
            start = end - overlap_s if cont else end
            end = start + len_i
            shot = {"index": i + 1, "mode": s["mode"], "action": action, "start_s": round(start, 3),
                    "prompt": f"{style}\n\n{action}".strip()}
            if frames_i != seg_frames:
                shot["frames"] = frames_i
            shots.append(shot)
        plan = {**key, "version": 1, "project": project, "fps": FPS, "segment_s": seg_s, "overlap_s": overlap_s,
                "style": style, "shots": shots, "warnings": issues, "created": time.strftime("%Y-%m-%d %H:%M:%S")}
        tag_places(plan)
        solo_speech(plan)
        os.makedirs(folder, exist_ok=True)
        moved = _set_aside_old_renders(folder)
        hist = os.path.join(folder, "takes", "history.json")
        if os.path.exists(hist):  # ↶ Undo steps of the old plan (edits, cuts, inserts) would land on the new one
            os.replace(hist, os.path.join(folder, "takes", f"history_old_plan_{time.strftime('%Y%m%d_%H%M%S')}.json"))
        with open(path, "w", encoding="utf-8") as f:
            json.dump(plan, f, indent=1, ensure_ascii=False)
        text = plan_text(plan)
        if moved:
            text = f"⚠️ New plan: the {moved} segments made for the old one were moved to the takes folder, so they can't mix in.\n\n" + text
        return (plan, text)


NODE_CLASS_MAPPINGS = {
    NODE_ID: LCVisionDirector,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_ID: NODE_DISPLAY_NAME,
}
