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
