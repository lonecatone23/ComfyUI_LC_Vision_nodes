"""
LC Vision Storyboard Builder + Save (BETA): reference pictures for a Showrunner movie, made with an image model
(Krea 2 now, Z-Image next) in a separate workflow.

The Builder reads the project (output/LC_H3/<project>/project.json: the Shot List and the pictures you already have)
and lists what is missing: a face for each cast member, a picture of each place, an anchor (the opening wide shot) for
each place with several people. It writes one prompt per missing picture, plus an empty latent and a seed for each,
so the sampler makes them all in one queue. Nothing here is required: a movie runs without any of it.

The Save writes the pictures to input/lc_h3_refs/<project>/ and lists them in the project (storyboard.json, and the
project's own reference list). 📂 Load on the Showrunner adds them to the Reference Assembler.
"""

from __future__ import annotations

import json
import os
import re
import zlib

import numpy as np
import torch

try:
    import folder_paths
except Exception:  # outside ComfyUI (tests)
    folder_paths = None

from .lc_vision_styles import STYLE_TAG_OPTIONS

# per image model: how its prompts read and the sizes it likes (both want plain sentences; Z-Image is set up for
# when its workflow exists)
FAMILIES = {
    "Krea 2": {"multiple": 16, "suffix": "Natural light, sharp focus, photographic."},
    "Z-Image": {"multiple": 16, "suffix": "Natural light, sharp focus, realistic photo."},
}
KINDS = ("face", "place", "anchor")
_CLOSE = re.compile(r"close", re.I)


def _root() -> str:
    base = folder_paths.get_output_directory() if folder_paths else os.path.join(os.getcwd(), "output")
    return os.path.join(base, "LC_H3")


def _input_dir() -> str:
    return folder_paths.get_input_directory() if folder_paths else os.path.join(os.getcwd(), "input")


def _safe(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9 _-]", "", str(name or "")).strip().replace(" ", "_")[:60] or "untitled"


def _load(path: str):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _write(path: str, data) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1, ensure_ascii=False)
    os.replace(tmp, path)


FROM_SHOWRUNNER = "from Showrunner"


def style_words(d: dict, style_tag: str = FROM_SHOWRUNNER, style: str = "") -> str:
    """The words a style tag adds to an image prompt (the same tags as every Vision node). "from Showrunner" = the
    project's style_tag, so the pictures match the movie. NSFW is an instruction for a language model, not a look:
    nothing is added for it."""
    from .lc_vision_styles import STYLE_TAG_DESCRIPTIONS
    tag = (d.get("director") or {}).get("style_tag", "None") if style_tag == FROM_SHOWRUNNER else style_tag
    words = "" if tag in ("None", "NSFW") else STYLE_TAG_DESCRIPTIONS.get(tag, "").replace(" -- ", ", ")
    return ", ".join(x for x in (words, str(style or "").strip().rstrip(".")) if x)


def project_data(project: str) -> dict:
    return _load(os.path.join(_root(), _safe_folder(project), "project.json")) or {}


def _safe_folder(project: str) -> str:
    """Same rule as the movie routes (and the Showrunner's project_dir): a direct child of output/LC_H3."""
    safe = re.sub(r"[^A-Za-z0-9 _.-]", "_", str(project or "").strip())
    return safe if safe.strip(" .") else ""


def _sb_path(project: str) -> str:
    return os.path.join(_root(), _safe_folder(project), "storyboard.json")


def prompt_overrides(project: str) -> dict:
    """Your own words for a picture (✎ on the Storyboard Sheet), by "kind:name"."""
    return (_load(_sb_path(project)) or {}).get("prompts", {})


def set_prompt(project: str, kind: str, name: str, text: str) -> dict:
    path = _sb_path(project)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    sb = _load(path) or {"items": []}
    pr = sb.setdefault("prompts", {})
    key = f"{kind}:{name}"
    if str(text or "").strip():
        pr[key] = str(text).strip()
    else:
        pr.pop(key, None)
    _write(path, sb)
    return {"saved": key, "custom": key in pr}


def retakes(project: str) -> dict:
    """How many times each picture was made again with ↻, by "kind:name". Added into its seed, so a redo comes out
    different even when the seed input is wired from a fixed seed node."""
    return (_load(_sb_path(project)) or {}).get("takes", {})


def add_retake(project: str, kind: str, name: str) -> dict:
    path = _sb_path(project)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    sb = _load(path) or {"items": []}
    takes = sb.setdefault("takes", {})
    key = f"{kind}:{name}"
    takes[key] = int(takes.get(key, 0)) + 1
    _write(path, sb)  # storyboard.json changes, so the Builder runs again (IS_CHANGED)
    return {"take": takes[key]}


def storyboard_items(project: str) -> list:
    """The pictures the Storyboard Save made for this project (storyboard.json)."""
    d = _load(os.path.join(_root(), _safe_folder(project), "storyboard.json")) or {}
    return d.get("items", [])


def _have(items: list, roles: tuple, name: str) -> bool:
    n = name.strip().lower()
    return any(it.get("on", True) and it.get("role") in roles and str(it.get("name", "")).strip().lower() == n
               for it in items)


def _people_in(shot: dict, cast: list) -> list:
    text = " ".join(str(shot.get(k) or "") for k in ("action", "speaker", "after"))
    named = [c for c in cast if re.search(rf"\b{re.escape(c['name'])}\b", text)]
    if shot.get("subject") in [c["name"] for c in cast] and not any(c["name"] == shot["subject"] for c in named):
        named.insert(0, next(c for c in cast if c["name"] == shot["subject"]))
    return named


def wanted(project: str) -> list:
    """Every picture the movie could use, each {kind, name, have}: a face per cast member, a picture per place, and an
    anchor per place that has a shot of more than one person. `have` = you already have one (Assembler or
    storyboard)."""
    d = project_data(project)
    sl = d.get("shot_list") or {}
    cast = [c for c in (sl.get("cast") or []) if str(c.get("name", "")).strip()]
    items = list((d.get("references") or {}).get("items") or []) + storyboard_items(project)
    out = []
    for c in cast:
        out.append({"kind": "face", "name": c["name"].strip(), "have": _have(items, ("face", "full body"), c["name"])})
    places = []
    for s in sl.get("shots") or []:
        w = str(s.get("where") or "").strip()
        if w and w.lower() not in [p.lower() for p in places]:
            places.append(w)
    for w in places:
        out.append({"kind": "place", "name": w, "have": _have(items, ("setting", "layout"), w)})
    for w in places:
        shots = [s for s in sl.get("shots") or [] if str(s.get("where") or "").strip().lower() == w.lower()]
        if any(len(_people_in(s, cast)) > 1 for s in shots):
            out.append({"kind": "anchor", "name": w, "have": _have(items, ("layout",), w)})
    return out


def missing(project: str) -> list:
    return [w for w in wanted(project) if not w["have"]]


# image models read a plain "ski mask" on a calm portrait as a surgical mask: spell the balaclava out
_SKI_MASK = re.compile(r"\bski[- ]?mask\b(?! \()", re.I)

# a ↻ redo of a face only moves the seed, and a low-cfg model barely changes with the seed: each take adds a
# different face to the same look
_TAKE_FACES = (
    "a narrow face with high cheekbones", "a broad face and a square jaw", "deep-set eyes and heavy brows",
    "a long face and a crooked nose", "a round face and soft features", "sharp features and thin lips",
    "a weathered face with deep lines", "wide-set eyes and a strong chin", "a gaunt face and hollow cheeks",
    "a heavy brow and a flat nose",
)


def _look(c: dict) -> str:
    who = str(c.get("who") or "person").strip()
    look = str(c.get("look") or "").strip().rstrip(".")
    look = _SKI_MASK.sub("ski mask (a knitted balaclava over the whole head and face, only the eyes showing)", look)
    return f"a {who}, {look}" if look else f"a {who}"


_SMALL = {"the", "inside", "outside", "into", "near", "with", "from", "front", "back"}


def _place_words(place: str, name: str) -> str:
    """The Shot List's Place line, as much of it as belongs to this place: "Midday downtown: a big stone bank ...,
    and inside, a marble lobby" keeps it all for the bank lobby, only "Midday downtown" for inside the van."""
    head, sep, rest = place.partition(":")
    if not sep:
        head, rest = "", place
    words = [w for w in re.findall(r"[a-z]+", name.lower()) if len(w) > 2 and w not in _SMALL]
    keep = rest.strip() if any(re.search(rf"\b{w}", rest.lower()) for w in words) else ""
    return ". ".join(x for x in (head.strip(), keep) if x)


def _sentences(text: str) -> str:
    """Capital letter after every full stop, no doubled stops."""
    text = re.sub(r"\.\s*\.", ".", re.sub(r"\s+", " ", text)).strip()
    return re.sub(r"(^|[.!?]\s+)([a-z])", lambda m: m.group(1) + m.group(2).upper(), text)


def build_prompt(kind: str, name: str, d: dict, family: str = "Krea 2", style: str = "", take: int = 0) -> str:
    """The image prompt for one picture, in plain sentences from the Shot List's own words."""
    sl = d.get("shot_list") or {}
    cast = [c for c in (sl.get("cast") or []) if str(c.get("name", "")).strip()]
    place = str(sl.get("place") or "").strip().rstrip(".")
    suffix = FAMILIES.get(family, FAMILIES["Krea 2"])["suffix"]
    extra = f" {style.strip().rstrip('.')}." if style.strip() else ""
    if kind == "face":
        c = next((c for c in cast if c["name"].strip() == name), {"who": "person", "look": ""})
        face = f" {_TAKE_FACES[(take - 1) % len(_TAKE_FACES)].capitalize()}." if take > 0 else ""
        return _sentences(f"A head and shoulders portrait photo of {_look(c)}.{face} Looking straight at the camera with a "
                          f"calm, neutral expression, soft even light, plain light grey background.{extra} {suffix}")
    shots = [s for s in sl.get("shots") or [] if str(s.get("where") or "").strip().lower() == name.lower()]
    where = _place_words(place, name)
    if kind == "place":
        return _sentences(f"A wide establishing photo of {name}, with nobody in it. {where}. Eye level, 35mm lens, the "
                          f"whole space in view.{extra} {suffix}")
    # anchor: the first wide shot there with several people (else the first that isn't a close-up)
    many = [s for s in shots if len(_people_in(s, cast)) > 1]
    s = next((s for s in many if "wide" in str(s.get("framing") or "")), None) \
        or next((s for s in many if not _CLOSE.search(str(s.get("framing") or ""))), shots[0] if shots else {})
    people = _people_in(s, cast)
    action = str(s.get("action") or "").strip().rstrip(".")
    for c in people:  # the image model doesn't know the names: each one becomes their look, once
        action = re.sub(rf"\b{re.escape(c['name'])}\b", f"the {c.get('who') or 'person'} ({c.get('look', '').strip()})", action, count=1)
        action = re.sub(rf"\b{re.escape(c['name'])}\b", f"the {c.get('who') or 'person'}", action)
    return _sentences(f"A wide film still at {name}. {where}. {action}.{extra} Cinematic framing, eye level. {suffix}")


def _size(kind: str, family: str, portrait: int, wide_w: int, wide_h: int) -> tuple:
    m = FAMILIES.get(family, FAMILIES["Krea 2"])["multiple"]
    w, h = (portrait, portrait) if kind == "face" else (wide_w, wide_h)
    return (max(m, w // m * m), max(m, h // m * m))


class LCVisionStoryboardBuilder:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "project_name": ("STRING", {"forceInput": True, "tooltip": "The project: wire LC Vision Showrunner's project_name output."}),
                "vae": ("VAE", {"tooltip": "The image model's VAE: sets the size of the empty latents."}),
                "base_model": (list(FAMILIES), {"default": "Krea 2", "tooltip": "The image model, for how the prompts read and the sizes it likes."}),
                "make": (["missing only", "everything"], {"default": "missing only", "tooltip": "missing only: just the pictures the project doesn't have yet. everything: all of them again (your own pictures are never replaced)."}),
                "faces": ("BOOLEAN", {"default": True, "tooltip": "A head and shoulders portrait of each cast member, from their look."}),
                "places": ("BOOLEAN", {"default": True, "tooltip": "An empty establishing picture of each place in the Shot List."}),
                "anchors": ("BOOLEAN", {"default": True, "tooltip": "The opening wide shot of each place with several people, with the people in place: holds the room and who stands where."}),
                "portrait_size": ("INT", {"default": 1024, "min": 512, "max": 2048, "step": 16, "tooltip": "Square size of the cast portraits."}),
                "landscape_width": ("INT", {"default": 1344, "min": 512, "max": 2560, "step": 16, "tooltip": "Width of the place pictures and anchors. 1344 x 768 matches the movie's 960 x 544 shape."}),
                "landscape_height": ("INT", {"default": 768, "min": 512, "max": 2048, "step": 16, "tooltip": "Height of the place pictures and anchors."}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff, "tooltip": "Each picture's seed comes from this plus its name, so a redo of one picture keeps the others."}),
            },
            "optional": {
                "only": ("STRING", {"default": "", "tooltip": "Optional. Names to make (again), comma separated, like: Earl, the bank lobby. Blank = everything make and the switches allow."}),
                "style": ("STRING", {"default": "", "multiline": True, "tooltip": "Optional. Words added to every prompt (a film look, a period)."}),
                "style_tag": ([FROM_SHOWRUNNER] + STYLE_TAG_OPTIONS, {"default": FROM_SHOWRUNNER,
                              "tooltip": "The look of every picture, the same tags as the other Vision nodes. from Showrunner = "
                                         "the Showrunner's style_tag, so the pictures match the movie."}),
            },
        }

    RETURN_TYPES = ("LATENT", "STRING", "INT", "STRING", "STRING")
    RETURN_NAMES = ("latent", "prompt", "seed", "job", "summary")
    OUTPUT_IS_LIST = (True, True, True, True, False)
    FUNCTION = "build"
    CATEGORY = "LC Vision/movie"
    DESCRIPTION = ("Pictures for a Showrunner movie: finds what the project is missing (faces, places, anchors) and "
                   "makes one prompt, latent and seed per picture for the sampler. Feed LC Vision Storyboard Save.")

    @classmethod
    def IS_CHANGED(cls, project_name="", **kw):
        if not isinstance(project_name, str):  # on a wire: not handed to IS_CHANGED, so always look again (cheap)
            return float("nan")
        project = project_name
        folder = os.path.join(_root(), _safe_folder(project))
        return "|".join(str(os.path.getmtime(os.path.join(folder, f))) if os.path.exists(os.path.join(folder, f)) else "-"
                        for f in ("project.json", "storyboard.json"))

    def build(self, project_name, vae, base_model, make, faces, places, anchors, portrait_size, landscape_width,
              landscape_height, seed, only="", style="", style_tag=FROM_SHOWRUNNER):
        family = base_model
        project = str(project_name or "").strip()
        d = project_data(project)
        if not d:
            raise ValueError(f"[LC Vision] Storyboard Builder: no project '{project}' in output/LC_H3. Run the Showrunner (or 💾 Save it) once first.")
        on = {"face": faces, "place": places, "anchor": anchors}
        names = {x.strip().lower() for x in str(only or "").split(",") if x.strip()}

        def picked(w):
            return not names or w["name"].lower() in names or f"{w['kind']}: {w['name']}".lower() in names

        takes = retakes(project)
        jobs = [w for w in wanted(project) if (on[w["kind"]] or names) and (make == "everything" or not w["have"]) and picked(w)]
        custom = prompt_overrides(project)
        style = style_words(d, style_tag, style)
        have = [w for w in wanted(project) if w["have"]]
        lines = [f"Storyboard for {project} ({family}): {len(jobs)} to make."]
        for w in jobs:  # say when your ✎ words and a ↻ take are used, so you can see it on the node
            k = f"{w['kind']}:{w['name']}"
            lines.append(f"  + {w['kind']}: {w['name']}" + (f"  (take {takes[k] + 1})" if takes.get(k) else "")
                         + (f"\n      ✎ your words: {custom[k][:100]}" if k in custom else ""))
        if have:
            lines.append("Already there: " + ", ".join(f"{w['kind']} {w['name']}" for w in have) + ".")
        summary = "\n".join(lines)
        if not jobs:
            from comfy_execution.graph import ExecutionBlocker
            summary += "\nNothing to make."
            return {"ui": {"text": [summary]}, "result": ([ExecutionBlocker(None)], [ExecutionBlocker(None)],
                                                          [ExecutionBlocker(None)], [ExecutionBlocker(None)], summary)}
        ch = getattr(vae, "latent_channels", 16)
        down = vae.spacial_compression_encode() if hasattr(vae, "spacial_compression_encode") else 8
        lat, prompts, seeds, out_jobs = [], [], [], []
        for w in jobs:
            wd, ht = _size(w["kind"], family, portrait_size, landscape_width, landscape_height)
            lat.append({"samples": torch.zeros([1, ch, ht // down, wd // down])})
            key = f"{w['kind']}:{w['name']}"
            prompts.append(custom.get(key) or build_prompt(w["kind"], w["name"], d, family, style, int(takes.get(key, 0))))
            seeds.append((int(seed) + zlib.crc32(key.encode()) + 1000003 * int(takes.get(key, 0))) % 0xffffffffffffffff)
            out_jobs.append(json.dumps({"project": project, "kind": w["kind"], "name": w["name"], "family": family}))
        return {"ui": {"text": [summary]}, "result": (lat, prompts, seeds, out_jobs, summary)}


ROLE = {"face": "face", "place": "setting", "anchor": "layout"}


def save_pictures(images: list, jobs: list) -> tuple:
    """Write each picture to input/lc_h3_refs/<project>/ and list it in the project. Returns (saved items, sheet)."""
    saved, tiles = [], []
    for img, job in zip(images, jobs):
        if not isinstance(job, (str, dict)):  # a blocked job (nothing to make)
            continue
        j = json.loads(job) if isinstance(job, str) else job
        project, kind, name = j["project"], j["kind"], j["name"]
        sub = os.path.join("lc_h3_refs", _safe(project))
        os.makedirs(os.path.join(_input_dir(), sub), exist_ok=True)
        fname = f"sb_{kind}_{_safe(name)}.png"
        arr = (img[0].clamp(0, 1).cpu().numpy() * 255).astype(np.uint8)
        from PIL import Image
        Image.fromarray(arr).save(os.path.join(_input_dir(), sub, fname))
        tiles.append(arr)
        d = project_data(project)
        cast = {c.get("name", "").strip(): c for c in ((d.get("shot_list") or {}).get("cast") or [])}
        item = {"id": f"sb_{kind}_{_safe(name)}", "kind": "image", "file": f"{sub}/{fname}".replace("\\", "/"),
                "on": True, "role": ROLE[kind], "name": name,
                "note": str(cast.get(name, {}).get("look", "")) if kind == "face" else "", "crop": [0, 0, 1, 1],
                "storyboard": True}
        folder = os.path.join(_root(), _safe_folder(project))
        os.makedirs(folder, exist_ok=True)
        # storyboard.json: the Storyboard's own list (a movie Run re-saves project.json from the Assembler)
        sb_path = os.path.join(folder, "storyboard.json")
        sb = _load(sb_path) or {"items": []}
        sb["items"] = [x for x in sb["items"] if x.get("id") != item["id"]] + [item]
        _write(sb_path, sb)
        saved.append(item)
    return saved, tiles


class LCVisionStoryboardSave:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "images": ("IMAGE", {"tooltip": "The pictures from the sampler, one per Builder job."}),
            "job": ("STRING", {"forceInput": True, "tooltip": "The Builder's job output (which picture is which)."}),
        }}

    INPUT_IS_LIST = True
    RETURN_TYPES = ("IMAGE", "STRING")
    RETURN_NAMES = ("sheet", "summary")
    OUTPUT_NODE = True
    FUNCTION = "save"
    CATEGORY = "LC Vision/movie"
    DESCRIPTION = ("Saves the Storyboard Builder's pictures to input/lc_h3_refs/<project>/ and lists them in the "
                   "project. 📂 Load on the Showrunner adds them to the Reference Assembler.")

    def save(self, images, job):
        imgs = [im[k:k + 1] for im in images for k in range(im.shape[0])]
        saved, tiles = save_pictures(imgs, job)
        lines = [f"Saved {len(saved)} picture(s). One for something the Reference Assembler has nothing for goes in by itself; ✅ Use swaps one in."]
        lines += [f"  {it['role']}: {it['name']}  ({it['file']})" for it in saved]
        summary = "\n".join(lines)
        h = 320
        row = []
        from PIL import Image
        for t in tiles:
            im = Image.fromarray(t)
            im = im.resize((max(1, int(im.width * h / im.height)), h))
            row.append(np.asarray(im))
        sheet = np.concatenate(row, axis=1) if row else np.zeros((64, 64, 3), np.uint8)
        try:
            from server import PromptServer  # the H3 workflow, if open, can pick them up
            first = json.loads(job[0]) if job and isinstance(job[0], str) else {}
            PromptServer.instance.send_sync("lc_storyboard_saved", {"project": first.get("project", ""), "items": saved})
        except Exception:
            pass
        return {"ui": {"text": [summary]}, "result": (torch.from_numpy(sheet.astype(np.float32) / 255.0)[None], summary)}


def sheet_status(project: str) -> dict:
    """Every picture the movie could use, for the Storyboard Sheet's cards: made or not, in use or not, its prompt."""
    d = project_data(project)
    if not d:
        return {"project": project, "error": f"No project '{project}' yet. Run the Showrunner (or 💾 Save) once."}
    made = {(x.get("role"), str(x.get("name", "")).lower()): x for x in storyboard_items(project)}
    refs = list((d.get("references") or {}).get("items") or [])
    custom = prompt_overrides(project)
    cards = []
    for w in wanted(project):
        role = ROLE[w["kind"]]
        it = made.get((role, w["name"].lower()))
        url, mtime = "", 0
        if it:
            path = os.path.join(_input_dir(), it["file"])
            if os.path.exists(path):
                mtime = os.path.getmtime(path)
                sub, fn = os.path.split(it["file"])
                url = f"/view?filename={fn}&subfolder={sub}&type=input&t={int(mtime)}"
        own = [x for x in refs if x.get("role") in ((role, "full body") if role == "face" else (role,))
               and str(x.get("name", "")).strip().lower() == w["name"].lower() and not x.get("storyboard")]
        cards.append({"kind": w["kind"], "name": w["name"], "role": role, "item": it if url else None, "url": url,
                      "used": bool(it) and any(x.get("file") == it["file"] for x in refs), "own": bool(own),
                      "custom": f"{w['kind']}:{w['name']}" in custom,
                      "prompt": custom.get(f"{w['kind']}:{w['name']}") or build_prompt(w["kind"], w["name"], d, style=style_words(d))})
    return {"project": project, "cards": cards}


class LCVisionStoryboardSheet:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}}

    RETURN_TYPES = ()
    FUNCTION = "noop"
    CATEGORY = "LC Vision/movie"
    DESCRIPTION = ("The storyboard on the node: a card for every picture the movie can use (faces, places, anchors). ✅ Use "
                   "puts one in the Reference Assembler, ↻ makes it again, ✎ changes its prompt. Nothing to wire: it follows "
                   "the Showrunner's project.")

    def noop(self):
        return ()


def _routes():
    try:
        from aiohttp import web
        from server import PromptServer
    except Exception:
        return
    if not hasattr(PromptServer, "instance"):
        return

    @PromptServer.instance.routes.get("/lc_vision/storyboard/status")
    async def _status(request):
        return web.json_response(sheet_status(request.rel_url.query.get("project", "")))

    @PromptServer.instance.routes.post("/lc_vision/storyboard/prompt")
    async def _prompt(request):
        try:
            b = await request.json()
            return web.json_response(set_prompt(str(b.get("project", "")), str(b.get("kind", "")), str(b.get("name", "")), b.get("prompt", "")))
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=400)

    @PromptServer.instance.routes.post("/lc_vision/storyboard/retake")
    async def _retake(request):
        try:
            b = await request.json()
            return web.json_response(add_retake(str(b.get("project", "")), str(b.get("kind", "")), str(b.get("name", ""))))
        except Exception as exc:
            return web.json_response({"error": str(exc)}, status=400)

    @PromptServer.instance.routes.get("/lc_vision/storyboard/missing")
    async def _missing(request):
        p = request.rel_url.query.get("project", "")
        return web.json_response({"project": p, "missing": missing(p), "items": storyboard_items(p)})


_routes()

NODE_CLASS_MAPPINGS = {"LCVisionStoryboardBuilder": LCVisionStoryboardBuilder, "LCVisionStoryboardSave": LCVisionStoryboardSave,
                       "LCVisionStoryboardSheet": LCVisionStoryboardSheet}
NODE_DISPLAY_NAME_MAPPINGS = {"LCVisionStoryboardBuilder": "LC Vision Storyboard Builder (BETA) 🎞️",
                              "LCVisionStoryboardSave": "LC Vision Storyboard Save (BETA) 🎞️",
                              "LCVisionStoryboardSheet": "LC Vision Storyboard Sheet (BETA) 🎞️"}
