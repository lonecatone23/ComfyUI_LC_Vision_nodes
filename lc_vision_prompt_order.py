"""
The shared order every LC Vision prompt writer follows: the room first, then the person.

Benched on Krea 2 (2026-11-21 and 11-22, one part moved at a time):
  - camera words at the end turn into a camera she holds, and the angle gets weaker: camera first
  - a pose written early changes (a foot up on the wall instead of crossed ankles): pose late
  - mood words first turn into a pose: mood late
  - light early, the person (with the outfit) after the place
Beyond that the exact order matters little; one fixed order is what lets the Filter and Smart Prompt Batch find each part.
"""
from __future__ import annotations

# slot names, in prompt order
ORDER = ["camera", "light", "setting", "person", "expression", "pose", "mood", "style"]

ORDER_RULE = (
    "Write it in this order, as natural phrases, never as labels: the camera first when there is one (where it "
    "stands and how much of the scene the frame takes in; never invent an angle that is not given or shown); then "
    "the light; then the place with its details, the background "
    "and the weather; then the person (age, face, hair, build) with the outfit and accessories; then the expression; "
    "then the pose; then the mood in a few words; the style or medium words last. Never end on camera words.")

POSE_RULE = (
    "Write a pose as body mechanics: where the weight sits (which leg, what the other knee does), which way the hips "
    "and shoulders turn, the head and chin, where each hand is, and the feet. Mood words (elegant, candid, effortless) "
    "never stand in for a pose.")

# which slot a part name belongs to (Filter and Smart Prompt Batch part names)
PART_SLOT = {
    "camera angle": "camera", "framing": "camera", "camera": "camera",
    "lighting": "light", "light": "light", "time of day": "light",
    "location": "setting", "background": "setting", "props": "setting", "weather": "setting", "season": "setting",
    "place": "setting", "setting": "setting",
    "person": "person", "face": "person", "hair": "person", "hair color": "person", "hairstyle": "person",
    "body": "person", "outfit": "person", "accessories": "person", "makeup": "person", "eye color": "person",
    "expression": "expression",
    "pose": "pose",
    "mood": "mood",
    "style": "style",
}


def slot_rank(part: str) -> float:
    """Position of a part name in ORDER (unknown parts sit just before the style words)."""
    slot = PART_SLOT.get(part.strip().lower())
    return ORDER.index(slot) if slot else ORDER.index("style") - 0.5


def in_order(parts: list[str]) -> list[str]:
    """Part names sorted into the shared order (stable for parts in the same slot)."""
    return sorted(parts, key=slot_rank)
