"""
LC Vision Caption
-----------------
The Run half of the Loader/Run split. Takes an LC_VISION_MODEL handle plus
a prompt and up to several independent reference images and a reference
video, and returns generated text.

Runs on every execution (unlike the Loader, which ComfyUI's own node
caching skips re-running when its inputs are unchanged) -- so every call
goes through lc_vision_generate.generate_with_recovery, which owns the
fix for the stale-model-reuse bug traced in the pack README (reset(),
clearing _hybrid_cache_mgr, and a rebuild-and-retry-once fallback for
what those two don't cover).
"""

from __future__ import annotations

import base64
import io

import numpy as np
from PIL import Image

from .lc_vision_generate import generate_with_recovery
from .lc_vision_loader import LCVisionModel, MODEL_TYPE
from .lc_vision_styles import STYLE_TAG_OPTIONS, apply_style_tag_to_content

NODE_ID = "LCVisionCaption"
NODE_DISPLAY_NAME = "LC Vision Caption 📝"

DEFAULT_SYSTEM_PROMPT = (
    "You are a helpful vision assistant. Describe what you are shown in rich, concrete "
    "detail rather than a brief summary: subject appearance, pose and expression, "
    "clothing, setting and background, lighting, color palette, composition and camera "
    "angle, and overall mood. Do not skip detail for the sake of brevity. Respond with "
    "the final answer only -- no reasoning, no <think> blocks."
)

DEFAULT_PROMPT = (
    "Describe this image in detail: the subject's appearance, pose, and expression, "
    "their clothing, the setting and background, lighting and color palette, "
    "composition, and overall mood."
)


def _frame_to_base64(frame: np.ndarray, max_side: int, quality: int) -> str:
    pixels = np.clip(frame * 255.0, 0, 255).astype(np.uint8)
    if pixels.shape[-1] == 1:
        img = Image.fromarray(pixels[..., 0], mode="L").convert("RGB")
    elif pixels.shape[-1] >= 4:
        img = Image.fromarray(pixels[..., :3], mode="RGB")
    else:
        img = Image.fromarray(pixels, mode="RGB")

    if max_side > 0 and max(img.size) > max_side:
        img.thumbnail((max_side, max_side), Image.LANCZOS)

    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def _image_input_to_base64_list(image_tensor, max_side: int, quality: int) -> list[str]:
    """A ComfyUI IMAGE is [B,H,W,C]. Treat every frame in the batch as one
    reference -- this is what lets a single socket carry either one still
    or a whole video's worth of frames."""
    if image_tensor is None:
        return []
    arr = image_tensor.detach().cpu().numpy() if hasattr(image_tensor, "detach") else np.asarray(image_tensor)
    if arr.ndim == 3:
        arr = arr[None, ...]
    return [_frame_to_base64(arr[i], max_side, quality) for i in range(arr.shape[0])]


def _sample_indices(count: int, max_frames: int) -> list[int]:
    if max_frames <= 0 or count <= max_frames:
        return list(range(count))
    # Evenly spaced, always includes the first and last frame.
    step = (count - 1) / (max_frames - 1)
    return sorted({round(i * step) for i in range(max_frames)})


class LCVisionCaption:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "vision_model": (MODEL_TYPE, {"tooltip": "Handle from LC Vision Loader. Stays resident across queues as long as the Loader's own inputs don't change."}),
                "prompt": (
                    "STRING",
                    {"multiline": True, "default": DEFAULT_PROMPT, "tooltip": "The user instruction. Reference labels are added automatically for whatever's connected."},
                ),
            },
            "optional": {
                "system_prompt": ("STRING", {"multiline": True, "default": DEFAULT_SYSTEM_PROMPT, "tooltip": "Instruction that frames the whole response -- role, tone, and output format. Applies before the per-call prompt and reference images."}),
                "reference_image_1": ("IMAGE", {"tooltip": "Labeled <Reference 1> in the prompt."}),
                "reference_image_2": ("IMAGE", {"tooltip": "Labeled <Reference 2> in the prompt."}),
                "reference_image_3": ("IMAGE", {"tooltip": "Labeled <Reference 3> in the prompt."}),
                "reference_video": ("IMAGE", {"tooltip": "A frame-sequence batch, labeled <Target Video>. Sampled down to video_max_frames."}),
                "video_max_frames": ("INT", {"default": 8, "min": 1, "max": 64, "tooltip": "Reference video frames are evenly sampled down to this count before sending -- sending every frame of a long clip would blow the token budget."}),
                "style_tag": (STYLE_TAG_OPTIONS, {"default": "None", "tooltip": "Pushes the response toward a specific visual-style description regardless of the reference's actual look -- useful when captioning a realistic reference but wanting an anime/cinematic/etc. framing out. 'None' leaves style unconstrained."}),
                "max_image_side": ("INT", {"default": 768, "min": 0, "max": 4096, "tooltip": "Downscale any reference longer edge to this before sending. 0 = no resize. Oversized references were the direct cause of the original node's 'exceeding capacity' crashes; keep this and n_batch (on the Loader) in proportion to each other."}),
                "jpeg_quality": ("INT", {"default": 90, "min": 10, "max": 100, "tooltip": "JPEG encoding quality for references sent to the model. Higher = better fidelity but a larger payload -- lower this before raising max_image_side if you're hitting capacity limits."}),
                "max_tokens": ("INT", {"default": 1024, "min": 16, "max": 16384, "tooltip": "Upper limit on generated tokens. Generation can stop earlier on its own; this only caps the ceiling."}),
                "temperature": ("FLOAT", {"default": 0.6, "min": 0.0, "max": 2.0, "step": 0.05, "tooltip": "Sampling randomness. 0 = deterministic and literal, higher = more varied wording at some cost to focus."}),
                "top_p": ("FLOAT", {"default": 0.9, "min": 0.0, "max": 1.0, "step": 0.01, "tooltip": "Nucleus sampling: only sample from the smallest set of tokens covering this cumulative probability. Lower = more focused, higher = more varied."}),
                "repetition_penalty": ("FLOAT", {"default": 1.1, "min": 0.5, "max": 2.0, "step": 0.01, "tooltip": "Penalizes tokens the model has already used, to discourage repetitive or looping output. 1.0 = no penalty."}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 2**32 - 1, "tooltip": "Sampling seed. Same seed + same inputs should reproduce the same output, modulo hardware/threading nondeterminism."}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("text",)
    FUNCTION = "run"
    CATEGORY = "LC Vision"
    DESCRIPTION = (
        "Generates text from a loaded LC Vision model, an instruction, and up to three "
        "independent reference images plus a reference video -- each labeled distinctly "
        "in the prompt rather than merged into one batch."
    )

    def run(
        self,
        vision_model: LCVisionModel,
        prompt: str,
        system_prompt: str = DEFAULT_SYSTEM_PROMPT,
        reference_image_1=None,
        reference_image_2=None,
        reference_image_3=None,
        reference_video=None,
        video_max_frames: int = 8,
        style_tag: str = "None",
        max_image_side: int = 768,
        jpeg_quality: int = 90,
        max_tokens: int = 1024,
        temperature: float = 0.6,
        top_p: float = 0.9,
        repetition_penalty: float = 1.1,
        seed: int = 0,
    ) -> tuple[str]:
        if vision_model is None or getattr(vision_model, "llm", None) is None:
            raise ValueError("[LC Vision] Caption received no model -- connect an LC Vision Loader.")

        content: list[dict] = [{"type": "text", "text": prompt}]

        for idx, ref in enumerate((reference_image_1, reference_image_2, reference_image_3), start=1):
            if ref is None:
                continue
            frames = _image_input_to_base64_list(ref, max_image_side, jpeg_quality)
            if not frames:
                continue
            content.append({"type": "text", "text": f"\n<Reference {idx}>"})
            for b64 in frames:
                content.append({"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}})

        if reference_video is not None:
            all_frames = _image_input_to_base64_list(reference_video, max_image_side, jpeg_quality)
            if all_frames:
                keep = _sample_indices(len(all_frames), video_max_frames)
                content.append({"type": "text", "text": f"\n<Target Video> ({len(keep)} of {len(all_frames)} frames)"})
                for i in keep:
                    content.append({"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{all_frames[i]}"}})

        content = apply_style_tag_to_content(content, style_tag)

        effective_user_content = content
        if getattr(vision_model, "is_qwen3_family", False):
            # Disable Qwen3's <think> reasoning path the same way the upstream pack
            # does -- a captioner has no use for visible planning. This installed
            # create_chat_completion() has no chat_template_kwargs passthrough (it's
            # a fully explicit signature, not **kwargs), so the prompt-level /no_think
            # marker is the actual mechanism, not decoration alongside a kwarg.
            effective_user_content = [{"type": "text", "text": "/no_think"}] + content

        messages = [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": effective_user_content},
        ]

        response = generate_with_recovery(
            vision_model,
            messages=messages,
            max_tokens=max_tokens,
            temperature=temperature,
            top_p=top_p,
            repeat_penalty=repetition_penalty,
            seed=seed,
        )

        if not response or "choices" not in response or not response["choices"]:
            raise RuntimeError("[LC Vision] Model returned an empty response.")

        text = (response["choices"][0].get("message", {}).get("content", "") or "").strip()
        return (text,)


NODE_CLASS_MAPPINGS = {
    NODE_ID: LCVisionCaption,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    NODE_ID: NODE_DISPLAY_NAME,
}
