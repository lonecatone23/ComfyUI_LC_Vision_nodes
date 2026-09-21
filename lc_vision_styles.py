"""
LC Vision style tags
---------------------
Shared by LC Vision Caption and LC Vision Prompt Enhancer so both use the
exact same list and wording rather than each keeping their own copy.
Original content, written for this pack.
"""

from __future__ import annotations

STYLE_TAG_DESCRIPTIONS = {
    "Realistic": "photorealistic, lifelike detail, natural lighting and true-to-life textures",
    "Anime": "Japanese anime illustration style, cel-shaded coloring, expressive linework",
    "Cartoon": "stylized cartoon illustration, bold clean outlines, simplified flat shading",
    "Cinematic": "cinematic film still -- dramatic directional lighting, shallow depth of field, wide dynamic range",
    "Hentai": "anime-style adult illustration, explicit content, cel-shaded coloring",
    "Fantasy": "fantasy illustration, otherworldly elements, dramatic atmospheric lighting",
    "B&W": "black and white photography with no color at all, a full tonal range from deep blacks to clean whites, strong contrast and fine film grain",
    "Noir": "film noir, high-contrast black and white with deep shadows and hard directional light, window-blind shadow stripes, smoke and rain, moody 1940s crime-drama atmosphere",
    "Cyberpunk": "cyberpunk, a neon-lit rainy city at night, magenta and cyan glow, holograms and glowing signage, wet reflective streets, dense high-tech low-life urban atmosphere",
    "Illustration": "hand-drawn illustration that focuses on line work and sketching, visible pencil or ink lines, cross-hatching and varied line weight, a sketchbook feel with restrained color, not anime and not cartoon",
    "NSFW": "adult (18+) content in full explicit detail. Describe any sexual acts plainly and precisely, naming the specific act, the positions, the body parts involved and who is doing what to whom, in direct language without euphemism or omission. If anyone appears to be a minor, do not describe any sexual content",
}
STYLE_TAG_OPTIONS = ["None"] + list(STYLE_TAG_DESCRIPTIONS.keys())


def style_directive_text(style_tag: str) -> str | None:
    """The directive text for a style tag, or None for 'None'/unknown."""
    if not style_tag or style_tag == "None":
        return None
    description = STYLE_TAG_DESCRIPTIONS.get(style_tag)
    if not description:
        return None
    return (
        f"Final style directive: render this explicitly as {description}. State the style "
        f"clearly and keep it consistent throughout -- this directive takes priority over "
        f"any conflicting style implied elsewhere."
    )


def apply_style_tag_to_text(user_text: str, style_tag: str) -> str:
    """For plain-text prompts (Prompt Enhancer): prefix a marker, append the
    directive at the end for recency."""
    directive = style_directive_text(style_tag)
    if directive is None:
        return user_text
    return f"[Style: {style_tag}]\n{user_text}\n\n{directive}"


def apply_style_tag_to_content(content: list[dict], style_tag: str) -> list[dict]:
    """For multimodal message content lists (Caption): append the directive
    as a trailing text block, after every reference, for the same recency
    reason -- a directive placed before the images risks getting diluted by
    everything that follows it."""
    directive = style_directive_text(style_tag)
    if directive is None:
        return content
    return content + [{"type": "text", "text": f"\n{directive}"}]
