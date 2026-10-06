"""
LC Vision Danbooru Caption
--------------------------
Prompts for SDXL-family models (SDXL, Pony, Illustrious). One image in (Image analysis) or a rough prompt in
(Prompt enhance), out comes a short caption, a detailed caption, Danbooru tags, or a mix of tags and a sentence,
each capped to fit SDXL's 75-token chunks. Optional quality / score tags for Illustrious or Pony, and a matching
negative prompt.

A separate node on purpose: the other LC Vision nodes are built for long natural-language prompts (video, DiT
models) and live in saved workflows, so they stay as they are. Same model plumbing as LC Vision Caption
(generate_with_recovery, Qwen3 /no_think, style_tag).
"""

from __future__ import annotations

import csv
import re
from pathlib import Path

from .lc_vision_caption import _image_input_to_base64_list
from .lc_vision_generate import generate_with_recovery, release
from .lc_vision_loader import LCVisionModel, MODEL_TYPE
from .lc_vision_styles import STYLE_TAG_OPTIONS, apply_style_tag_to_content

NODE_ID = "LCVisionDanbooruCaption"
NODE_DISPLAY_NAME = "LC Vision Danbooru Caption 🏷️"

MODES = ["Image analysis", "Prompt enhance"]
OUTPUTS = ["short caption", "detailed caption", "Danbooru tags", "prompt gen mixed"]
QUALITY = ["none", "Illustrious", "NoobAI", "Pony"]
IMAGE_SIDE, JPEG_QUALITY, TOP_P, REPEAT = 768, 90, 0.9, 1.1

# quality lists after Massahud's tag guide (gist.github.com/massahud/8bc9fec2ffe6e4cbd0d232ee114b7bde), as converted by Lonecat
QUALITY_TAGS = {
    "Illustrious": "masterpiece, best quality, amazing quality, very aesthetic, absurdres, newest",
    "NoobAI": "very awa, masterpiece, best quality, newest, absurdres",
    "Pony": "score_9, score_8_up, score_7_up",
}
# always in the negative: anatomy, artifact and censorship tags (no greyscale: it would fight the B&W / Noir styles)
NEGATIVE_BASE = ("bad anatomy, deformed, disfigured, malformed hands, extra limbs, fused fingers, blurry, jpeg artifacts, "
                 "watermark, text, signature, censored, mosaic censoring, bar censor, blur censor, heart censor, "
                 "convenient censoring")
NEGATIVE_QUALITY = {  # only when quality_tags is on
    "Illustrious": "worst quality, low quality, ugly, ",
    "NoobAI": "worst quality, low quality, ugly, ",
    "Pony": "score_4, score_5, score_6, ",
}

TAG_RULES = (
    "Write Danbooru tags: lowercase, comma-separated, spaces instead of underscores, no sentences, no numbering, no "
    "weights. Use only real, common Danbooru tags. Order: subject count (1girl, 1boy, 2girls, solo, no humans), "
    "character and series only if certain, then hair and eyes, body, clothing and accessories, pose and action, "
    "expression, held objects, setting and background, framing and camera (close-up, upper body, full body, from "
    "above, from side), lighting. Write at least {tags_lo} and up to {tags_hi} tags: keep going through every visible "
    "detail (accessories, materials, background objects, lighting) before you stop. Never invent a tag to fit a detail; "
    "skip it instead. "
    "The count tag must match the subject: 1boy for a man or boy, 1girl for a woman or girl, no humans when nobody is in "
    "it. Tags are short nouns or poses, not descriptions. Hair and eye colors only when you can see them or the user "
    "gave them. Example of the form (for a woman in a cafe): 1girl, solo, smile, hoodie, hood up, jeans, sitting, chair, "
    "holding cup, indoors, cafe, window, upper body, looking at viewer, sunlight. (for an empty landscape): no humans, scenery, mountain, lake, mist, "
    "dawn, water, reflection, tree, outdoors, sky, cloud. Only add 1girl or 1boy when a person is really there. An animal "
    "subject, even one dressed and posed like a person, is no humans, animal focus plus the animal (monkey, cat, dog). "
    "Only a hand or part of a person in frame: solo, hand focus (or the body part), out of frame. "
    "Name every action (smoking, eating, drinking, holding x) and every pattern or material (plaid, striped, glitter, "
    "leather). Only tag what is clearly visible: no camera or lens effects you are guessing at."
)
FORMATS = {
    "short caption": "Write one or two plain sentences, under {words} words: the subject, what they are doing, the setting.",
    "detailed caption": (
        "Write one natural-language paragraph, under {words} words: subject, appearance, clothing, pose and expression, "
        "setting, lighting, framing. Concrete visual facts only, no story, no mood words without a visual reason."
    ),
    "Danbooru tags": TAG_RULES,
}
ROLE = {
    "Image analysis": "You write image-generation prompts for SDXL-family models by looking at the image you are given.",
    "Prompt enhance": (
        "You turn a rough image idea into an image-generation prompt for SDXL-family models. Keep every subject, "
        "action and constraint the user gave; add only the visual detail needed to make it render well."
    ),
}
ENDING = " Output only the prompt -- no preamble, no quotes, no labels, no explanation, no <think> or reasoning."


# Real Danbooru tags (general + character + rating), from SmilingWolf's WD tagger selected_tags.csv (Apache-2.0).
TAGS_PATH = Path(__file__).parent / "danbooru_tags.csv"
_TAGS: set[str] | None = None
COUNT_TAGS = {"1girl", "2girls", "3girls", "4girls", "5girls", "6+girls", "1boy", "2boys", "3boys", "4boys", "5boys",
              "6+boys", "multiple girls", "multiple boys", "1other", "solo"}
FRAMING = ["close-up", "portrait", "upper body", "cowboy shot", "full body", "lower body"]
FILLER = (" in background", " in the background", " background", " landscape", " style", " setting", " vibe", " scene",
          " texture", " atmosphere", " lighting")
# style_tag -> real style tags for the tag outputs (added by the node, so meta tags the WD list leaves out still go in)
STYLE_TAGS = {
    "Realistic": "realistic, photorealistic", "Anime": "anime coloring, anime screencap", "Cartoon": "cartoon, flat color",
    "Cinematic": "cinematic lighting, depth of field, film grain", "Hentai": "anime coloring, nsfw", "Fantasy": "fantasy",
    "B&W": "monochrome, greyscale, high contrast, film grain", "Noir": "monochrome, greyscale, high contrast, film noir, dark",
    "Cyberpunk": "cyberpunk, neon lights, science fiction", "Illustration": "sketch, lineart, traditional media",
    "NSFW": "nsfw",
}


def _tags() -> set[str]:
    global _TAGS
    if _TAGS is None:
        try:
            with open(TAGS_PATH, encoding="utf-8") as f:
                _TAGS = {row["name"].replace("_", " ").lower() for row in csv.DictReader(f)} if f else set()
        except Exception as exc:
            print(f"[LC Vision] Danbooru Caption: no tag list ({exc}); tags pass through unchecked.")
            _TAGS = set()
    return _TAGS


# words the model uses that map to a real tag
SYNONYMS = {"smiling": "smile", "rainy": "rain", "raining": "rain", "raindrops": "rain", "soaked": "wet", "wet clothes": "wet clothes",
            "neon signs": "neon lights", "neon sign": "neon lights", "daytime": "day", "nighttime": "night", "sunny": "sunlight",
            "tattoos": "tattoo", "denim jeans": "jeans", "blue jeans": "jeans", "long braid": "braid", "braided hair": "braid",
            "grinning": "grin", "crying": "tears", "laughing": "laughing", "city street": "street", "urban": "city",
            "photo": "realistic", "photograph": "realistic", "realistic photography": "realistic, photorealistic"}
SYNONYMS.update({"laces": "drawstring", "hoodie laces": "drawstring", "pulling laces": "drawstring", "shoelaces": "shoelaces"})
POSES = {"sitting", "standing", "lying", "kneeling", "squatting", "leaning", "walking", "running", "crouching"}
# real tags too vague to keep when they are only a leftover piece of a longer phrase
ANIMALS = {"monkey", "cat", "dog", "fox", "wolf", "bird", "horse", "rabbit", "bear", "lion", "tiger", "animal"}
# real tags that are never what a picture is about
VAGUE = {"expressions", "expression", "space", "still life", "photography", "nature", "photo", "image", "picture", "no eyes", "no mouth", "no nose", "watermark", "signature", "people", "square", "figure", "cloth", "perspective", "shape", "object", "item", "ad", "machine", "thing"}
WEAK = {"falling", "clothes", "dark", "light", "day", "texture", "style", "background", "surface", "detail", "pose",
        "standing", "sitting", "holding", "looking", "facing", "wearing", "on", "in", "with"}


def _variants(w: str) -> list[str]:
    out = [w]
    if w.endswith("ies"):
        out.append(w[:-3] + "y")
    if w.endswith("es"):
        out.append(w[:-2])
    if w.endswith("s"):
        out.append(w[:-1])
    if w.endswith("ing"):
        out += [w[:-3], w[:-3] + "e"]
    return out


def _real_tags(t: str, known: set[str]) -> list[str]:
    """Real Danbooru tags for one model tag: itself, a known synonym, a plural / -ing repair, or the real tags inside
    a longer phrase ('sitting on fence' -> sitting, fence). Empty when nothing real is in it."""
    if not known or t in known:
        return [t]
    for f in FILLER:
        if t.endswith(f) and t[: -len(f)].strip():
            t = t[: -len(f)].strip()
    if t in SYNONYMS:
        return [s for s in SYNONYMS[t].split(", ") if s in known] or []
    for v in _variants(t):
        if v in known:
            return [v]
    words, found = t.split(), []
    if words and words[0] in POSES:  # "sitting on fence" -> sitting, fence
        found.append(words[0])
    for i in range(1, len(words)):  # the longest real tag at the end of the phrase is its main noun
        piece = " ".join(words[i:])
        hit = next((v for v in ([SYNONYMS[piece]] if piece in SYNONYMS else []) + _variants(piece) if v in known), None)
        if hit:
            found.append(hit)
            break
    found = [f for f in found if f in known]
    return found if any(f not in WEAK for f in found) else []


MALE = {"1boy", "2boys", "3boys", "4boys", "5boys", "6+boys", "multiple boys"}
FEMALE = {"1girl", "2girls", "3girls", "4girls", "5girls", "6+girls", "multiple girls"}


def _standard_tags(tags: list[str], description: str) -> list[str]:
    """The general tags Danbooru-trained models expect: male focus, holding, english text."""
    have = set(tags)
    add = []
    if have & MALE and not have & FEMALE and "male focus" not in have:
        add.append("male focus")
    if any(t.startswith("holding ") for t in tags) and "holding" not in have:
        add.append("holding")
    if re.search(r"[\"“][^\"”]{2,}[\"”]", description) and "english text" not in have:
        add.append("english text")  # the description quotes words that are in the picture
    i = next((i + 1 for i, t in enumerate(tags) if t in COUNT_TAGS), 0)
    while i < len(tags) and tags[i] in COUNT_TAGS:
        i += 1
    return tags[:i] + add + tags[i:]


def _clean(text: str, output: str) -> tuple[list[str], str]:
    """(real tags, sentence). Captions come back as ([], caption)."""
    text = re.sub(r"<think>.*?</think>", "", text or "", flags=re.S).strip().strip('"').strip()
    text = re.sub(r"^(prompt|tags|caption|sentence)\s*:\s*", "", text, flags=re.I | re.M)
    if output not in ("Danbooru tags", "prompt gen mixed"):
        return [], re.sub(r"\s*[—–]\s*", ", ", re.sub(r"\s+", " ", text)).strip()
    tag_part, sentence = text, ""
    if output == "prompt gen mixed":
        # the sentence part, wherever the model put it: its own line(s), or tacked on after the last tag
        tag_lines, prose = [], []
        for line in text.splitlines():
            pieces = line.split(",")
            # the sentence starts at the first capitalised piece of 4+ words; everything before it is tags
            start = next((i for i, p in enumerate(pieces) if len(p.split()) >= 4 and p.strip()[:1].isupper()), None)
            if start is None and re.search(r"[.!?]\s*$", line.strip()) and \
                    len(line.split()) / max(1, len([p for p in pieces if p.strip()])) > 3:
                start = 0
            if start is None:
                tag_lines.append(line)
            else:
                tag_lines.append(",".join(pieces[:start]))
                prose.append(",".join(pieces[start:]).strip())
        tag_part = "\n".join(tag_lines)
        sentence = " ".join(p for p in prose if p)
    known = _tags()
    seen, tags = set(), []
    for t in re.split(r"[,\n]+", tag_part):
        t = re.sub(r"\s+", " ", t.strip().strip(".").replace("_", " ").replace("\\", "").lower())
        for r in (_real_tags(t, known) if t else []):
            if r not in seen and r not in VAGUE:
                seen.add(r)
                tags.append(r)
    if seen & (ANIMALS - {"animal"}) and ("animal focus" in seen or "no humans" in seen):  # a dressed-up animal
        tags = [t for t in tags if t not in COUNT_TAGS or t == "solo"]
        for t in ("animal focus", "no humans"):
            if t not in tags:
                tags.insert(0, t)
    else:
        tags = [t for t in tags if t != "animal focus" and t != "animal"]  # no animal in it: a model slip
    if not seen & ANIMALS and seen & (COUNT_TAGS - {"solo"} | {"hand focus", "out of frame", "pov hands"}):
        tags = [t for t in tags if t != "no humans"]  # a person and "no humans" can't both be true
    frame = next((t for t in tags if t in FRAMING), None)
    tags = [t for t in tags if t not in FRAMING or t == frame]  # one framing tag
    tags = [re.sub(r"\)", r"\\)", re.sub(r"\(", r"\\(", t)) for t in tags]  # ComfyUI reads bare parentheses as weights
    sentence = re.sub(r"\s*[—–]\s*", ", ", re.sub(r"\s+", " ", sentence)).strip()
    return tags, sentence


class LCVisionDanbooruCaption:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "vision_model": (MODEL_TYPE, {"tooltip": "Handle from LC Vision Loader."}),
                "mode": (MODES, {"default": "Image analysis", "tooltip": "Image analysis: writes the prompt from the image. "
                                 "Prompt enhance: rewrites the idea written in prompt."}),
                "output": (OUTPUTS, {"default": "Danbooru tags", "tooltip": "short caption (80 tokens max), detailed caption "
                                     "(150), Danbooru tags (150), prompt gen mixed: tags plus a sentence (200). Each "
                                     "finetune likes a different one: Pony and Illustrious lean on tags, realism finetunes "
                                     "on captions."}),
                "prompt": ("STRING", {"multiline": True, "default": "", "tooltip": "Prompt enhance: the rough idea to "
                                      "rewrite. Not used in Image analysis."}),
                "style_tag": (STYLE_TAG_OPTIONS, {"default": "None", "tooltip": "Commits the prompt to a visual style. 'None' "
                                                  "leaves it as the image or idea is."}),
                "quality_tags": (QUALITY, {"default": "none", "tooltip": "Adds the quality / score tags up front and their opposites to the "
                                           "negative. They sometimes do more harm than good: off by default."}),
                "max_tokens": ("INT", {"default": 150, "min": 16, "max": 1024, "step": 8,
                                       "tooltip": "How long the prompt can be, for every output. The instructions follow it "
                                                  "(about max_tokens / 4 tags, captions about 0.7 words per token). Rough "
                                                  "guide: short caption 80, detailed caption 150, tags 150, mixed 200."}),
                "temperature": ("FLOAT", {"default": 0.3, "min": 0.0, "max": 2.0, "step": 0.05,
                                          "tooltip": "Low = literal and repeatable. Tags want it low."}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 2**32 - 1}),
            },
            "optional": {
                "image": ("IMAGE", {"tooltip": "The picture to describe (Image analysis). The first frame of a batch is used."}),
            },
        }

    RETURN_TYPES = ("STRING", "STRING")
    RETURN_NAMES = ("positive", "negative")
    OUTPUT_TOOLTIPS = ("The prompt for your SDXL / Pony / Illustrious text encoder.",
                       "A matching negative prompt (with the score / quality tags when quality_tags is on).")
    FUNCTION = "run"
    CATEGORY = "LC Vision"
    DESCRIPTION = (
        "Prompts for SDXL, Pony and Illustrious: a short caption, a detailed caption, Danbooru tags, or tags plus a "
        "sentence, from one image or from a rough prompt. Short enough for SDXL, with optional quality tags and a "
        "matching negative."
    )

    def run(self, vision_model: LCVisionModel, mode: str, output: str, prompt: str = "", style_tag: str = "None",
            quality_tags: str = "none", max_tokens: int = 150, temperature: float = 0.3, seed: int = 0,
            image=None) -> tuple[str, str]:
        if vision_model is None or (getattr(vision_model, "llm", None) is None
                                    and getattr(vision_model, "build_params", None) is None):
            raise ValueError("[LC Vision] Danbooru Caption received no model -- connect an LC Vision Loader.")
        try:
            return self._caption(vision_model, mode, output, prompt, style_tag, quality_tags, max_tokens, temperature, seed,
                                 image)
        finally:
            release(vision_model)  # unloads when the Loader's keep_model_loaded is off

    def _caption(self, vision_model, mode, output, prompt, style_tag, quality_tags, max_tokens, temperature, seed, image):
        hint = (prompt or "").strip()
        content: list[dict] = []
        if mode == "Image analysis":
            frames = _image_input_to_base64_list(image, IMAGE_SIDE, JPEG_QUALITY)
            if not frames:
                raise ValueError("[LC Vision] Danbooru Caption is on Image analysis: plug an image in.")
            content.append({"type": "text", "text": "Write the prompt for this image."})
            content.append({"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{frames[0]}"}})
        else:
            if not hint:
                raise ValueError("[LC Vision] Danbooru Caption is on Prompt enhance: write the idea in prompt.")
            content.append({"type": "text", "text": f"Rough idea:\n{hint}"})
        content = apply_style_tag_to_content(content, style_tag)
        if getattr(vision_model, "is_qwen3_family", False):
            content = [{"type": "text", "text": "/no_think"}] + content  # no visible reasoning (see LC Vision Caption)

        def ask(kind: str, tokens: int, description: str = "") -> tuple[list[str], str]:
            tags_hi = max(6, round(tokens / 4))
            fmt = FORMATS[kind].format(words=max(10, round(tokens * 0.7)), tags_lo=max(3, round(tags_hi * 0.7)),
                                       tags_hi=tags_hi)
            user = content
            if description:  # the tags follow the finished description, so they agree and miss nothing it found
                user = content + [{"type": "text", "text": f"\nA description of this image:\n{description}\nTag everything "
                                   "in that description that is visible, plus anything it missed."}]
            messages = [{"role": "system", "content": ROLE[mode] + " " + fmt + ENDING},
                        {"role": "user", "content": user}]
            response = generate_with_recovery(vision_model, messages=messages, max_tokens=tokens, temperature=temperature,
                                              top_p=TOP_P, repeat_penalty=REPEAT, seed=seed)
            if not response or not response.get("choices"):
                raise RuntimeError("[LC Vision] Model returned an empty response.")
            return _clean(response["choices"][0].get("message", {}).get("content", ""), kind)

        n = max(16, int(max_tokens))
        if output == "prompt gen mixed":
            # two short asks: a small model asked for both in one go writes only the tags
            kind = "detailed caption" if n >= 300 else "short caption"  # a big budget gets the full description
            _, sentence = ask(kind, max(16, round(n * 0.4)))
            tags, _ = ask("Danbooru tags", max(16, round(n * 0.6)), sentence)
        elif output == "Danbooru tags":
            # a quick hidden description first: the tag list comes out fuller and more accurate
            _, desc = ask("detailed caption", 200)
            tags, sentence = ask(output, n, desc)
            sentence = ""
        else:
            tags, sentence = ask(output, n)
        if tags:
            tags = _standard_tags(tags, sentence or "")

        st = STYLE_TAGS.get(style_tag) if output in ("Danbooru tags", "prompt gen mixed") else None
        if st:  # real style tags right after the subject count
            add = [t for t in st.split(", ") if t not in tags]
            i = next((i + 1 for i, t in enumerate(tags) if t in COUNT_TAGS), 0)
            while i < len(tags) and tags[i] in COUNT_TAGS:
                i += 1
            tags = tags[:i] + add + tags[i:]
        # mixed: the sentences first, then the tags (works best on the SDXL finetunes)
        text = "\n\n".join(p for p in (sentence, ", ".join(tags)) if p)
        q = QUALITY_TAGS.get(quality_tags)
        if q:  # quality / score tags lead (Pony needs score_9 first)
            text = f"{q}, {text}"
        negative = NEGATIVE_QUALITY.get(quality_tags, "") + NEGATIVE_BASE
        return (text, negative)


NODE_CLASS_MAPPINGS = {NODE_ID: LCVisionDanbooruCaption}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_ID: NODE_DISPLAY_NAME}


# ---------------------------------------------------------------- the model this node suggests
# SDXL-family users run smaller cards, and this node unloads after each run and needs only a short context (one image,
# a short prompt): so the vision model gets nearly the whole card, at 4k context. 8B beats 4B clearly at tagging
# (tested), so 8B is picked down to Q4_K_M before falling back to 4B. Sizes in GiB (weights + mmproj + 4k KV cache).
SUGGEST_CTX = 4096
SUGGEST_SPARE_GB = 1.8  # desktop / display plus llama.cpp's compute buffers and the image encoder
_SIZES = {("8B", "Q8_0"): 8.11, ("8B", "Q6_K"): 6.27, ("8B", "Q5_K_M"): 5.45, ("8B", "Q4_K_M"): 4.68,
          ("4B", "Q8_0"): 3.99, ("4B", "Q6_K"): 3.08, ("4B", "Q5_K_M"): 2.69, ("4B", "Q4_K_M"): 2.33}
_MMPROJ = {"8B": 1.08, "4B": 0.78}
_KV_PER_TOKEN = 147456  # 36 layers x 8 KV heads x 128 x 2 (K, V) x 2 bytes, both 4B and 8B


def _need_gb(size: str, quant: str) -> float:
    return _SIZES[(size, quant)] + _MMPROJ[size] + _KV_PER_TOKEN * SUGGEST_CTX / 2**30


def suggestion() -> dict:
    try:
        import torch

        vram = torch.cuda.get_device_properties(0).total_memory / 2**30 if torch.cuda.is_available() else 0.0
    except Exception:
        vram = 0.0
    if vram <= 0:
        return {"size": "4B", "quant": "Q4_K_M", "ctx": SUGGEST_CTX, "need_gb": round(_need_gb("4B", "Q4_K_M"), 1),
                "note": "no GPU found: runs on the CPU (slow)"}
    budget = vram - SUGGEST_SPARE_GB
    for size, quant in _SIZES:
        if _need_gb(size, quant) <= budget:
            return {"size": size, "quant": quant, "ctx": SUGGEST_CTX, "need_gb": round(_need_gb(size, quant), 1),
                    "vram_gb": round(vram, 1)}
    return {"size": "4B", "quant": "Q4_K_M", "ctx": SUGGEST_CTX, "need_gb": round(_need_gb("4B", "Q4_K_M"), 1),
            "vram_gb": round(vram, 1), "note": "part of it runs on the CPU (slow)"}


try:
    from aiohttp import web
    from server import PromptServer

    @PromptServer.instance.routes.get("/lc_vision/danbooru/suggest")
    async def _suggest(_request):
        return web.json_response(suggestion())
except Exception as _route_exc:  # not inside ComfyUI
    pass
