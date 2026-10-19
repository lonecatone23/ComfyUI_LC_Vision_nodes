"""
LC Vision movie routes (no node)
--------------------------------
Backs the Vision Assistant's Movie tab: reads the H3 long-video project folders (output/LC_H3/<project>/,
written by LC Vision Showrunner and the LC_AV segment nodes) and reports what is made, what is flagged and
what comes next. Read only, apart from cached thumbnails.

  GET /lc_vision/movie/projects                 -> {"projects": [{name, segments, done, modified}]}
  GET /lc_vision/movie/status?project=NAME      -> plan + per-segment state + the last Assemble report
  GET /lc_vision/movie/thumb?project=NAME&i=N   -> jpg from the middle of segment N
  GET /lc_vision/movie/project?project=NAME     -> the project file (project.json): shot list, references, settings
  POST /lc_vision/movie/project {project, data} -> writes it (the Showrunner's Save, and on every Run)
  POST /lc_vision/movie/segment {project, index, action} -> rewrites one segment's plan text (the Proof Sheet's ✎)
"""

from __future__ import annotations

import datetime
import json
import os
import re
import shutil
import subprocess
import time
from urllib.parse import quote

import folder_paths

FACE_SAME, FACE_CLOSE = 0.55, 0.40


def _root() -> str:
    return os.path.join(folder_paths.get_output_directory(), "LC_H3")


def _name(project: str) -> str:
    """A project name as a folder name: a direct child of output/LC_H3, so a name can't walk out of the folder. The
    same rule as LC Vision Showrunner's (and LC H3 Segment's) project_dir, so a name like "Lonecat's movie" finds the
    folder they wrote; "." and ".." are no name at all."""
    safe = re.sub(r"[^A-Za-z0-9 _.-]", "_", (project or "").strip())
    return safe if safe.strip(" .") else ""


def _folder(project: str, any_file: bool = False) -> str | None:
    """The project's folder when it holds a plan (or, with any_file, a project file)."""
    name = _name(project)
    path = os.path.join(_root(), name)
    if not name:
        return None
    files = ("plan.json", "project.json", os.path.join("assets", "assets.json")) if any_file else ("plan.json",)
    return path if any(os.path.isfile(os.path.join(path, f)) for f in files) else None


def _load(path: str):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def work_dir(folder: str) -> str:
    """Everything a project makes along the way lives in <project>/takes/ (LC AV tidies an older project's loose
    files in there); the top holds only project.json, plan.json and the finished movie."""
    takes = os.path.join(folder, "takes")
    if os.path.isdir(folder):
        name = os.path.basename(folder)
        loose = [os.path.join(folder, f) for f in os.listdir(folder)
                 if os.path.isfile(os.path.join(folder, f)) and (re.match(r"seg_\d{3}", f) or f.startswith("cast_")
                                                                   or f == "seams.json" or f.startswith(name + "_full"))]
        old_work = os.path.join(folder, "work")
        if os.path.isdir(old_work):
            loose += [os.path.join(old_work, f) for f in os.listdir(old_work)]
        if loose:
            os.makedirs(takes, exist_ok=True)
            for f in loose:
                os.replace(f, os.path.join(takes, os.path.basename(f)))
        if os.path.isdir(old_work) and not os.listdir(old_work):
            os.rmdir(old_work)
        # always takes/, like LC H3 Segment's work_dir: a cut or insert snapshot made before the first render used to
        # land in the project folder, and its ↶ Undo looked for it in takes/ once a render had made that folder
        os.makedirs(takes, exist_ok=True)
    return takes if os.path.isdir(takes) else folder


def _seg(folder: str, i: int, suffix: str) -> str:
    return os.path.join(work_dir(folder), f"seg_{i:03d}{suffix}")


def projects() -> list:
    out = []
    root = _root()
    if not os.path.isdir(root):
        return out
    for name in os.listdir(root):
        folder = _folder(name, any_file=True)
        if not folder:
            continue
        plan = _load(os.path.join(folder, "plan.json")) or {}
        n = len(plan.get("shots", []))
        done = sum(1 for i in range(1, n + 1) if os.path.exists(_seg(folder, i, ".json")))
        stamps = [os.path.getmtime(os.path.join(folder, f)) for f in ("plan.json", "project.json", os.path.join("assets", "assets.json"))
                  if os.path.isfile(os.path.join(folder, f))]
        out.append({"name": name, "segments": n, "done": done, "modified": max(stamps or [0]),
                    "has_project": os.path.isfile(os.path.join(folder, "project.json")), "library": name == "_library"})
    return sorted(out, key=lambda p: -p["modified"])


def status(project: str) -> dict:
    folder = _folder(project)
    if not folder:
        return {"error": f"No project called '{project}' in output/LC_H3."}
    plan = _load(os.path.join(folder, "plan.json")) or {}
    shots = plan.get("shots", [])
    segs, latest = [], 0.0
    for s in shots:
        i = s.get("index", len(segs) + 1)
        meta = _load(_seg(folder, i, ".json"))
        row = {"index": i, "mode": s.get("mode", "CUT"), "action": s.get("action", ""), "start_s": s.get("start_s", 0),
               "end_state": (s.get("redirect") or {}).get("end_state", ""), "done": bool(meta), "refs": [], "edited": s.get("edited", ""), "locked": bool(s.get("locked")), "plan_mode": s.get("mode", "CUT"),
               "anchor_from": s.get("anchor_from"), "inserted": s.get("inserted", "")}
        if meta:
            saved = os.path.getmtime(_seg(folder, i, ".json"))
            latest = max(latest, saved)
            prev_tail = _seg(folder, i - 1, "_tail.mp4")
            made_from = meta.get("from_tail_mtime")
            row.update({
                "mode": meta.get("mode", row["mode"]), "auto_cut": meta.get("auto_cut", ""), "reanchor": meta.get("reanchor", ""),
                "seed": meta.get("seed"), "face": meta.get("face"), "look": meta.get("look"), "memory": meta.get("memory"),
                "frames": meta.get("part_frames"), "saved": meta.get("saved", ""), "modified": saved, "refs": meta.get("refs") or [],
                "stale": bool(row["mode"] == "CONTINUE" and made_from and os.path.exists(prev_tail)
                              and abs(os.path.getmtime(prev_tail) - made_from) > 1),
            })
            # hold_scene: made with the layout of an earlier shot that has since been redone
            lf = meta.get("layout_from") or {}
            anchor_part = _seg(folder, int(lf.get("index", 0)), "_part.mp4") if lf.get("index") else ""
            if anchor_part and os.path.exists(anchor_part) and abs(os.path.getmtime(anchor_part) - float(lf.get("mtime", 0))) > 1:
                row["stale"], row["stale_from"] = True, int(lf["index"])
            elif lf.get("cut"):  # its room came from a shot that was cut since
                row["stale"], row["stale_from"] = True, "cut"
            if meta.get("mode") and meta.get("mode") != s.get("mode") and not meta.get("trim_start"):
                row["stale"], row["stale_from"] = True, "join"  # made as a cut, now it keeps rolling (or the other way)
        segs.append(row)
    full = os.path.join(work_dir(folder), f"{os.path.basename(folder)}_full.mp4")
    finished = os.path.join(folder, f"{os.path.basename(folder)}.mp4")
    report = _load(os.path.join(work_dir(folder), "seams.json")) or {}
    if isinstance(report, list):  # older reports were just the join list
        report = {"joins": report}
    full_mtime = os.path.getmtime(full) if os.path.exists(full) else 0
    return {
        "project": os.path.basename(folder), "subfolder": f"LC_H3/{os.path.basename(folder)}",
        "work_subfolder": f"LC_H3/{os.path.basename(folder)}" + ("/takes" if os.path.isdir(os.path.join(folder, "takes")) else ""),
        "finished": os.path.basename(finished) if os.path.exists(finished) else "",
        "undo": _hist_label(_hist(folder)[-1]) if _hist(folder) else "",
        "cast": [c.get("name") for c in ((_load(os.path.join(folder, "project.json")) or {}).get("shot_list") or {}).get("cast") or []
                 if str(c.get("name") or "").strip()],
        "style": plan.get("style", ""), "segment_s": plan.get("segment_s"), "overlap_s": plan.get("overlap_s"),
        "warnings": plan.get("warnings", []), "segments": segs,
        "full": os.path.basename(full) if full_mtime else "", "full_outdated": bool(full_mtime and latest > full_mtime + 1),
        "report": report if full_mtime else {}, "face_same": FACE_SAME, "face_close": FACE_CLOSE,
    }


def load_project(project: str) -> dict:
    folder = _folder(project, any_file=True)
    return (_load(os.path.join(folder, "project.json")) or {}) if folder else {}


_EDIT_KEYS = ("action", "action_original", "action_planned", "prompt", "edited", "redirect", "anchor_from")


def _hist_path(folder: str) -> str:
    # always takes/history.json, where LC H3 Segment writes its redo steps (work_dir is the project folder itself
    # until takes/ exists, and a history written there before the first render was lost once it did)
    return os.path.join(folder, "takes", "history.json")


def _hist(folder: str) -> list:
    h = _load(_hist_path(folder))
    return h if isinstance(h, list) else []


def _hist_push(folder: str, entry: dict) -> None:
    h = _hist(folder) + [{**entry, "time": time.time()}]
    os.makedirs(os.path.dirname(_hist_path(folder)), exist_ok=True)
    with open(_hist_path(folder), "w", encoding="utf-8") as f:
        json.dump(h[-50:], f, indent=1, ensure_ascii=False)


def _hist_label(e: dict) -> str:
    return {"edit": f"edit of segment {e.get('index')}", "redo": f"redo of segment {e.get('index')}",
            "join": f"cut / keep rolling change of segment {e.get('index')}",
            "insert": f"shot inserted as segment {e.get('index')}",
            "cut": f"delete of shot {e.get('shot', '')} (segment {e.get('a')})"}.get(e.get("kind"), e.get("kind", ""))


def _write_plan(path: str, plan: dict) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(plan, f, indent=1, ensure_ascii=False)
    os.replace(tmp, path)


def set_lock(project: str, index: int, locked: bool) -> dict:
    """🔒 a segment you are happy with: ✎ ↻ 🗑 and Undo leave it alone, and the plan can't be written again over it.
    index 0 = every made segment."""
    folder = _folder(project)
    if not folder:
        raise ValueError(f"No project called '{project}'.")
    path = os.path.join(folder, "plan.json")
    plan = _load(path) or {}
    shots = plan.get("shots") or []
    which = range(1, len(shots) + 1) if int(index) == 0 else [int(index)]
    for k in which:
        if 1 <= k <= len(shots) and (int(index) != 0 or os.path.exists(_seg(folder, k, "_part.mp4")) or not locked):
            if locked:
                shots[k - 1]["locked"] = True
            else:
                shots[k - 1].pop("locked", None)
    _write_plan(path, plan)
    return {"locked": [k for k, sh in enumerate(shots, start=1) if sh.get("locked")]}


def impact(project: str, index: int, action: str) -> dict:
    """What a change to segment `index` (edit, redo or cut) would do to locked segments after it: the CONTINUE ones
    that start from its ending, and the ones whose room (hold_scene layout) was copied from it. For the warning."""
    folder = _folder(project)
    plan = _load(os.path.join(folder, "plan.json")) if folder else None
    if not plan:
        return {"warnings": []}
    shots, i, out = plan.get("shots") or [], int(index), []
    if 1 <= i <= len(shots) and shots[i - 1].get("locked"):
        out.append(f"Segment {i} itself is locked 🔒.")
    k = i + 1
    while k <= len(shots) and shots[k - 1].get("mode") == "CONTINUE":
        if shots[k - 1].get("locked"):
            out.append(f"Segment {k} is locked and carries straight on from segment {i}'s ending: it would no longer join.")
        k += 1
    for k in range(i + 1, len(shots) + 1):
        if not shots[k - 1].get("locked"):
            continue
        meta = _load(_seg(folder, k, ".json")) or {}
        if int((meta.get("layout_from") or {}).get("index") or 0) == i:
            out.append(f"Segment {k} is locked and holds the room from segment {i}: it would show yellow (made from the old room).")
    return {"warnings": out}


_LOCKABLE_UNDO = ("edit", "redo", "join", "insert")


def undo_check(project: str) -> dict:
    """Before ↶ Undo: why the next step can't go back (its segment is locked), or which locked segments after it it
    would disturb (the same warning ✎ / ↻ / 🗑 give)."""
    folder = _folder(project)
    h = _hist(folder) if folder else []
    if not h:
        return {"blocked": "", "warnings": []}
    e = h[-1]
    shots = (_load(os.path.join(folder, "plan.json")) or {}).get("shots") or []
    kind, i = e.get("kind"), int(e.get("index") or e.get("a") or 0)
    if kind in _LOCKABLE_UNDO and 1 <= i <= len(shots) and shots[i - 1].get("locked"):
        return {"blocked": f"Segment {i} is locked 🔒, so the {_hist_label(e)} can't be undone.\n\n"
                           f"Unlock segment {i} first, then Undo (lock it again after if you like).", "warnings": []}
    if kind == "cut":  # the shot comes back at segment a: the locked segments from there on move or lose their join
        i -= 1
    warnings = [w for w in impact(project, i, "redo")["warnings"] if "itself is locked" not in w] if i >= 1 else []
    return {"blocked": "", "warnings": warnings, "label": _hist_label(e)}


def undo_last(project: str) -> dict:
    """↶ Undo: the last cut, edit or redo goes back. A redo's old take comes back (the newer one is kept as a take);
    when the old take is gone, the segment counts as not made and is made again on the next Run."""
    folder = _folder(project)
    if not folder:
        raise ValueError(f"No project called '{project}'.")
    h = _hist(folder)
    if not h:
        raise ValueError("Nothing to undo.")
    e = h[-1]
    plan_path = os.path.join(folder, "plan.json")
    plan = _load(plan_path) or {}
    shots = plan.get("shots") or []
    kind, i = e.get("kind"), int(e.get("index") or e.get("a") or 0)
    if kind in _LOCKABLE_UNDO and 1 <= i <= len(shots) and shots[i - 1].get("locked"):
        raise ValueError(f"Segment {i} is locked 🔒: unlock it to undo the {_hist_label(e)}.")
    note = ""
    if kind == "edit":
        sh = shots[i - 1]
        for key in _EDIT_KEYS:
            sh.pop(key, None)
        sh.update(e.get("before") or {})
        _write_plan(plan_path, plan)
        note = f"Segment {i}'s plan text is back. Redo it to see it."
    elif kind == "redo":
        kept = _keep_take_here(folder, i)  # the newer take stays as a take
        back = _restore_take(folder, i, e.get("take", ""))
        for k, take in e.get("aside") or []:
            _restore_take(folder, int(k), take)
        note = (f"Segment {i}'s earlier take is back (the newer one is in takes/{kept})." if back
                else f"Segment {i}'s earlier take is gone, so it will be made again on the next Run.")
    elif kind == "insert":
        undo_insert(project, i, e.get("dir", ""))
        note = f"The inserted shot (segment {i}) is out again."
    elif kind == "join":
        set_join(project, i, e.get("before", "cut"), record=False)
        note = f"Segment {i} {'keeps rolling' if e.get('before') == 'roll' else 'opens on a cut'} again."
    elif kind == "cut":
        r = undo_cut(project, os.path.join(work_dir(folder), e.get("dir", "")))
        h = _hist(folder)  # undo_cut doesn't touch the history
        note = f"Shot {e.get('shot', '')} is back as segment {r['restored'][0]}."
    else:
        raise ValueError(f"Can't undo '{kind}'.")
    with open(_hist_path(folder), "w", encoding="utf-8") as f:
        json.dump(h[:-1], f, indent=1, ensure_ascii=False)
    proj = _load(os.path.join(folder, "project.json")) or {}
    plan = _load(plan_path) or {}
    # undo_cut joined the movie already: once is enough (Assemble re-encodes every segment)
    joined = r.get("joined", "") if kind == "cut" else _rejoin(folder, plan) if kind == "redo" else ""
    return {"undone": _hist_label(e), "note": note, "shot_list": proj.get("shot_list"), "joined": joined,
            "next": _hist_label(h[-2]) if len(h) > 1 else ""}


_TAKE_SUFFIXES = (".mp4", "_part.mp4", "_tail.mp4", "_tail.wav", ".json", "_latent.safetensors", "_up.mp4")


def _keep_take_here(folder: str, i: int) -> str:
    """The segment's current files moved into takes/ as seg_00N_takeK (the same naming as LC H3 Segment Save)."""
    work = work_dir(folder)
    k = 1
    while os.path.exists(os.path.join(work, f"seg_{i:03d}_take{k}.mp4")):
        k += 1
    for suf in _TAKE_SUFFIXES:
        src = _seg(folder, i, suf)
        if os.path.exists(src):
            shutil.move(src, os.path.join(work, f"seg_{i:03d}_take{k}{suf}"))
    for extra in ("_thumb.jpg",):
        if os.path.exists(_seg(folder, i, extra)):
            os.remove(_seg(folder, i, extra))
    return f"seg_{i:03d}_take{k}"


def _restore_take(folder: str, i: int, take: str) -> bool:
    work = work_dir(folder)
    if not take or not os.path.exists(os.path.join(work, take + ".mp4")):
        return False
    for suf in _TAKE_SUFFIXES:
        src = os.path.join(work, take + suf)
        if os.path.exists(src):
            shutil.move(src, _seg(folder, i, suf))
    if os.path.exists(_seg(folder, i, "_thumb.jpg")):
        os.remove(_seg(folder, i, "_thumb.jpg"))
    return True


def edit_segment(project: str, index: int, action: str, anchor_from=None, set_anchor: bool = False) -> dict:
    """Your own words for one segment of the plan. The rest of the plan, and every render, stays as it is; redo that
    segment to see it. The Showrunner keeps reusing the plan (the story didn't change), so the edit sticks."""
    folder = _folder(project)
    if not folder:
        raise ValueError(f"No project called '{project}'.")
    path = os.path.join(folder, "plan.json")
    plan = _load(path) or {}
    shots = plan.get("shots") or []
    if not (1 <= int(index) <= len(shots)):
        raise ValueError(f"The plan has no segment {index}.")
    action = str(action or "").replace("\r\n", "\n").strip()
    if not action:
        raise ValueError("The segment text is empty.")
    s = shots[int(index) - 1]
    if s.get("locked"):
        raise ValueError(f"Segment {index} is locked 🔒. Unlock it to change its words.")
    _hist_push(folder, {"kind": "edit", "index": int(index), "before": {k: s[k] for k in _EDIT_KEYS if k in s}})
    s.setdefault("action_planned", s.get("action_original", s.get("action", "")))
    s["action"] = s["action_original"] = action  # the join fix (Redirect) starts from your words too
    s["prompt"] = f"{plan.get('style', '')}\n\n{action}".strip()
    s["edited"] = time.strftime("%Y-%m-%d %H:%M:%S")
    s.pop("redirect", None)
    if set_anchor:  # Room from: None = auto, 0 = none, k = segment k
        if anchor_from in (None, "", "auto"):
            s.pop("anchor_from", None)
        else:
            s["anchor_from"] = int(anchor_from)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(plan, f, indent=1, ensure_ascii=False)
    os.replace(tmp, path)
    return {"saved": int(index)}


def _real_shots(shot_list: dict) -> list:
    """The Shot List's shots the story is written from (the same filter as LC Vision Shot List)."""
    return [x for x in (shot_list.get("shots") or [])
            if any(str(x.get(k, "")).strip() for k in ("action", "line", "after")) or x.get("framing")]


def _assembler():
    """LC H3 Assemble from the LC AV pack, when it is installed."""
    import sys
    for name, mod in list(sys.modules.items()):
        if name.endswith("lc_h3_segment") and hasattr(mod, "LCH3Assemble"):
            return mod
    return None


def cut_shot(project: str, index: int) -> dict:
    """Cut a shot out of the movie: the shot that segment `index` belongs to leaves the Shot List and the plan, the
    story is written again without it, and the later segments move up a number. Nothing is rendered again: the cut
    takes move to takes/cut_<time>/ and the movie is joined again from what is left."""
    from .lc_vision_director import _shot_list, tag_places
    from .lc_vision_shot_list import build as build_story

    folder = _folder(project)
    if not folder:
        raise ValueError(f"No project called '{project}'.")
    plan_path, proj_path = os.path.join(folder, "plan.json"), os.path.join(folder, "project.json")
    plan, proj = _load(plan_path) or {}, _load(proj_path) or {}
    shots = plan.get("shots") or []
    index = int(index)
    if not (1 <= index <= len(shots)):
        raise ValueError(f"The plan has no segment {index}.")
    sl = _shot_list(plan.get("story", ""), len(shots))
    shot_list = proj.get("shot_list") or {}
    real = _real_shots(shot_list)
    if not sl and len(real) == 1 and shots:  # a one-shot movie has no cut to split the story at
        sl = ([plan.get("story", "")], [len(shots)])
    if not sl or len(sl[0]) != len(real):
        raise ValueError("Delete works on movies written with the LC Vision Shot List (its project file has to match the "
                         "plan). For a written story, take the shot out of the story instead.")
    spans = sl[1]
    if len(spans) < 2:
        raise ValueError("That is the only shot in the movie.")
    first, shot_no = 1, 0
    for k, sp in enumerate(spans):
        if first <= index < first + sp:
            shot_no = k
            break
        first += sp
    a, b = first, first + spans[shot_no] - 1  # the segments of that shot
    gone = b - a + 1
    if any(shots[k - 1].get("locked") for k in range(a, b + 1)):
        raise ValueError(f"Segment {index} is locked 🔒. Unlock it to delete its shot.")

    # the story without that shot
    keep = real[:shot_no] + real[shot_no + 1:]
    rolled = shot_no < len(keep) and keep[shot_no].get("join") == "roll"
    if rolled:  # it carried straight on from the shot being cut: it opens on a cut now
        keep[shot_no] = {**keep[shot_no], "join": "cut"}
    others = [x for x in (shot_list.get("shots") or []) if x not in real]  # empty rows stay where they were
    new_list = {**shot_list, "shots": keep + others}
    story, segments, _warn = build_story(json.loads(json.dumps(new_list)))
    if segments != len(shots) - gone:
        raise ValueError(f"The shot list would plan {segments} segments where {len(shots) - gone} are left; replan instead.")

    # takes: the cut ones aside, the later ones up a number
    work = work_dir(folder)
    aside = os.path.join(work, "cut_" + time.strftime("%Y%m%d_%H%M%S"))
    k = 2
    while os.path.exists(aside):  # two cuts in the same second
        aside = os.path.join(work, f"cut_{time.strftime('%Y%m%d_%H%M%S')}_{k}")
        k += 1
    before = os.path.join(aside, "_before")  # for ↶ Undo cut: the plan, the project and every segment record as they were
    os.makedirs(before, exist_ok=True)
    pat = re.compile(r"^seg_(\d{3})(.*)$")
    names = sorted(os.listdir(work))
    shutil.copy2(plan_path, os.path.join(before, "plan.json"))
    shutil.copy2(proj_path, os.path.join(before, "project.json"))
    for n in names:
        if pat.match(n) and n.endswith(".json"):
            shutil.copy2(os.path.join(work, n), os.path.join(before, n))
    for n in names:
        m = pat.match(n)
        if m and a <= int(m.group(1)) <= b and not (int(m.group(1)) == 1 and "memory" in m.group(2) or "face_ref" in m.group(2)):
            shutil.move(os.path.join(work, n), os.path.join(aside, n))
    for n in names:
        m = pat.match(n)
        if m and int(m.group(1)) > b and os.path.exists(os.path.join(work, n)):
            os.replace(os.path.join(work, n), os.path.join(work, f"seg_{int(m.group(1)) - gone:03d}{m.group(2)}"))

    def renum(k):
        return None if k is None else (k - gone if k > b else (None if k >= a else k))

    for i in range(a, len(shots) - gone + 1):  # the moved segments' own records
        jp = _seg(folder, i, ".json")
        d = _load(jp)
        if not d:
            continue
        d["index"] = i
        if i == a and rolled and d.get("mode") == "CONTINUE":  # its opening frames are the cut shot's ending: skip them
            d["mode"], d["trim_start"] = "CUT", int(d.get("overlap_frames", 0))
        lf = d.get("layout_from")
        if isinstance(lf, dict) and lf.get("index"):
            new = renum(int(lf["index"]))
            d["layout_from"] = {**lf, "index": new} if new else {**lf, "index": 0, "cut": True}
        with open(jp, "w", encoding="utf-8") as f:
            json.dump(d, f, indent=1, ensure_ascii=False)
    mj = _seg(folder, 1, "_memory.json")
    md = _load(mj)
    if md and md.get("from"):
        md["from"] = renum(int(md["from"])) or 1
        with open(mj, "w", encoding="utf-8") as f:
            json.dump(md, f)

    # the plan without that shot: numbers, start times and the story it is keyed to
    plan["shots"] = shots[:a - 1] + shots[b:]
    end, ovl = 0.0, float(plan.get("overlap_s", 0))
    fps = 24.0
    for i, sh in enumerate(plan["shots"], start=1):
        sh["index"] = i
        cont = sh.get("mode") == "CONTINUE"
        if i == a and cont:  # the shot before it is gone: this one opens on a cut now
            sh["mode"], cont = "CUT", False
        start = end - ovl if cont else end
        sh["start_s"] = round(start, 3)
        end = start + (sh.get("frames") or plan.get("segment_frames") or round(plan.get("segment_s", 5) * fps)) / fps
    plan["story"], plan["segments"] = story, segments
    plan["cuts"] = plan.get("cuts", []) + [{"shot": shot_no + 1, "segments": [a, b], "when": time.strftime("%Y-%m-%d %H:%M:%S"), "takes": os.path.basename(aside)}]
    tag_places(plan)
    tmp = plan_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(plan, f, indent=1, ensure_ascii=False)
    os.replace(tmp, plan_path)
    proj["shot_list"] = new_list
    save_project(os.path.basename(folder), proj)
    with open(os.path.join(aside, "undo.json"), "w", encoding="utf-8") as f:
        json.dump({"a": a, "b": b, "gone": gone, "count": len(shots), "time": time.time()}, f)
    _hist_push(folder, {"kind": "cut", "shot": shot_no + 1, "a": a, "b": b, "dir": os.path.basename(aside)})

    joined = _rejoin(folder, plan)  # the finished movie only when every segment is there
    return {"cut_shot": shot_no + 1, "segments": [a, b], "left": len(plan["shots"]), "shot_list": new_list,
            "takes": os.path.basename(aside), "joined": joined}


def _rejoin(folder: str, plan: dict) -> str:
    mod = _assembler()
    if not mod:
        return ""
    try:
        res = mod.LCH3Assemble().assemble(plan, 8, 15, 18)["result"]
        if res[0] and all(mod._is_done(folder, k) for k in range(1, len(plan["shots"]) + 1)):
            shutil.copy2(res[0], os.path.join(folder, f"{os.path.basename(folder)}.mp4"))
        return res[0]
    except Exception as exc:
        return f"not joined: {exc}"


def last_cut(folder: str) -> str | None:
    work = work_dir(folder)
    cuts = sorted(n for n in os.listdir(work) if n.startswith("cut_") and os.path.exists(os.path.join(work, n, "undo.json")))
    return os.path.join(work, cuts[-1]) if cuts else None


def undo_cut(project: str, aside: str | None = None) -> dict:
    """↶ Undo cut: the last cut shot comes back, with its takes, its place in the Shot List and the numbers it had.
    Refused once a segment was made again after the cut (its old record would no longer match)."""
    folder = _folder(project)
    if not folder:
        raise ValueError(f"No project called '{project}'.")
    aside = aside or last_cut(folder)
    if not aside or not os.path.exists(os.path.join(aside, "undo.json")):
        raise ValueError("Nothing to undo: no cut in this project.")
    now_locked = {k for k, sh in enumerate((_load(os.path.join(folder, "plan.json")) or {}).get("shots", []), start=1) if sh.get("locked")}
    u = _load(os.path.join(aside, "undo.json")) or {}
    a, gone = int(u["a"]), int(u["gone"])
    work = work_dir(folder)
    pat = re.compile(r"^seg_(\d{3})(.*)$")
    # segments made after the cut (not undone first) carry their new numbers: they move with the rest
    # the later segments back down a number (from the end, so nothing is overwritten), then the cut takes back in
    for n in sorted((n for n in os.listdir(work) if pat.match(n)), key=lambda n: -int(pat.match(n).group(1))):
        m = pat.match(n)
        if int(m.group(1)) == 1 and ("memory" in m.group(2) or "face_ref" in m.group(2)):
            continue  # the project's memory files stayed at seg_001 through the cut: they stay there now too
        if int(m.group(1)) >= a:
            os.replace(os.path.join(work, n), os.path.join(work, f"seg_{int(m.group(1)) + gone:03d}{m.group(2)}"))
    before = os.path.join(aside, "_before")
    for n in os.listdir(aside):
        if pat.match(n):
            shutil.move(os.path.join(aside, n), os.path.join(work, n))
    for n in os.listdir(before):
        if pat.match(n):
            shutil.copy2(os.path.join(before, n), os.path.join(work, n))
    shutil.copy2(os.path.join(before, "plan.json"), os.path.join(folder, "plan.json"))
    shutil.copy2(os.path.join(before, "project.json"), os.path.join(folder, "project.json"))
    os.replace(aside, os.path.join(work, "undone_" + os.path.basename(aside)))
    plan = _load(os.path.join(folder, "plan.json")) or {}
    for k, sh in enumerate(plan.get("shots", []), start=1):  # locks set since the cut stay
        cur = k if k < a else k - gone
        if (k < a or k >= a + gone) and cur in now_locked:
            sh["locked"] = True
        elif k < a or k >= a + gone:
            sh.pop("locked", None)
    _write_plan(os.path.join(folder, "plan.json"), plan)
    proj = _load(os.path.join(folder, "project.json")) or {}
    return {"restored": [a, a + gone - 1], "count": len(plan.get("shots", [])), "shot_list": proj.get("shot_list"),
            "joined": _rejoin(folder, plan)}


def set_join(project: str, index: int, join: str, record: bool = True) -> dict:
    """✎ on the Proof Sheet: segment `index` opens on a cut, or keeps rolling from the segment before (no cut). The
    plan and the Shot List change together, so the next Run keeps the plan; the segment shows yellow until it is
    made again."""
    from .lc_vision_director import _shot_list, tag_places
    from .lc_vision_shot_list import build as build_story

    folder = _folder(project)
    if not folder:
        raise ValueError(f"No project called '{project}'.")
    plan_path, proj_path = os.path.join(folder, "plan.json"), os.path.join(folder, "project.json")
    plan, proj = _load(plan_path) or {}, _load(proj_path) or {}
    shots, index = plan.get("shots") or [], int(index)
    if not (2 <= index <= len(shots)):
        raise ValueError("The first segment always opens the movie." if index == 1 else f"The plan has no segment {index}.")
    if shots[index - 1].get("locked"):
        raise ValueError(f"Segment {index} is locked 🔒. Unlock it to change how it starts.")
    sl = _shot_list(plan.get("story", ""), len(shots))
    shot_list = proj.get("shot_list") or {}
    real = _real_shots(shot_list)
    if not sl and len(real) == 1 and shots:  # a one-shot movie has no cut to split the story at
        sl = ([plan.get("story", "")], [len(shots)])
    if not sl or len(sl[0]) != len(real):
        raise ValueError("This works on movies written with the LC Vision Shot List.")
    first, shot_no = 1, None
    for k, sp in enumerate(sl[1]):
        if first == index:
            shot_no = k
        first += sp
    if shot_no is None:
        raise ValueError(f"Segment {index} is inside a longer shot: it always carries straight on.")
    want = "roll" if join == "roll" else "cut"
    if (real[shot_no].get("join") or "cut") == want:
        return {"index": index, "join": want, "changed": False, "shot_list": shot_list}
    before = {"join": real[shot_no].get("join") or "cut"}
    real[shot_no]["join"] = want  # real holds the same dicts as shot_list["shots"]
    story, segments, _warn = build_story(json.loads(json.dumps(shot_list)))
    if segments != len(shots):
        raise ValueError(f"The Shot List would plan {segments} segments where the movie has {len(shots)}; replan instead.")
    shots[index - 1]["mode"] = "CONTINUE" if want == "roll" else "CUT"
    end, ovl, fps = 0.0, float(plan.get("overlap_s", 0)), 24.0
    for sh in shots:
        cont = sh.get("mode") == "CONTINUE"
        start = end - ovl if cont else end
        sh["start_s"] = round(start, 3)
        end = start + (sh.get("frames") or plan.get("segment_frames") or round(plan.get("segment_s", 5) * fps)) / fps
    plan["story"] = story
    tag_places(plan)
    _write_plan(plan_path, plan)
    save_project(os.path.basename(folder), {**proj, "shot_list": shot_list})
    if record:
        _hist_push(folder, {"kind": "join", "index": index, "before": before["join"]})
    return {"index": index, "join": want, "changed": True, "shot_list": shot_list}


def _shift_files(folder: str, after: int, step: int) -> None:
    """Segment files (takes too) after `after` move up (step 1) or down (step -1) a number."""
    work = work_dir(folder)
    pat = re.compile(r"^seg_(\d{3})(.*)$")
    names = [n for n in os.listdir(work) if pat.match(n) and int(pat.match(n).group(1)) > after]
    for n in sorted(names, key=lambda n: int(pat.match(n).group(1)), reverse=step > 0):
        m = pat.match(n)
        os.replace(os.path.join(work, n), os.path.join(work, f"seg_{int(m.group(1)) + step:03d}{m.group(2)}"))


def insert_shot(project: str, index: int, shot: dict) -> dict:
    """➕ on the Proof Sheet: a new shot after segment `index`'s shot. It goes into the Shot List and the plan (its plan
    text written from the shot, ✎ to change it), the segments after it move up a number, nothing is planned again.
    The new segment isn't made yet: ↻ or Run makes it."""
    from .lc_vision_director import _shot_list, tag_places
    from .lc_vision_shot_list import build as build_story, _framing, MOVES

    folder = _folder(project)
    if not folder:
        raise ValueError(f"No project called '{project}'.")
    plan_path, proj_path = os.path.join(folder, "plan.json"), os.path.join(folder, "project.json")
    plan, proj = _load(plan_path) or {}, _load(proj_path) or {}
    shots, index = plan.get("shots") or [], int(index)
    if not (1 <= index <= len(shots)):
        raise ValueError(f"The plan has no segment {index}.")
    sl = _shot_list(plan.get("story", ""), len(shots))
    shot_list = proj.get("shot_list") or {}
    real = _real_shots(shot_list)
    if not sl and len(real) == 1 and shots:  # a one-shot movie has no cut to split the story at
        sl = ([plan.get("story", "")], [len(shots)])
    if not sl or len(sl[0]) != len(real):
        raise ValueError("Insert works on movies written with the LC Vision Shot List.")
    first, shot_no = 1, 0
    for k, sp in enumerate(sl[1]):
        if first <= index < first + sp:
            shot_no, after = k, first + sp - 1
            break
        first += sp
    prev = real[shot_no]
    new = {"framing": shot.get("framing") or "wide shot", "subject": shot.get("subject") or "everyone",
           "move": shot.get("move") or "still", "action": str(shot.get("action") or "").strip(),
           "speaker": shot.get("speaker") or "", "line": str(shot.get("line") or "").strip(), "after": "",
           "where": prev.get("where", ""), **({"join": "roll"} if shot.get("join") == "roll" else {})}
    if not new["action"] and not new["line"]:
        raise ValueError("Say what happens in the new shot.")
    i_all = shot_list["shots"].index(prev)
    shot_list["shots"].insert(i_all + 1, new)
    story, segments, _warn = build_story(json.loads(json.dumps(shot_list)))
    if segments != len(shots) + 1:
        raise ValueError(f"The Shot List would plan {segments} segments where {len(shots) + 1} are expected "
                         "(a very long line gets two). Shorten it, or add the shot in the Shot List and replan.")

    # the new segment's plan text, from the shot and the segment before it (same place, same sound)
    lines = (shots[after - 1].get("action") or "").split("\n")
    pick = lambda lab: next((ln for ln in lines if ln.strip().lower().startswith(lab + ":")), "")
    sound = re.sub(r"\s*No music\..*$", "", pick("sound")).strip() or "Sound: quiet room tone."
    sound += " No music. The only voice is the quoted line." if new["line"] else " No music. Nobody speaks."
    cast = [c for c in (shot_list.get("cast") or []) if str(c.get("name", "")).strip()]
    cam = _framing(new, cast)
    body = " ".join(x for x in (MOVES.get(new["move"], ""), f"At 0.00 seconds, {new['action'].rstrip('.')}." if new["action"] else "",
                                f"At 1.00 seconds, {new['speaker'] or 'Someone'} says \"{new['line']}\"" if new["line"] else "") if x)
    action = "\n".join([pick("place") or "Place: the same place as before.", "Holding: nothing", sound,
                        f"Camera: {cam[:1].upper() + cam[1:]}.", "", body])

    # snapshot for ↶ Undo, then make room: later segments up a number
    snap = os.path.join(work_dir(folder), "insert_" + time.strftime("%Y%m%d_%H%M%S"))
    k = 2
    while os.path.exists(snap):
        snap = os.path.join(work_dir(folder), f"insert_{time.strftime('%Y%m%d_%H%M%S')}_{k}")
        k += 1
    os.makedirs(snap)
    shutil.copy2(plan_path, os.path.join(snap, "plan.json"))
    shutil.copy2(proj_path, os.path.join(snap, "project.json"))
    _shift_files(folder, after, 1)
    for i in range(after + 2, len(shots) + 2):
        jp = _seg(folder, i, ".json")
        d = _load(jp)
        if not d:
            continue
        d["index"] = i
        lf = d.get("layout_from")
        if isinstance(lf, dict) and int(lf.get("index") or 0) > after:
            d["layout_from"] = {**lf, "index": int(lf["index"]) + 1}
        with open(jp, "w", encoding="utf-8") as f:
            json.dump(d, f, indent=1, ensure_ascii=False)
    mj = _seg(folder, 1, "_memory.json")
    md = _load(mj)
    if md and int(md.get("from") or 0) > after:
        md["from"] = int(md["from"]) + 1
        with open(mj, "w", encoding="utf-8") as f:
            json.dump(md, f)
    for sh in shots[after:]:  # a Room from pointing past the new shot follows its segment
        if sh.get("anchor_from") and int(sh["anchor_from"]) > after:
            sh["anchor_from"] = int(sh["anchor_from"]) + 1
    seg = {"index": after + 1, "mode": "CONTINUE" if new.get("join") == "roll" else "CUT", "action": action,
           "prompt": f"{plan.get('style', '')}\n\n{action}".strip(), "inserted": time.strftime("%Y-%m-%d %H:%M:%S"),
           **({"place_name": shots[after - 1]["place_name"]} if shots[after - 1].get("place_name") else {})}
    plan["shots"] = shots[:after] + [seg] + shots[after:]
    end, ovl, fps = 0.0, float(plan.get("overlap_s", 0)), 24.0
    for i, sh in enumerate(plan["shots"], start=1):
        sh["index"] = i
        cont = sh.get("mode") == "CONTINUE"
        start = end - ovl if cont else end
        sh["start_s"] = round(start, 3)
        end = start + (sh.get("frames") or plan.get("segment_frames") or round(plan.get("segment_s", 5) * fps)) / fps
    plan["story"], plan["segments"] = story, segments
    tag_places(plan)
    _write_plan(plan_path, plan)
    save_project(os.path.basename(folder), {**proj, "shot_list": shot_list})
    _hist_push(folder, {"kind": "insert", "index": after + 1, "dir": os.path.basename(snap)})
    return {"inserted": after + 1, "count": len(plan["shots"]), "shot_list": shot_list, "action": action}


def undo_insert(project: str, index: int, snap_dir: str) -> dict:
    folder = _folder(project)
    snap = os.path.join(work_dir(folder), snap_dir)
    if not os.path.exists(os.path.join(snap, "plan.json")):
        raise ValueError("The inserted shot's snapshot is gone, so it can't be undone.")
    work = work_dir(folder)
    for n in os.listdir(work):  # the inserted segment, if it was made, stays as a take (its takes too: the later
        if re.match(rf"^seg_{index:03d}(?!\d)", n):  # segments move down onto this number, and would overwrite them)
            shutil.move(os.path.join(work, n), os.path.join(snap, n))
    _shift_files(folder, index, -1)
    plan_now = _load(os.path.join(folder, "plan.json")) or {}
    for i in range(index, len(plan_now.get("shots", []))):
        jp = _seg(folder, i, ".json")
        d = _load(jp)
        if not d:
            continue
        d["index"] = i
        lf = d.get("layout_from")
        if isinstance(lf, dict) and int(lf.get("index") or 0) > index:
            d["layout_from"] = {**lf, "index": int(lf["index"]) - 1}
        with open(jp, "w", encoding="utf-8") as f:
            json.dump(d, f, indent=1, ensure_ascii=False)
    locked = {k if k < index else k - 1 for k, sh in enumerate(plan_now.get("shots", []), start=1) if sh.get("locked") and k != index}
    shutil.copy2(os.path.join(snap, "project.json"), os.path.join(folder, "project.json"))
    plan = _load(os.path.join(snap, "plan.json")) or {}
    for k, sh in enumerate(plan.get("shots", []), start=1):
        if k in locked:
            sh["locked"] = True
        else:
            sh.pop("locked", None)
    _write_plan(os.path.join(folder, "plan.json"), plan)
    os.replace(snap, os.path.join(work, "undone_" + snap_dir))
    return {"removed": index}


def save_project_checked(project: str, data: dict) -> dict:
    """The project save on every Run (and 💾). When the project has locked segments and the Shot List coming in would
    tell a different story than the plan (an older copy of the workflow, say), the stored Shot List is kept: writing
    it would only make the next Load bring back the old list. The Showrunner then says what to do."""
    folder = _folder(project, any_file=True)
    kept = False
    plan = _load(os.path.join(folder, "plan.json")) if folder else None
    if plan and any(sh.get("locked") for sh in plan.get("shots", [])) and isinstance(data.get("shot_list"), dict):
        from .lc_vision_shot_list import build as build_story
        try:
            story = build_story(json.loads(json.dumps(data["shot_list"])))[0]
        except Exception:
            story = None
        if story is not None and story.strip() != str(plan.get("story", "")).strip():
            old = _load(os.path.join(folder, "project.json")) or {}
            if old.get("shot_list"):
                data = {**data, "shot_list": old["shot_list"]}
                kept = True
    # the auto-save on Run says which save of the project file its tab last saw (based_on). When the file was saved
    # since (from another tab), this tab's Shot List and pictures are older: nothing is written, the file keeps its own.
    based_on = str(data.pop("based_on", "") or "")
    if based_on and folder:
        old = _load(os.path.join(folder, "project.json")) or {}
        newer = _stamp(old.get("saved")) > _stamp(based_on)
        if newer and (old.get("shot_list") != data.get("shot_list") or old.get("references") != data.get("references")):
            print(f"[LC Vision] {project}: project.json kept, the Run came from a tab older than its last save")
            return {"saved": None, "kept_shot_list": False, "kept_stale": True}
    return {"saved": save_project(project, data), "kept_shot_list": kept, "kept_stale": False, "stamp": data.get("saved")}


def _stamp(s) -> float:
    try:
        return datetime.datetime.fromisoformat(str(s).replace("Z", "+00:00")).timestamp()
    except Exception:
        return 0.0


_CARD_KEYS = ("kind", "role", "name", "note", "on", "crop", "text", "trim", "storyboard")


def _input_dir() -> str:
    return folder_paths.get_input_directory()


def sync_assets(folder: str, data: dict) -> int:
    """Every Reference Assembler card (and every Storyboard picture) as a portable asset: its file copied into
    <project>/assets/ and its card (role, name, note, crop, on, ...) in assets/assets.json, so another project can
    📥 Import it. Returns how many cards there are."""
    items = list(((data or {}).get("references") or {}).get("items") or [])
    sb = _load(os.path.join(folder, "storyboard.json")) or {}
    seen = {x.get("file") for x in items}
    items += [x for x in sb.get("items", []) if x.get("file") not in seen]
    if not items:
        return 0
    adir = os.path.join(folder, "assets")
    os.makedirs(adir, exist_ok=True)
    old = (_load(os.path.join(adir, "assets.json")) or {}).get("items", [])
    cards = []
    for it in items:
        src = os.path.join(_input_dir(), str(it.get("file") or ""))
        if not it.get("file") or not os.path.isfile(src):
            continue
        name = os.path.basename(src)
        dst = os.path.join(adir, name)
        if not os.path.exists(dst) or os.path.getmtime(src) > os.path.getmtime(dst) + 1:
            shutil.copy2(src, dst)
        card = {k: it[k] for k in _CARD_KEYS if k in it}
        card.update({"id": str(it.get("id") or name), "file": name, "source": it.get("file")})
        cards.append(card)
    # the cards already there that this Assembler doesn't hold stay (saved by LC H3 Save Assembler Card, or taken
    # out of the Assembler): assets are a store, a Run only adds and updates
    mine = {c["file"] for c in cards}
    merged = cards + [c for c in old if c.get("file") not in mine and os.path.isfile(os.path.join(adir, str(c.get("file", ""))))]
    tmp = os.path.join(adir, "assets.json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"project": os.path.basename(folder), "items": merged}, f, indent=1, ensure_ascii=False)
    os.replace(tmp, os.path.join(adir, "assets.json"))
    return len(merged)


def list_assets(project: str) -> dict:
    folder = _folder(project, any_file=True)
    if not folder:
        return {"project": project, "items": []}
    d = _load(os.path.join(folder, "assets", "assets.json")) or {}
    sub = f"LC_H3/{os.path.basename(folder)}/assets"
    out = []
    for it in d.get("items", []):
        path = os.path.join(folder, "assets", it.get("file", ""))
        if os.path.isfile(path):
            out.append({**it, "url": f"/view?filename={quote(it['file'])}&subfolder={quote(sub)}&type=output&t={int(os.path.getmtime(path))}"})
    return {"project": os.path.basename(folder), "items": out}


def import_assets(source: str, target: str, ids: list) -> dict:
    """📥 Import on the Reference Assembler: the chosen cards of another project, their files copied into
    input/lc_h3_refs/<target>/ (never over a different file), ready to add as cards."""
    src_folder = _folder(source, any_file=True)
    if not src_folder:
        raise ValueError(f"No project called '{source}'.")
    d = _load(os.path.join(src_folder, "assets", "assets.json")) or {}
    want = {str(x) for x in ids or []}
    sub = os.path.join("lc_h3_refs", _name(target) or "imported")
    os.makedirs(os.path.join(_input_dir(), sub), exist_ok=True)
    out = []
    for it in d.get("items", []):
        if want and str(it.get("id")) not in want:
            continue
        srcf = os.path.join(src_folder, "assets", it.get("file", ""))
        if not os.path.isfile(srcf):
            continue
        base, ext = os.path.splitext(it["file"])
        name, k = it["file"], 2
        while os.path.exists(os.path.join(_input_dir(), sub, name)) and not _same_file(srcf, os.path.join(_input_dir(), sub, name)):
            name, k = f"{base}_{k}{ext}", k + 1
        dst = os.path.join(_input_dir(), sub, name)
        if not os.path.exists(dst):
            shutil.copy2(srcf, dst)
        card = {k2: it[k2] for k2 in _CARD_KEYS if k2 in it}
        card.update({"file": f"{sub}/{name}".replace("\\", "/"), "imported_from": os.path.basename(src_folder),
                     "asset_of": os.path.basename(src_folder), "asset_file": it["file"]})
        out.append(card)
    return {"items": out}


def update_asset(project: str, file: str, fields: dict) -> dict:
    """A card edited in a Reference Assembler (role, name, note, crop, line text, trim) saved back into the card it
    came from, in that project's (or the library's) assets."""
    folder = _folder(project, any_file=True)
    if not folder:
        raise ValueError(f"No project called '{project}'.")
    path = os.path.join(folder, "assets", "assets.json")
    d = _load(path) or {}
    hit = next((x for x in d.get("items", []) if x.get("file") == file), None)
    if not hit:
        raise ValueError(f"{project} has no card {file}.")
    for k in ("role", "name", "note", "crop", "text", "trim"):
        if k in fields:
            hit[k] = fields[k]
    with open(path, "w", encoding="utf-8") as f:
        json.dump(d, f, indent=1, ensure_ascii=False)
    return {"saved": file, "project": os.path.basename(folder)}


def _same_file(a: str, b: str) -> bool:
    return os.path.getsize(a) == os.path.getsize(b) and open(a, "rb").read() == open(b, "rb").read()


def save_project(project: str, data: dict) -> str:
    name = _name(project)
    if not name or len(name) > 80:
        raise ValueError("project needs a short folder name, like dinner_scene")
    folder = os.path.join(_root(), name)
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, "project.json")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({**(data or {}), "project": name, "version": 1}, f, indent=1, ensure_ascii=False)
    os.replace(tmp, path)
    try:
        sync_assets(folder, data)  # the cards travel with the project
    except Exception as exc:
        print(f"[LC Vision] project assets not saved: {exc}")
    return path


def thumb(project: str, i: int) -> str | None:
    folder = _folder(project)
    if not folder:
        return None
    src = _seg(folder, i, ".mp4")
    dst = _seg(folder, i, "_thumb.jpg")
    if not os.path.exists(src):
        return None
    if not os.path.exists(dst) or os.path.getmtime(dst) < os.path.getmtime(src):
        ff = shutil.which("ffmpeg")
        if not ff:
            return None
        subprocess.run([ff, "-y", "-v", "error", "-ss", "2.5", "-i", src, "-frames:v", "1", "-vf", "scale=320:-2", "-q:v", "4", dst],
                       capture_output=True)
    return dst if os.path.exists(dst) else None


try:
    from aiohttp import web
    from server import PromptServer

    @PromptServer.instance.routes.get("/lc_vision/movie/projects")
    async def _projects_route(request):
        return web.json_response({"projects": projects()})

    @PromptServer.instance.routes.get("/lc_vision/movie/status")
    async def _status_route(request):
        return web.json_response(status(request.query.get("project", "")))

    @PromptServer.instance.routes.get("/lc_vision/movie/project")
    async def _project_get(request):
        return web.json_response(load_project(request.query.get("project", "")))

    @PromptServer.instance.routes.post("/lc_vision/movie/segment")
    async def _segment_post(request):
        try:
            body = await request.json()
            return web.json_response(edit_segment(body.get("project", ""), int(body.get("index", 0)), body.get("action", ""),
                                                  body.get("anchor_from"), "anchor_from" in body))
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=400)

    @PromptServer.instance.routes.post("/lc_vision/movie/cut")
    async def _cut(request):
        try:
            body = await request.json()
            return web.json_response(cut_shot(str(body.get("project", "")), int(body.get("index", 0))))
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=400)

    @PromptServer.instance.routes.post("/lc_vision/movie/undo")
    async def _undo(request):
        try:
            body = await request.json()
            if body.get("check"):
                return web.json_response(undo_check(str(body.get("project", ""))))
            return web.json_response(undo_last(str(body.get("project", ""))))
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=400)

    @PromptServer.instance.routes.post("/lc_vision/movie/insert")
    async def _insert(request):
        try:
            body = await request.json()
            return web.json_response(insert_shot(str(body.get("project", "")), int(body.get("index", 0)), body.get("shot") or {}))
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=400)

    @PromptServer.instance.routes.post("/lc_vision/movie/join")
    async def _join(request):
        try:
            body = await request.json()
            return web.json_response(set_join(str(body.get("project", "")), int(body.get("index", 0)), str(body.get("join", "cut"))))
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=400)

    @PromptServer.instance.routes.post("/lc_vision/movie/lock")
    async def _lock(request):
        try:
            body = await request.json()
            return web.json_response(set_lock(str(body.get("project", "")), int(body.get("index", 0)), bool(body.get("locked", True))))
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=400)

    @PromptServer.instance.routes.get("/lc_vision/movie/impact")
    async def _impact(request):
        q = request.query
        return web.json_response(impact(q.get("project", ""), int(q.get("index", "0") or 0), q.get("action", "")))

    @PromptServer.instance.routes.get("/lc_vision/assets")
    async def _assets(request):
        return web.json_response(list_assets(request.query.get("project", "")))

    @PromptServer.instance.routes.post("/lc_vision/assets/update")
    async def _assets_update(request):
        try:
            b = await request.json()
            return web.json_response(update_asset(str(b.get("project", "")), str(b.get("file", "")), b.get("fields") or {}))
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=400)

    @PromptServer.instance.routes.post("/lc_vision/assets/import")
    async def _assets_import(request):
        try:
            b = await request.json()
            return web.json_response(import_assets(str(b.get("from", "")), str(b.get("to", "")), b.get("ids") or []))
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=400)

    @PromptServer.instance.routes.post("/lc_vision/movie/project")
    async def _project_post(request):
        try:
            body = await request.json()
            return web.json_response(save_project_checked(body.get("project", ""), body.get("data") or {}))
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=400)

    @PromptServer.instance.routes.get("/lc_vision/movie/thumb")
    async def _thumb_route(request):
        try:
            i = int(request.query.get("i", "0"))
        except ValueError:
            i = 0
        path = thumb(request.query.get("project", ""), i)
        if not path:
            return web.Response(status=404)
        return web.FileResponse(path, headers={"Cache-Control": "no-cache"})
except Exception as e:  # running outside ComfyUI (tests)
    print(f"[LC Vision] movie routes not registered: {e}")
