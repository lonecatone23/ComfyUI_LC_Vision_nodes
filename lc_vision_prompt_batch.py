"""
LC Vision Smart Prompt Batch 🎓: an intelligent wildcard processor.

One base prompt, the parts to change (Location, Time of day, Hair color ...), and a count. The node cuts the base into
short phrases and the vision model labels each one once:
  vary   - states a picked part, wherever it sits in the prompt
  follow - not a picked part, but would contradict the new version (a role, an action, light details): smallest change
  keep   - everything else
Each queue it writes N variants in one JSON answer (a short idea, then one new text per vary / follow phrase), and the
node pastes them into the base. Kept text is never rewritten by the model, so the person, the outfit and the look stay
word for word. A new seed = a new batch of N. `variation` is the token budget each variant may spend.

Optional: Enhance base (once; kept on the node until cleared or the base changes), with a style tag and a max_tokens
length. To start from a picture, caption it first (LC Vision Caption, optionally through LC Vision Filter), edit the
caption, then paste it into the prompt box.
"""
from __future__ import annotations

import hashlib
import json
import re

from .lc_vision_generate import budget_line, generate_with_recovery, release, trim_to_sentence
from .lc_vision_loader import LCVisionModel, MODEL_TYPE, strip_thinking
from .lc_vision_prompt_order import ORDER_RULE, PART_SLOT, POSE_RULE
from .lc_vision_styles import STYLE_TAG_OPTIONS, apply_style_tag_to_text

NODE_ID = "LCVisionPromptBatch"
NODE_DISPLAY_NAME = "LC Vision Smart Prompt Batch 🎓"

PARTS = ["Camera angle", "Framing", "Lighting", "Time of day", "Location", "Weather", "Season", "Hair color",
         "Hairstyle", "Outfit", "Expression", "Pose"]

_SPLITS: dict[str, dict] = {}  # base + parts -> labelled phrases (one call; reused for every seed)

SPLIT_RULES = (
    "You sort the phrases of an image prompt for a batch generator. The user picks which parts of the picture change. "
    "Label every numbered phrase with one word:\n"
    "vary: the phrase states one of the picked parts (anywhere: the scene sentence, the framing line, the closing "
    "quality words).\n"
    "A place is more than its name: it is also the set dressing (railings, fences, string lights, lanterns, furniture, "
    "signs, walls, windows), the background (a skyline, the sky, the view behind), what the person leans on, sits on or "
    "holds that belongs to the place, and place words in the closing summary (urban, street, alpine, coastal). Every "
    "one of those phrases is vary or follow when the place is picked. A time of day is also the sky color and words "
    "like nighttime or daylight anywhere in the prompt.\n"
    "follow: the phrase is not a picked part, but it would contradict a new version of it, so it must adapt (a job or "
    "role tied to the place, an action that uses something in the place, light or weather details that belong to the "
    "place, quality words naming the place).\n"
    "keep: everything else. The person's age, face, eyes, hair, body, the outfit, the expression, the camera and film "
    "look are always keep unless the user picked that part.\n"
    "old_words: every single word anywhere in the prompt that names the current version of the picked parts (for a "
    "place: its nouns and adjectives like sea, ocean, coastal, fortress, gate, arch, masonry; for a hair color: the "
    "color words only).\n"
    "Answer with the JSON only.")

VARIANT_RULES = (
    "You write variations for a batch image generator. You get the numbered phrases of a prompt that must change. "
    "Write {n} variants. For each variant first name the new idea in a few words (idea), then give one new text per "
    "phrase, in the same order (texts).\n"
    "Picked parts: {parts}. Each variant's idea is a new, specific, believable version of them. Spread the ideas far "
    "apart: different from the original and from each other in kind, not just in name (for a place: other terrain, "
    "climate, country, indoors or outdoors, city or wild; for a time of day: the whole day from dawn to night; for a "
    "color: across the range). Do not reuse the original's nouns for the picked parts. When several parts are picked, "
    "every idea changes all of them (a place AND a time of day: \"a desert market at noon\").\n"
    "The idea names ONLY the picked parts, nothing else: a pose is a body position (\"kneeling, one hand on the "
    "latch\"), a camera angle is a viewpoint (\"low angle from below\"), an expression is a face (\"a wry half smile\"). "
    + POSE_RULE + " "
    "Never put a place, a time, weather or a mood in an idea unless that part is picked. A camera angle is a real "
    "camera position (low angle, high angle, bird's-eye, worm's-eye, eye level, over the shoulder, profile, from "
    "behind, Dutch angle, close-up, extreme wide): no reflections, mirrors or frames to look through.\n"
    "Write only the replacement for each phrase; never repeat the words that come after it in the prompt. Keep the "
    "small linking words of the original phrase (standing on a rooftop -> standing in an ice canyon, never standing an "
    "ice canyon).\n"
    "Never change the style or medium words (portrait, photograph, film, cinematic, sketch, painterly, illustration): "
    "the picture stays the same kind of picture.\n"
    "Read the picked parts literally: a hair color changes the color words only (the style, length and the rest of "
    "the phrase stay), an outfit changes the clothes only, a time of day changes the time and its light only.\n"
    "Phrases marked VARY: rewrite the words that state the picked parts to state the new idea; keep the other words "
    "of the phrase.\n"
    "Phrases marked FOLLOW: replace only the words that belong to the old version (old words: {old}) with ones that "
    "fit the new idea, and keep every other word exactly. None of the old words may remain in a variant unless its "
    "new idea really has that thing.\n"
    "Change nothing that is not a picked part: no new time of day, weather, season, clothing, hair or expression "
    "unless it is picked.\n"
    "Every text must fit where it sits in the prompt (shown for context): same grammar, so the sentence still reads, "
    "and all texts of one variant describe one coherent picture. Never change anything that is not in the list.\n"
    "Spend about {words} words per variant on the texts in total. Answer with the JSON only.")

ENHANCE_RULES = (
    "Rewrite the user's image prompt into a richer one paragraph prompt. Keep every fact the user gave, word for word "
    "where you can (the person, their age, face, eyes, hair, the outfit, the place, the light, the look); only add "
    "concrete visual detail (or, when the length asks for less, tighten it and keep the facts that matter most). "
    + ORDER_RULE + " " + POSE_RULE + " No lists, no headings. Output only the prompt.")

CHECK_RULES = (
    "A batch generator swapped parts of an image prompt. For each new picture, list the numbers of the kept phrases "
    "that no longer fit it: a thing that is not in the new place, a sky or a light that cannot be there, a time word "
    "that clashes, a closing summary that names the old place. Phrases about the person, the outfit, the face, the "
    "expression and the camera or film look always fit. Leave the list empty when everything fits. Answer with the "
    "JSON only.")


def _h(*parts: str) -> str:
    return hashlib.sha1("\x1f".join(parts).encode("utf-8")).hexdigest()[:16]


def _parts(vary: str) -> list[str]:
    return [p.strip() for p in re.split(r"[,\n;]+", vary or "") if p.strip()]


def _ask(vm: LCVisionModel, system: str, user, max_tokens: int, temperature: float, seed: int, schema=None) -> str:
    if getattr(vm, "is_qwen3_family", False) and isinstance(user, str):
        user = "/no_think\n" + user
    kw = dict(messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
              max_tokens=max_tokens, temperature=temperature, top_p=0.95, repeat_penalty=1.05, seed=seed)
    if schema is not None:
        kw["response_format"] = {"type": "json_object", "schema": schema}
    r = generate_with_recovery(vm, **kw)
    return strip_thinking((r["choices"][0].get("message", {}).get("content") or "").strip())


def _json(text: str) -> dict:
    try:
        return json.loads(text)
    except Exception:
        m = re.search(r"\{.*\}", text or "", re.S)
        if m:
            try:
                return json.loads(m.group(0))
            except Exception:
                pass
    return {}


_LINKS = set("in on at inside atop under beneath among amid within beside near by".split())

_STOP = set("""a an the and or of in on at to with by for from into over under near next before after behind through her his
their its she he they it is are was be being been very soft big small whole wide view foreground background scene lit light
looking look photo picture image shot film still style fine grain crisp clear sharp detailed""".split())


# words that belong to a part: when that part is not picked, a variant must keep them (the model likes to change the
# time of day along with a place, or the hairstyle along with a hair color)
GROUPS = {
    "time": ({"time of day", "lighting", "light"}, set("""dawn dusk noon midday night midnight sunset sunrise morning evening
afternoon twilight golden hour overcast daylight moonlight nightfall daybreak daytime nighttime sunlit sunlight
sunshine sun starlit moonlit""".split())),
    "weather": ({"weather"}, set("""rain rainy storm stormy snow snowy fog foggy mist misty overcast drizzle wind windy
thunder sunny cloudy""".split())),
    "season": ({"season"}, set("spring summer autumn fall winter".split())),
    "hairstyle": ({"hairstyle", "hair style"}, set("""bun buns braid braids braided ponytail pigtails bob curls curly wavy
updo chignon topknot sleek cropped pixie fringe bangs""".split())),
    "style": ({"style"}, set("""portrait photograph photography cinematic sketch painterly painting illustration drawing
anime cartoon render""".split())),
}

# set dressing and background: with Location picked, a kept phrase naming one of these adapts (the railing and the
# string lights stayed in an ice canyon, a city skyline in the desert)
PLACE_WORDS = set("""railing railings fence fences balcony rooftop roof terrace bench benches lights lanterns bulbs lamp
lamps neon sign signs wall walls window windows door doors table tables chair chairs counter bar shelf shelves skyline city
cityscape street streets buildings building tower towers sky skies horizon urban downtown alley crowd traffic cars
bridge pier dock harbor river lake sea ocean beach sand dunes mountains mountain forest trees meadow glass pane panes
raindrops windowsill sill""".split())
_FILM = set("bokeh grain grainy film lens aperture focus depth exposure".split())
_PERSON = set("""woman women man men girl girls boy boys person lady gentleman child kid teen teenager""".split())
# words that name the place itself: with Location picked, the phrase is the place
PLACE_HEAD = set("""setting location background backdrop surroundings environment landscape scenery outdoor outdoors
indoor indoors interior exterior wooded woods woodland""".split())
# her face and the details of her clothes: never move with a place, a time or the weather (green eyes, a fur-lined hood)
_FACE = set("""eye eyes eyebrows brows lashes eyelashes iris irises freckles freckled skin complexion lips lip nose cheeks
cheekbones forehead chin jaw makeup lipstick eyeliner mascara blush""".split())
_GARMENT = set("""hood hooded fur trim collar lining lined zipper zip sleeve sleeves cuff cuffs buttons button lace wool
woolen knit knitted fleece leather denim fabric silk satin velvet cotton linen pocket pockets neckline hem""".split())


def _unpicked_self(parts, text: str) -> bool:
    """The phrase is about her hair, her face, her outfit or the film look, and that part was not picked."""
    picked = " | ".join(p.lower() for p in parts)
    raw = set(re.findall(r"[a-z]+", text.lower()))
    # "light ... her face and hair" is the light, not her hair: light / dark alone are not a hair color here
    if ("hair" in raw and raw & (_COLORS - {"light", "dark"}) or raw & GROUPS["hairstyle"][1]) and "hair" not in picked:
        return True
    if _lex_hit("outfit", text) and "outfit" not in picked and "cloth" not in picked:
        return True
    lit = bool(raw & LEX["lighting"] or raw & PLACE_WORDS)  # "light on her face", "shadows on the fur": the light
    if not lit and raw & _GARMENT and "outfit" not in picked and "cloth" not in picked:
        return True
    if not lit and raw & _FACE and not any(x in picked for x in ("expression", "eye", "makeup", "face", "skin")):
        return True
    return bool(raw & _FILM) and not any(x in picked for x in ("framing", "camera", "style", "film"))
SELF_PARTS = {"hair color", "hairstyle", "expression", "outfit", "makeup", "eye color", "pose", "camera angle", "framing"}

# the words a known part is made of: a phrase with them always varies; for known parts, a phrase without them never does
_COLORS = set("""blonde blond platinum brunette brown black red auburn ginger copper golden silver gray grey white
chestnut honey ash strawberry raven jet dark light pink blue green purple violet""".split())
# words a place and her clothes can share ("trees in warm brown tones" vs "fur trim in shades of brown"): no link
_SHARED = _COLORS | set("""tones tone shades shade warm cool soft muted rich deep pale bright natural textured shapes""".split())
LEX = {
    "time of day": GROUPS["time"][1],
    "weather": GROUPS["weather"][1],
    "season": GROUPS["season"][1],
    "hairstyle": GROUPS["hairstyle"][1] | {"hair"},
    "hair color": {"hair"},
    "outfit": set("""wearing wears dressed dress gown uniform cloak cape coat jacket parka hoodie sweater shirt blouse top
tunic robe trousers pants jeans shorts skirt leggings boots shoes sneakers sandals heels hat cap scarf gloves vest suit
armor apron overalls""".split()),
    "expression": set("""expression smile smiling smiles grin frown frowning laughing laugh serious composed calm angry sad
pensive gaze""".split()),
    "lighting": set("""lit light lighting glow glowing shadow shadows sunlight lamp candle neon backlit rim""".split())
    | GROUPS["time"][1],
    "pose": set("""standing stands sitting sits seated leaning leans kneeling kneels lying crouching squatting perched
walking walks running pose posing arms arm hands hand leg legs shoulder shoulders forearm forearms elbow elbows knee knees
hip hips foot feet looking looks gazing glancing turning turned checks checking holding holds reaching reaches resting
rests""".split()),
    "camera angle": set("""view shot angle closeup overhead aerial still framing""".split()),
    "framing": set("""view shot closeup medium portrait framing frame cropped still""".split()),
}


# a camera angle idea is picked from real camera positions (left free, the model kept turning it into a place)
CAMERA_IDEAS = ["low angle from below", "high angle from above", "bird's-eye view straight down", "worm's-eye view",
                "eye level, straight on", "over the shoulder", "side profile", "from behind", "Dutch tilted angle",
                "extreme wide shot", "close-up", "extreme close-up", "three-quarter view", "medium shot from the waist up",
                "full body shot", "aerial drone shot"]


_HAIR_NOUNS = set("blonde blond brunette redhead redheaded".split())  # "a blonde woman" names a hair color, no "hair"


def _lex_hit(part: str, text: str) -> bool:
    words = set(re.findall(r"[a-z]+", text.lower()))
    if part == "hair color":
        return ("hair" in words and bool(words & _COLORS)) or bool(words & _HAIR_NOUNS)
    if part in ("camera angle", "framing") and re.match(r"\s*(?:the\s+)?camera\b", text, re.I):
        return True  # "Camera at chest height" is the camera, whatever words follow
    return bool(words & LEX.get(part, set()))


def _protected(parts: list[str]) -> set[str]:
    picked = " | ".join(p.lower() for p in parts)
    out = set()
    for names, words in GROUPS.values():
        if not any(n in picked for n in names):
            out |= words
    return out


def _words(text: str) -> set[str]:
    return {w for w in re.findall(r"[a-z]+", text.lower()) if len(w) >= 3 and w not in _STOP}


# a long phrase is cut again before these words when an article follows ("a blonde woman | in a parka | with a big
# fur-lined hood | next to a window"), so a short prompt with no commas still splits into person / outfit / place
_CUT = re.compile(r"\s+(?=(?:in|with|wearing|next to|beside|near|on|at|under|by|holding|inside|outside|against|among)\s+"
                  r"(?:a|an|the|her|his|their|some|old|big|small)\b)", re.I)


def _phrases(base: str) -> list[tuple[int, int, str]]:
    """The base cut into short phrases at sentence ends, commas and semicolons (and long ones again at "in a", "with
    a", "next to a" ...): (start, end, text)."""
    out = []
    for m in re.finditer(r"[^.,;:!?]+", base):
        t = m.group(0)
        lead = len(t) - len(t.lstrip())
        t2 = t.strip()
        if len(t2) < 2:
            continue
        start = m.start() + lead
        cuts = [0] + [c.end() for c in _CUT.finditer(t2)] if len(t2.split()) > 6 else [0]
        cuts = sorted(set(cuts)) + [len(t2)]
        for a, b in zip(cuts, cuts[1:]):
            piece = t2[a:b]
            pl = len(piece) - len(piece.lstrip())
            piece = piece.strip()
            if len(piece) >= 2:
                out.append((start + a + pl, start + a + pl + len(piece), piece))
    return out


_LEAD = {"a", "an", "the", "she", "he", "they", "her", "his", "their", "two", "three", "four", "some"}


def _slot_at(base: str, parts) -> int:
    """Where a part the prompt never states goes, in the shared order: camera at the very start; pose, expression or
    mood late (the end of the last sentence, or the one before it when the last is a short closing line like
    "Photorealistic photograph, sharp focus."); anything else at the end of the first sentence."""
    slots = {PART_SLOT.get(p.strip().lower()) for p in parts}
    if "camera" in slots:
        return 0
    text = base.rstrip()
    ends = [m.start() for m in re.finditer(r"[.!?](?=\s|$)", text)]
    if not ends or ends[-1] < len(text) - 1:
        ends.append(len(text))  # the last sentence has no full stop
    if slots & {"pose", "expression", "mood"}:
        if len(ends) > 1 and len(text[ends[-2] + 1:ends[-1]].split()) <= 6:
            return ends[-2]
        return ends[-1]
    return ends[0]


def _fill(base: str, spans, texts) -> str:
    if spans and spans[0][0] == 0 and spans[0][1] == 0 and not spans[0][2]:
        # a camera slot goes in front: "A woman ..." reads on as "Low angle from below, a woman ..."
        first = re.match(r"\s*(\w+)", base)
        if first and first.group(1).lower() in _LEAD:
            i = first.start(1)
            base = base[:i] + base[i].lower() + base[i + 1:]
    out, at = [], 0
    starts = [sp[0] for sp in spans] + [len(base)]
    for n, (sp, t) in enumerate(zip(spans, texts)):
        s, e, orig = sp[0], sp[1], sp[2]
        t = re.sub(r"^\s*\d+[.)]\s+", "", str(t)).strip().strip(",;") or orig  # the 9B numbers its texts ("1. next to")
        # the model sometimes runs on into the words that come next ("wide view with the whole fortress ..." twice,
        # which draws the person twice): drop that repeat
        nxt = base[e:starts[n + 1]].strip(" ,;.")
        # ... or into just the rest of its own clause ("kneeling on wet stone next to a window" + "next to a window")
        clause = re.split(r"[.,;:!?]", base[e:starts[n + 1]].lstrip(" ,;"))[0].strip()
        for rep in (nxt, clause):
            if len(rep) > 8 and rep.lower() in t.lower() and rep.lower() not in orig.lower():
                i = t.lower().rfind(rep.lower())
                t = (t[:i] + t[i + len(rep):]).strip(" ,;")
                t = re.sub(r"\s{2,}", " ", t) or orig
        # ... or repeats the word just before it ("standing" + "standing in a flooded tunnel")
        prev = re.search(r"([A-Za-z'-]+)\s*$", base[:s])
        if prev and orig and t.lower().startswith(prev.group(1).lower() + " ") \
                and not orig.lower().startswith(prev.group(1).lower() + " "):
            t = t[len(prev.group(1)) + 1:].lstrip()
        if t and orig and (s == 0 or re.search(r"[.!?]\s*$", base[:s])):
            t = t[:1].upper() + t[1:]  # it starts a sentence
        out.append(base[at:s])
        if not orig and t and s == 0:
            out.append(t[:1].upper() + t[1:] + ", ")  # an added camera slot leads the prompt
        else:
            out.append((", " + t) if (not orig and t) else t)  # an added slot goes in after a comma
        at = e
    out.append(base[at:])
    return re.sub(r"\s{2,}", " ", "".join(out)).strip()


class LCVisionPromptBatch:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "vision_model": (MODEL_TYPE, {"tooltip": "From LC Vision Loader. Runs once per queue, then unloads before sampling."}),
                "base_prompt": ("STRING", {"multiline": True, "default": "",
                                           "tooltip": "The prompt to vary. 💡 Starting from a picture: caption it first "
                                                      "(LC Vision Caption, LC Vision Filter for only the parts you want), "
                                                      "edit it, paste it here."}),
                "vary": ("STRING", {"default": "Location",
                                    "tooltip": "What changes, comma separated. Pick from the list button or type your own "
                                               "(Location, Time of day, Hair color, Outfit ...). Everything else stays word for word."}),
                "count": ("INT", {"default": 10, "min": 1, "max": 50,
                                  "tooltip": "Prompts per queue: one picture each. A new seed writes a new batch."}),
                "variation": ("INT", {"default": 60, "min": 10, "max": 400, "step": 5,
                                      "tooltip": "Token budget each variant may spend on the parts that change. "
                                                 "Low = a quick swap, high = a rich new description."}),
                "enhance_base": ("BOOLEAN", {"default": False,
                                             "tooltip": "Enhance the base once. The result is kept on the node through every seed "
                                                        "until you clear it or change the base prompt."}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 2**32 - 1, "control_after_generate": True,
                                 "tooltip": "New seed = new batch of variants."}),
            },
            "optional": {
                "kept_base": ("STRING", {"multiline": True, "default": "",
                                         "tooltip": "The enhanced base, kept until cleared. You can edit it."}),
                "kept_for": ("STRING", {"default": ""}),
                "style_tag": (STYLE_TAG_OPTIONS, {"default": "None",
                                                  "tooltip": "Rewrites the base once in this style (Anime, Cinematic, B&W ...), "
                                                             "kept like an enhanced base. Every variant carries it."}),
                "max_tokens": ("INT", {"default": 300, "min": 32, "max": 2048, "step": 8,
                                       "tooltip": "Length of the enhanced or styled base, so of every prompt in the batch. "
                                                  "Lower = shorter prompts, higher = richer ones. Used when enhance_base "
                                                  "is on or a style_tag is picked."}),
            },
        }

    RETURN_TYPES = ("STRING", "STRING", "STRING", "INT", "STRING")
    RETURN_NAMES = ("prompt", "base", "prompt_list", "count", "removed")
    OUTPUT_IS_LIST = (True, False, False, False, False)
    OUTPUT_TOOLTIPS = ("One prompt per picture (a list: every prompt runs as its own generation).",
                       "The base prompt in use (enhanced / styled when that is on).",
                       "The whole batch as one text, one prompt per line: for reading, saving or a text box "
                       "(the prompt output is a list and shows up as separate pieces).", "How many prompts go out.",
                       "What gets taken out of the base: [vary] = the picked parts, {follow} = details that adapt to them. "
                       "Plug it into a preview to check the split.")
    FUNCTION = "run"
    CATEGORY = "LC Vision"
    DESCRIPTION = ("An intelligent wildcard processor: one base prompt, pick what changes (Location, Time of day, Hair "
                   "color ...), get N variants per queue. Everything you didn't pick stays word for word. A new seed "
                   "writes a new batch.")

    def run(self, *args, **kwargs):
        try:
            return self._run(*args, **kwargs)
        finally:
            release(kwargs.get("vision_model", args[0] if args else None))

    def _base(self, vm, base_prompt, enhance_base, kept_base, kept_for, seed, style_tag, max_tokens):
        """(base in use, kept text, kept key). The kept text is reused while the key matches."""
        raw = (base_prompt or "").strip()
        style = style_tag if style_tag and style_tag != "None" else ""
        if not raw or not (enhance_base or style):
            return raw, kept_base or "", kept_for or ""
        key = _h("enhance", raw, style, str(int(max_tokens)))
        if (kept_base or "").strip() and kept_for == key:
            return kept_base.strip(), kept_base, key
        user = ("/no_think\n" if getattr(vm, "is_qwen3_family", False) else "") + apply_style_tag_to_text(raw, style or "None")
        r = generate_with_recovery(vm, messages=[{"role": "system", "content": ENHANCE_RULES + budget_line(max_tokens)},
                                                 {"role": "user", "content": user}],
                                   max_tokens=int(max_tokens), temperature=0.6, top_p=0.95, repeat_penalty=1.05, seed=seed)
        text = strip_thinking((r["choices"][0].get("message", {}).get("content") or "").strip())
        text = re.sub(r"\s+", " ", trim_to_sentence(text, r)).strip() or raw
        print(f"[LC Vision] Prompt Batch: {'styled (' + style + ') and ' if style else ''}enhanced the base (kept until cleared).")
        return text, text, key

    def _split(self, vm, base, parts, seed):
        key = _h(base, ",".join(p.lower() for p in parts), "v7")
        if key in _SPLITS:
            return _SPLITS[key]
        ph = _phrases(base)
        k = len(ph)
        schema = {"type": "object", "properties": {
            "labels": {"type": "array", "minItems": k, "maxItems": k, "items": {"type": "string", "enum": ["keep", "vary", "follow"]}},
            "old_words": {"type": "array", "items": {"type": "string"}}}, "required": ["labels", "old_words"]}
        listing = "\n".join(f"{i + 1}. {t}" for i, (_, _, t) in enumerate(ph))
        user = f"Picked parts: {', '.join(parts)}\n\nThe whole prompt:\n{base}\n\nPhrases:\n{listing}"
        data = _json(_ask(vm, SPLIT_RULES, user, 160 + 8 * k, 0.1, seed, schema))
        labels = data.get("labels") or []
        old_words = set()
        for w in data.get("old_words") or []:
            old_words |= _words(str(w))
        labels = list(labels) + ["keep"] * (k - len(labels))
        known = [p.lower() for p in parts if p.lower() in LEX]
        all_known = len(known) == len(parts)
        for i, (_, _, t) in enumerate(ph):
            hit = any(_lex_hit(p, t) for p in known)
            if hit:
                labels[i] = "vary"  # "lit by overcast dusk" is the time of day, whatever the model said
            elif labels[i] == "vary" and all_known:
                labels[i] = "keep"  # her job is not her outfit
        place = any(p.lower() in ("location", "place", "setting", "background") for p in parts)
        if place:  # "The setting appears to be ...", "the background is ...": the place itself, whatever the model said
            for i, (_, _, t) in enumerate(ph):
                if set(re.findall(r"[a-z]+", t.lower())) & PLACE_HEAD and not _unpicked_self(parts, t):
                    labels[i] = "vary"
        # a kept phrase that names something from a vary phrase ("crisp fortress masonry", "looking out to sea") would
        # contradict the new version: it follows
        vwords = set()
        for (_, _, t), lab in zip(ph, labels):
            if lab == "vary":
                vwords |= _words(t)
        self_only = all(p.lower() in SELF_PARTS for p in parts)
        place_old = set()
        for i, ((_, _, t), lab) in enumerate(zip(ph, labels)):
            if self_only:
                if lab == "follow":
                    labels[i] = "keep"  # a hair color, an outfit or a pose never moves the place or her job
            elif lab == "keep" and _words(t) & vwords - _SHARED:
                labels[i] = "follow"
            elif lab == "keep" and place and _words(t) & PLACE_WORDS:
                labels[i] = "follow"  # the railing, the string lights, the skyline belong to the old place
            # her hair, her clothes and the film look never move with a place unless they were picked
            if labels[i] != "keep" and _unpicked_self(parts, t):
                labels[i] = "keep"
        # the rest of a sentence about her ("..olive green parka, which features a thick, | textured fur trim..",
        # "her lips painted a muted, | natural pinkish-brown tone") stays with it, unless it names the place or the light
        is_self = [lab == "keep" and _unpicked_self(parts, t) for (_, _, t), lab in zip(ph, labels)]
        for i in range(1, len(ph)):
            t = ph[i][2]
            raw = set(re.findall(r"[a-z]+", t.lower()))
            same_sentence = not re.search(r"[.!?]", base[ph[i - 1][1]:ph[i][0]])
            if (labels[i] == "follow" and is_self[i - 1] and same_sentence
                    and not raw & (PLACE_WORDS | LEX["lighting"]) and not _words(t) & (vwords - _SHARED)):
                labels[i], is_self[i] = "keep", True
        for (_, _, t), lab in zip(ph, labels):
            if place and lab == "follow":
                place_old |= _words(t) & PLACE_WORDS
        if place and "vary" not in labels:  # the model called the place "follow" ("next to a window"): it is the place
            for i, (_, _, t) in enumerate(ph):
                if labels[i] == "follow" and _words(t) & PLACE_WORDS:
                    labels[i] = "vary"
        spans = [(s, e, t, lab.upper()) for (s, e, t), lab in zip(ph, labels) if lab in ("vary", "follow")]
        # neighboring VARY pieces of one sentence are one thing ("Camera at chest height, waist-up framing", "sitting
        # | on a tall stool with both forearms | on her knees"): rewritten apart, the idea came out twice or bits stayed
        merged = []
        for sp in spans:
            if (merged and sp[3] == "VARY" and merged[-1][3] == "VARY"
                    and re.fullmatch(r"[\s,]*", base[merged[-1][1]:sp[0]])):
                s0 = merged[-1][0]
                merged[-1] = (s0, sp[1], base[s0:sp[1]], "VARY")
            else:
                merged.append(sp)
        spans = merged
        # a picked part the prompt never states (no pose, no camera angle) gets its own slot where the shared order
        # puts it: a camera first (camera words at the end turn into a camera she holds), a pose, an expression or a
        # mood late, anything else at the end of the first sentence. Parts that land on the same spot share one slot
        if not any(sp[3] == "VARY" for sp in spans):
            missing = list(parts)
        else:
            missing = [p for p in parts if p.lower() in LEX and not any(_lex_hit(p.lower(), t) for _, _, t in ph)]
        added: dict[int, list[str]] = {}
        for p in missing:
            added.setdefault(_slot_at(base, [p]), []).append(p)
        spans = sorted(spans + [(at, at, "", "VARY") for at in added])
        # the model's old words only count where they sit in a phrase that changes (it sometimes lists unrelated ones)
        changing = set().union(*[_words(t) for _, _, t, _ in spans] or [set()])
        # the clash check never gets her (person, face, hair, clothes) or the style words: those always fit a new place
        # ("a blonde woman in a parka" became "a desert woman in a turban")
        keeps = [(s, e, t) for (s, e, t), lab in zip(ph, labels) if lab == "keep" and not _unpicked_self(parts, t)
                 and not set(re.findall(r"[a-z]+", t.lower())) & (_PERSON | GROUPS["style"][1])]
        split = {"spans": spans, "old": sorted((old_words & changing) | vwords | place_old), "keeps": keeps,
                 "self_only": self_only, "added": added}
        if any(sp[3] == "VARY" for sp in spans):
            _SPLITS[key] = split
        return split

    def _variants(self, vm, base, spans, parts, n, variation, seed, old=None, added=None):
        k = len(spans)
        idea = {"type": "string"}
        if [p.lower() for p in parts] in (["camera angle"], ["framing"]):
            idea = {"type": "string", "enum": CAMERA_IDEAS}
        schema = {"type": "object", "properties": {"variants": {"type": "array", "minItems": n, "maxItems": n, "items": {
            "type": "object", "properties": {"idea": idea, "texts": {
                "type": "array", "minItems": k, "maxItems": k, "items": {"type": "string"}}},
            "required": ["idea", "texts"]}}}, "required": ["variants"]}
        prot = _protected(parts)

        def note(t, kind):
            keep = sorted(_words(t) & prot)
            if not keep:
                return ""
            if kind == "VARY":
                # "in an autumn forest": a plain "must stay" kept the whole forest. The season (time, weather) goes
                # with the NEW place
                return (f"   (write a new {', '.join(parts)}; keep {', '.join(keep)} as a word of the new one, e.g. "
                        f"\"{keep[0]} mountain ridge\")")
            return f"   (these words must stay: {', '.join(keep)})"

        listing = "\n".join(
            f"{i + 1}. [{kind}] {t}{note(t, kind)}" if t else f"{i + 1}. [VARY] (not in the prompt yet: write a short "
                                                              f"phrase that states the "
                                                              f"{', '.join((added or {}).get(s, parts))} only)"
            for i, (s, _, t, kind) in enumerate(spans))
        old = sorted(old or set().union(*[_words(t) for _, _, t, kind in spans if kind == "VARY"]) or {"none"})
        rules = VARIANT_RULES.format(n=n, parts=", ".join(parts), words=max(4, int(variation * 0.7)), old=", ".join(old))
        user = f"The whole prompt, for context:\n{base}\n\nPhrases to change:\n{listing}"
        tokens = min(16000, n * (variation + 10 * k + 20) + 200)
        data = _json(_ask(vm, rules, user, tokens, 0.95, seed, schema))
        rows = []
        for v in data.get("variants") or []:
            t = v.get("texts") if isinstance(v, dict) else None
            if isinstance(t, list) and len(t) == k:
                # "orchard at golden hour" with no time of day picked: the time comes off the idea, or every fix
                # below pulls the night prompt toward it
                idea = str(v.get("idea", "")).strip()
                if prot:
                    idea = re.sub(r"\b(?:at|in|during|under)?\s*(?:the\s+)?(?<![\w-])(?:"
                                  + "|".join(sorted(prot, key=len, reverse=True)) + r")(?![\w-])(?:\s+hour)?", "", idea,
                                  flags=re.I)
                    idea = re.sub(r"\s+(?:at|in|during|under)(?:\s+(?:high|early|late|the|a))?\s*$", "", idea, flags=re.I)
                    idea = re.sub(r"\s{2,}", " ", idea).strip(" ,-") or str(v.get("idea", "")).strip()
                rows.append({"idea": idea, "texts": [str(x) for x in t]})
        self._fix_leftovers(vm, spans, rows, set(old) - {"none"}, _protected(parts), seed)
        return rows

    def _fix_leftovers(self, vm, spans, rows, old, protected, seed):
        """Two checks per variant, then one small fix call for what fails (a big mixed list came back out of order):
        a FOLLOW phrase that still names the old version ("crisp fortress masonry" in a desert) swaps those words, and
        a phrase that lost words of a part nobody picked (the time of day, the weather, the hairstyle) gets them back.
        A FOLLOW phrase that only lost protected words just goes back to the original."""
        fixed_n = restored = 0
        old = set(old) - protected  # "dusk" is never an old place word: a time nobody picked stays
        for vi, r in enumerate(rows):
            new_words = set().union(*[_words(t) for t, sp in zip(r["texts"], spans) if sp[3] == "VARY"] or [set()])
            todo = []
            for j, (t, sp) in enumerate(zip(r["texts"], spans)):
                orig = sp[2]
                keep = sorted((_words(orig) & protected) - _words(t))
                left = sorted((_words(t) & old) - new_words) if sp[3] == "FOLLOW" else []
                # a time / weather / season word nobody picked, sneaked into the new text ("a high-angle dawn shot")
                sneak = sorted((_words(t) & protected) - _words(orig))
                same = sp[3] == "VARY" and orig and t.strip().lower() == orig.strip().lower()
                # "standing on a rooftop" -> "standing arctic ice canyon": the linking word went missing
                lost = bool(orig) and bool(_LINKS & set(orig.lower().split()[:3])) and not (_LINKS & set(t.lower().split()))
                if (keep or sneak) and not left and sp[3] == "FOLLOW" and orig and not (_words(orig) & old):
                    r["texts"][j] = orig
                    restored += 1
                elif keep or left or sneak or same or lost:
                    todo.append((j, t, orig, left, keep, sneak, same, lost))
            if not todo:
                continue
            m = len(todo)
            schema = {"type": "object", "properties": {"fixed": {"type": "array", "minItems": m, "maxItems": m,
                                                                  "items": {"type": "string"}}}, "required": ["fixed"]}
            lines = []
            for i, (_, t, orig, left, keep, sneak, same, lost) in enumerate(todo):
                how = []
                if lost:
                    how.append(f"it lost its linking word (in, on, at ...): put one back so it reads like \"{orig}\"")
                if same:
                    how.append("it was left as it was: rewrite it to state the new version")
                if left:
                    how.append(f"swap {', '.join(left)} for words that fit the new version")
                if keep:
                    how.append(f"put back these words from the original \"{orig}\": {', '.join(keep)}")
                if sneak:
                    how.append(f"take out {', '.join(sneak)}")
                lines.append(f"{i + 1}. {t}   ({'; '.join(how)})")
            rules = (f"The picture is now: {r['idea']}. Fix each phrase as its note says, keep every other word, the "
                     "grammar and about the same length. One answer per line, in order. Answer with the JSON only.")
            fixed = _json(_ask(vm, rules, "\n".join(lines), 34 * m + 60, 0.4, seed + 7 + vi, schema)).get("fixed") or []
            fixed = list(fixed) + [""] * (m - len(fixed))  # a short answer: the rest still gets checked below
            for (j, t, orig, left, keep, sneak, same, lost), f in zip(todo, fixed):
                f = str(f).strip().strip(",;")
                # an answer can come back in the wrong slot: it may never add a time / weather / style word either
                ok = (f and len(f) <= 2 * max(len(orig), len(t)) + 20 and not (_words(f) & set(left + sneak))
                      and set(keep) <= _words(f) and not (same and f.lower() == orig.lower())
                      and not ((_words(f) & protected) - _words(orig)))
                if ok:
                    r["texts"][j] = f
                    fixed_n += 1
                elif (keep or sneak) and orig and spans[j][3] != "VARY":
                    # the fix missed: the original is safer than a changed time of day. Never on the picked part
                    # itself: "in an autumn forest" put back undid the whole new location (the season word inside it
                    # could not be kept), and every variant came out unchanged
                    r["texts"][j] = orig
                    restored += 1
                elif left and not keep and not sneak:
                    # the fix missed and only old place words are left ("intimate nighttime urban portrait" in a
                    # forest): drop those words here, the rest of the phrase stays as it was
                    cut = re.sub(rf"\b(?:{'|'.join(map(re.escape, left))})\b\s*", "", t, flags=re.I)
                    cut = re.sub(r"\s{2,}", " ", cut).strip(" ,;")
                    if len(cut.split()) >= 2:
                        r["texts"][j] = cut
                        fixed_n += 1
        if fixed_n or restored:
            print(f"[LC Vision] Prompt Batch: fixed {fixed_n} phrases (old words or lost details), put {restored} back as written.")

    def _contradictions(self, vm, base, keeps, rows, seed):
        """Kept phrases that clash with a variant's new idea (a skyline in the desert, nighttime at noon) are rewritten
        for that variant only. Returns, per variant, a list of (start, end, original, new text)."""
        out = [[] for _ in rows]
        if not keeps or not rows:
            return out
        n = len(rows)
        schema = {"type": "object", "properties": {"pictures": {"type": "array", "minItems": n, "maxItems": n, "items": {
            "type": "array", "items": {"type": "integer", "minimum": 1, "maximum": len(keeps)}}}}, "required": ["pictures"]}
        listing = "\n".join(f"{i + 1}. {t}" for i, (_, _, t) in enumerate(keeps))
        ideas = "\n".join(f"{i + 1}. {r['idea']}" for i, r in enumerate(rows))
        user = f"The original prompt:\n{base}\n\nKept phrases:\n{listing}\n\nNew pictures:\n{ideas}"
        bad = _json(_ask(vm, CHECK_RULES, user, 40 + 12 * n, 0.1, seed + 11, schema)).get("pictures") or []
        fixes = 0
        for vi, (r, nums) in enumerate(zip(rows, bad)):
            picks = sorted({int(x) - 1 for x in (nums or []) if str(x).isdigit() and 0 < int(x) <= len(keeps)})
            if not picks:
                continue
            m = len(picks)
            schema2 = {"type": "object", "properties": {"fixed": {"type": "array", "minItems": m, "maxItems": m,
                                                                   "items": {"type": "string"}}}, "required": ["fixed"]}
            lines = "\n".join(f"{i + 1}. {keeps[k][2]}" for i, k in enumerate(picks))
            rules = (f"The picture is now: {r['idea']}. Each phrase below no longer fits it. Rewrite each one so it fits, "
                     "changing as few words as you can: keep the grammar, the person, the style words and about the same "
                     "length. One answer per line, in order. Answer with the JSON only.")
            got = _json(_ask(vm, rules, lines, 34 * m + 60, 0.4, seed + 13 + vi, schema2)).get("fixed") or []
            for k, f in zip(picks, got):
                f = str(f).strip().strip(",;")
                s0, e0, t0 = keeps[k]
                style = GROUPS["style"][1]
                if (f and f.lower() != t0.lower() and len(f) <= 2 * len(t0) + 20
                        and _words(t0) & style <= _words(f) and not (_words(f) & style) - _words(t0)):
                    out[vi].append((s0, e0, t0, f))
                    fixes += 1
        if fixes:
            print(f"[LC Vision] Prompt Batch: rewrote {fixes} kept phrases that clashed with their new picture.")
        return out

    def _run(self, vision_model, base_prompt, vary, count, variation, enhance_base, seed, kept_base="", kept_for="",
             style_tag="None", max_tokens=300, image=None):
        if vision_model is None or (getattr(vision_model, "llm", None) is None
                                    and getattr(vision_model, "build_params", None) is None):
            raise ValueError("[LC Vision] Prompt Batch received no model: connect an LC Vision Loader.")
        base, kept, key = self._base(vision_model, base_prompt, enhance_base, kept_base, kept_for, seed, style_tag,
                                     max_tokens)
        if not base:
            raise ValueError("[LC Vision] Prompt Batch: write a base prompt (to start from a picture, caption it first).")
        parts = _parts(vary)
        n = int(count)
        prompts, marked, ideas, removed = [], base, [], ""
        if parts:
            split = self._split(vision_model, base, parts, seed)
            spans, old = split["spans"], set(split.get("old") or [])
            added = split.get("added") or {}
            if any(sp[3] == "VARY" for sp in spans):
                marked = _fill(base, spans, [f"[{t}]" if kind == "VARY" else f"{{{t}}}" for _, _, t, kind in spans])
                removed = ("Base, with what changes marked ([vary] {follow}):\n" + marked + "\n\nRemoved:\n"
                           + "\n".join(f"- {kind.lower()}: {t or '(added: ' + ', '.join(added.get(a, parts)) + ')'}"
                                       for a, _, t, kind in spans))
                rows = self._variants(vision_model, base, spans, parts, n, int(variation), seed, old, added)
                if len(rows) < n:  # cut short (token cap): one more call for the rest
                    rows += self._variants(vision_model, base, spans, parts, n - len(rows), int(variation), seed + 1,
                                           old, added)
                rows = rows[:n]
                extra = ([[] for _ in rows] if split.get("self_only")
                         else self._contradictions(vision_model, base, split.get("keeps") or [], rows, seed))
                for r, ex in zip(rows, extra):
                    sp = sorted([(a, b, t, kind) for a, b, t, kind in spans] + [(a, b, t, "FIX") for a, b, t, _ in ex])
                    texts = []
                    for a, b, t, kind in sp:
                        if kind == "FIX":
                            texts.append(next(f for a2, b2, _, f in ex if a2 == a and b2 == b))
                        else:
                            texts.append(r["texts"][spans.index((a, b, t, kind))])
                    prompts.append(_fill(base, sp, texts))
                    ideas.append(r["idea"])
                vary_i = [i for i, sp in enumerate(spans) if sp[3] == "VARY"]
                same = sum(1 for r in rows if all(str(r["texts"][i]).strip().lower() == spans[i][2].lower() for i in vary_i))
                print(f"[LC Vision] Prompt Batch: {len(spans)} phrases change ({len(vary_i)} vary, {len(spans) - len(vary_i)} follow), "
                      f"{len(prompts)} variants" + (f", {same} left the picked parts as they were" if same else "") + ".")
                print("[LC Vision] Prompt Batch ideas: " + " | ".join(ideas))
            else:
                print(f"[LC Vision] Prompt Batch: found nothing in the base for '{', '.join(parts)}': the base goes out as is.")
                removed = f"Nothing removed: found nothing in the base for '{', '.join(parts)}'."
        if not prompts:
            prompts = [base] * n
        while len(prompts) < n:  # the model came up short twice: fill with the base so the count holds
            prompts.append(base)
        return {"ui": {"lc_batch": [{"kept_base": kept, "kept_for": key, "marked": marked, "count": len(prompts),
                                     "ideas": ideas}]},
                "result": (prompts, base, "\n".join(prompts), len(prompts), removed)}


NODE_CLASS_MAPPINGS = {NODE_ID: LCVisionPromptBatch}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_ID: NODE_DISPLAY_NAME}
