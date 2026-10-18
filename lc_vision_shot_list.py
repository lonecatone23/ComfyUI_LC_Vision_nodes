"""
LC Vision Shot List: the story for LC Vision Showrunner, filled in like a form instead of written from scratch. A place,
the cast (name, man / woman, look) and one row per shot (framing, camera move, action, who speaks, the line). It writes
the story in the layout the Showrunner reads best: one place sentence, the cast by name, "Cut to ..." for every new shot,
the framing, and at most one short quoted line per shot. No AI involved.

The rows live in one hidden STRING widget (JSON); web/lc_vision_shot_list.js draws the form on top of it.
"""
from __future__ import annotations

import json
import math
import re

WORDS_PER_SECOND = 2.5  # the Showrunner's own speaking-rate rule
SEG_S, CONT_S = 5.17, 3.54  # a 5 s segment, and what each CONTINUE adds after the 1.6 s overlap
MAX_SHOT_S = 10.0  # the Showrunner's extend_segments gives a long shot its own segment up to this long

FRAMINGS = ["wide shot", "side view", "two-shot", "medium shot", "close-up", "extreme close-up", "over the shoulder",
            "from behind", "custom"]
GROUP_FRAMINGS = {"wide shot", "side view", "two-shot"}
MOVES = {
    "still": "",
    "slow push-in": "The camera slowly pushes in.",
    "slow pull back": "The camera slowly pulls back.",
    "pan": "The camera pans slowly with the action.",
    "tracking": "The camera tracks alongside.",
    "orbit": "The camera slowly circles around them.",
    "handheld": "Handheld camera, slight natural movement.",
}

EXAMPLE = {
    "place": "Evening in a warm, modern city apartment: a small dining table by a large window with the city lights "
             "outside, two candles, two plates of pasta and two glasses of red wine.",
    "setup": "sit across from each other",
    "cast": [
        {"name": "Daniel", "who": "man", "look": "in his early forties with short dark hair, light stubble and a navy crew-neck sweater"},
        {"name": "Claire", "who": "woman", "look": "in her late thirties with shoulder-length auburn hair and a cream silk blouse"},
    ],
    "shots": [
        {"framing": "side view", "subject": "everyone", "move": "still",
         "action": "They eat quietly, and he pushes his food around his plate without eating.", "speaker": "", "line": "", "after": ""},
        {"framing": "close-up", "subject": "Daniel", "move": "still",
         "action": "He sets his fork down and looks up at her.", "speaker": "Daniel",
         "line": "They let me go today. Twelve years, and they walked me out with a box.", "after": ""},
        {"framing": "close-up", "subject": "Claire", "move": "still",
         "action": "Her face falls and her eyes fill with tears.", "speaker": "Claire",
         "line": "Why didn't you call me? I would have come to get you.", "after": ""},
        {"framing": "close-up", "subject": "Daniel", "move": "still",
         "action": "He looks down at the table, his voice breaking.", "speaker": "Daniel",
         "line": "I didn't know how to tell you. I'm sorry.", "after": ""},
        {"framing": "wide shot", "subject": "everyone", "move": "slow push-in",
         "action": "Claire reaches across the table and takes his hand.", "speaker": "Claire",
         "line": "Hey. Look at me. We'll get through this together.", "after": "He squeezes her hand and nods, holding back tears."},
    ],
}


def _sentence(text: str) -> str:
    t = re.sub(r"\s+", " ", str(text or "")).strip()
    if not t:
        return ""
    t = t[:1].upper() + t[1:]
    return t if t[-1] in ".!?\"”" else t + "."


def _words(text: str) -> int:
    return len(re.findall(r"[A-Za-z0-9']+", str(text or "")))


def _framing(shot: dict, cast: list) -> str:
    """The framing as words, with its article: 'a close-up of Daniel, framed from the chest up'."""
    kind = shot.get("framing") or "wide shot"
    names = [c["name"] for c in cast if c.get("name")]
    who = shot.get("subject") or "everyone"
    if who == "everyone" or who not in names:
        who = names[0] if len(names) == 1 else "everyone"
    # "everyone" = the people this shot's action names (a van pulling up names nobody: no cast in the frame). A shot
    # with no action text keeps the whole cast.
    text = " ".join(str(shot.get(k) or "") for k in ("action", "speaker", "after"))
    here = [n for n in names if re.search(rf"\b{re.escape(n)}\b", text)] if text.strip() else names
    if here == names:
        group = "both of them" if len(names) == 2 else "all of them" if len(names) > 2 else (names[0] if names else "the scene")
    elif here:
        group = here[0] if len(here) == 1 else ", ".join(here[:-1]) + " and " + here[-1]
    else:
        group = "the scene"
    if kind in GROUP_FRAMINGS and (who == "everyone" or len(names) < 2):
        return {"wide shot": f"a wide shot of {group}", "side view": f"a side view of {group}",
                "two-shot": f"a two-shot of {group}, framed from the waist up"}[kind]
    subj = who if who != "everyone" else group if group != "the scene" else "the people in this shot"
    other = next((n for n in names if n != who), "the other person")
    return {
        "wide shot": f"a wide shot of {subj}",
        "side view": f"a side view of {subj}",
        "two-shot": f"a two-shot of {subj} and {other}",
        "medium shot": f"a medium shot of {subj}, framed from the waist up",
        "close-up": f"a close-up of {subj}, framed from the chest up",
        "extreme close-up": f"an extreme close-up of {subj}'s face",
        "over the shoulder": f"an over-the-shoulder shot from behind {other}, looking at {subj}",
        "from behind": f"a shot from behind {subj}",
        "custom": "",
    }.get(kind, f"a wide shot of {group}")


def _shot_seconds(shot: dict) -> float:
    return 1.0 + _words(shot.get("line")) / WORDS_PER_SECOND + 0.05 * (_words(shot.get("action")) + _words(shot.get("after")))


def roll_warnings(shots: list, k: int, names: list) -> list:
    """Soft warnings for shot k (0-based) set to keep rolling: a different place, nobody from the shot before, or a
    take that has kept rolling for more than 3 shots."""
    out = []
    prev, cur = shots[k - 1], shots[k]
    w0, w1 = str(prev.get("where") or "").strip(), str(cur.get("where") or "").strip()
    if w0 and w1 and w0.lower() != w1.lower():
        out.append(f"keeps rolling from {w0} to {w1}. Possible mismatch: fine if the camera follows them there "
                   "(through a door), otherwise use a cut.")

    def people(s):
        text = " ".join(str(s.get(x) or "") for x in ("action", "speaker", "after"))
        return {n for n in names if re.search(rf"\b{re.escape(n)}\b", text)} | ({s["subject"]} if s.get("subject") in names else set())

    a, b = people(prev), people(cur)
    if a and b and not (a & b):
        out.append("keeps rolling, but nobody from the shot before is in it. Possible mismatch: use a cut unless "
                   "the camera moves from one to the other.")
    run = 1
    while k - run >= 1 and shots[k - run].get("join") == "roll":
        run += 1
    if run == 4:  # said once, on the 4th shot in a row
        out.append("is the 4th shot in a row that keeps rolling. Long takes drift: a cut every few shots keeps "
                   "faces and the room steady.")
    return out


def build(data: dict):
    """data -> (story, segments, warnings)."""
    cast = [c for c in (data.get("cast") or []) if str(c.get("name", "")).strip()]
    for c in cast:
        c["name"] = c["name"].strip()
    shots = [s for s in (data.get("shots") or []) if any(str(s.get(k, "")).strip() for k in ("action", "line", "after")) or s.get("framing")]
    names = [c["name"] for c in cast]
    warn = []
    parts = []
    if str(data.get("place", "")).strip():
        parts.append(_sentence(data["place"]))
    else:
        warn.append("Add a place: where it happens and what is there (the table, the props, the light).")
    if cast:
        people = [f"{c['name']}, a {c.get('who') or 'person'}" + (f" {c['look'].strip()}" if str(c.get("look", "")).strip() else "") for c in cast]
        joined = people[0] if len(people) == 1 else (", and ".join(people) if len(people) == 2 else ", ".join(people[:-1]) + ", and " + people[-1])
        setup = str(data.get("setup", "")).strip() or ("is here" if len(cast) == 1 else "are together" if len(cast) == 2
                                                        else "are in this story; each shot shows only the people it names")
        parts.append(f"{joined}, {setup}.")
        for c in cast:
            if not re.match(r"[A-Z]", c["name"]):
                warn.append(f"Start the name \"{c['name']}\" with a capital letter. The nodes find people by their names.")
    else:
        warn.append("Add the cast: a name and man / woman for each person. The names keep faces and voices apart across cuts.")
    seen = []
    segments = 0
    where_now = ""
    for i, s in enumerate(shots, start=1):
        frame = _framing(s, cast)
        key = (s.get("framing"), s.get("subject"))
        if i == 1:
            head = _sentence(frame) if frame else ""
        elif s.get("join") == "roll":  # no cut: the camera carries straight on into this framing
            head = f"The camera keeps rolling, moving to {frame}." if frame else "The camera keeps rolling."
        else:
            back = key in seen[:-1] and key != seen[-1]
            head = f"Cut {'back ' if back else ''}to {frame}." if frame else "Cut to the next shot."
        seen.append(key)
        bits = [head]
        # references (LC H3 Reference Assembler): the setting, said when it changes, and the props in this shot, by the
        # names on the Assembler, so the Segment sends exactly those pictures
        where = str(s.get("where") or "").strip()
        if where and where != where_now:
            bits.append(f"This shot is at {where}.")
            where_now = where
        props = [str(x).strip() for x in (s.get("props") or []) if str(x).strip()]
        if props:
            named = [x if re.match(r"(?i)(the|a|an)\s", x) else "the " + x for x in props]
            bits.append("In this shot: " + (named[0] if len(named) == 1 else ", ".join(named[:-1]) + " and " + named[-1]) + ".")
        bits += [MOVES.get(s.get("move") or "still", ""), _sentence(s.get("action"))]
        line = re.sub(r"\s+", " ", str(s.get("line") or "")).strip().strip('"“”')
        speaker = str(s.get("speaker") or "").strip()
        if line:
            if not speaker:
                speaker = names[0] if len(names) == 1 else ""
                if not speaker:
                    warn.append(f"Shot {i}: pick who says the line.")
            elif speaker not in names:
                warn.append(f"Shot {i}: {speaker} is not in the cast.")
            bits.append(f"{speaker or 'Someone'} says \"{line}\"")
            n = _words(line)
            if n > 22:
                warn.append(f"Shot {i}: the line is {n} words. About 22 fits the longest segment (10 s), so it may run long. Shorten it or split it over two shots.")
        bits.append(_sentence(s.get("after")))
        if s.get("framing") not in GROUP_FRAMINGS and s.get("framing") != "custom" and (s.get("subject") or "everyone") not in names and len(names) > 1 \
                and not any(re.search(rf"\b{re.escape(n)}\b", str(s.get("action") or "")) for n in names):
            warn.append(f"Shot {i}: pick who the {s.get('framing') or 'shot'} is on.")
        parts.append(" ".join(b for b in bits if b).strip())
        if i > 1 and s.get("join") == "roll":
            for w in roll_warnings(shots, i - 1, names):
                warn.append(f"Shot {i}: {w}")
        sec = _shot_seconds(s)
        # one segment per shot; only a shot longer than an extended segment can hold gets more
        segments += 1 if sec <= MAX_SHOT_S else 1 + math.ceil((sec - MAX_SHOT_S) / CONT_S)
    if not shots:
        warn.append("Add at least one shot.")
    story = " ".join(p for p in parts if p).strip()
    return story, max(1, segments), warn


class LCVisionShotList:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "shot_list": ("STRING", {"default": json.dumps(EXAMPLE), "multiline": False,
                                         "tooltip": "The form's rows as JSON. Fill it in on the node."}),
            },
        }

    RETURN_TYPES = ("STRING", "INT", "STRING")
    RETURN_NAMES = ("story", "segments", "warnings")
    OUTPUT_TOOLTIPS = (
        "The story for LC Vision Showrunner's story input.",
        "A suggested segment count: one per shot (a long line gets a longer segment from extend_segments). Plug it into the Showrunner's segments.",
        "What to fix in the shot list. Empty when it all looks good.",
    )
    FUNCTION = "build"
    CATEGORY = "LC Vision"
    DESCRIPTION = ("Fill in a shot list (place, cast, one row per shot) and get the story LC Vision Showrunner reads best: "
                   "the cast by name, 'Cut to' for every new shot, the framing, the camera move and one short line per shot. No AI.")

    def build(self, shot_list="{}"):
        try:
            data = json.loads(shot_list or "{}")
        except (TypeError, ValueError):
            raise ValueError("[LC Vision] Shot List: the shot list is not valid. Undo the last change, or delete the node and add a new one.")
        story, segments, warn = build(data if isinstance(data, dict) else {})
        if warn:
            print("[LC Vision] Shot List: " + " | ".join(warn))
        text = "\n".join(f"- {w}" for w in warn)
        return {"ui": {"text": [text or "✓ Ready for the Showrunner."]}, "result": (story, segments, text)}


NODE_CLASS_MAPPINGS = {"LCVisionShotList": LCVisionShotList}
NODE_DISPLAY_NAME_MAPPINGS = {"LCVisionShotList": "LC Vision Shot List (BETA) 📋"}
