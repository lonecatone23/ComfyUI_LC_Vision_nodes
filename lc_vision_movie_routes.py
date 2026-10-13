"""
LC Vision movie routes (no node)
--------------------------------
Backs the Vision Assistant's Movie tab: reads the H3 long-video project folders (output/LC_H3/<project>/,
written by LC Vision Director and the LC_AV segment nodes) and reports what is made, what is flagged and
what comes next. Read only, apart from cached thumbnails.

  GET /lc_vision/movie/projects                 -> {"projects": [{name, segments, done, modified}]}
  GET /lc_vision/movie/status?project=NAME      -> plan + per-segment state + the last Assemble report
  GET /lc_vision/movie/thumb?project=NAME&i=N   -> jpg from the middle of segment N
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess

import folder_paths

FACE_SAME, FACE_CLOSE = 0.45, 0.36


def _root() -> str:
    return os.path.join(folder_paths.get_output_directory(), "LC_H3")


def _folder(project: str) -> str | None:
    """Only a direct child of output/LC_H3 that holds a plan, so a name can't walk out of the folder."""
    name = os.path.basename((project or "").strip())
    path = os.path.join(_root(), name)
    return path if name and os.path.isfile(os.path.join(path, "plan.json")) else None


def _load(path: str):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _seg(folder: str, i: int, suffix: str) -> str:
    return os.path.join(folder, f"seg_{i:03d}{suffix}")


def projects() -> list:
    out = []
    root = _root()
    if not os.path.isdir(root):
        return out
    for name in os.listdir(root):
        folder = _folder(name)
        if not folder:
            continue
        plan = _load(os.path.join(folder, "plan.json")) or {}
        n = len(plan.get("shots", []))
        done = sum(1 for i in range(1, n + 1) if os.path.exists(_seg(folder, i, ".json")))
        out.append({"name": name, "segments": n, "done": done, "modified": os.path.getmtime(os.path.join(folder, "plan.json"))})
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
               "end_state": (s.get("redirect") or {}).get("end_state", ""), "done": bool(meta)}
        if meta:
            saved = os.path.getmtime(_seg(folder, i, ".json"))
            latest = max(latest, saved)
            prev_tail = _seg(folder, i - 1, "_tail.mp4")
            made_from = meta.get("from_tail_mtime")
            row.update({
                "seed": meta.get("seed"), "face": meta.get("face"), "look": meta.get("look"), "memory": meta.get("memory"),
                "frames": meta.get("part_frames"), "saved": meta.get("saved", ""), "modified": saved,
                "stale": bool(row["mode"] == "CONTINUE" and made_from and os.path.exists(prev_tail)
                              and abs(os.path.getmtime(prev_tail) - made_from) > 1),
            })
        segs.append(row)
    full = os.path.join(folder, f"{os.path.basename(folder)}_full.mp4")
    report = _load(os.path.join(folder, "seams.json")) or {}
    if isinstance(report, list):  # older reports were just the join list
        report = {"joins": report}
    full_mtime = os.path.getmtime(full) if os.path.exists(full) else 0
    return {
        "project": os.path.basename(folder), "subfolder": f"LC_H3/{os.path.basename(folder)}",
        "style": plan.get("style", ""), "segment_s": plan.get("segment_s"), "overlap_s": plan.get("overlap_s"),
        "warnings": plan.get("warnings", []), "segments": segs,
        "full": os.path.basename(full) if full_mtime else "", "full_outdated": bool(full_mtime and latest > full_mtime + 1),
        "report": report if full_mtime else {}, "face_same": FACE_SAME, "face_close": FACE_CLOSE,
    }


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
