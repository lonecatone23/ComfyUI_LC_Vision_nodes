"""
LC Image with Prompt: a preview that keeps each picture's prompt. Open the viewer (double click the node or the
🔍 button) and the prompt sits next to the picture; click it to copy. Takes a whole Prompt Batch run (a list of
pictures and a list of prompts) or a single picture with its prompt.
"""
from __future__ import annotations

from nodes import PreviewImage

NODE_ID = "LCVisionImageWithPrompt"
NODE_DISPLAY_NAME = "LC Image with Prompt 🖼️"


class LCVisionImageWithPrompt(PreviewImage):
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "images": ("IMAGE", {"tooltip": "The pictures (after VAE Decode). A Prompt Batch run works as is."}),
                "prompt": ("STRING", {"forceInput": True,
                                      "tooltip": "The prompt the pictures were made with. From LC Vision Prompt Batch: "
                                                 "each picture gets its own."}),
            },
            "hidden": {"prompt_info": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"},
        }

    INPUT_IS_LIST = True
    RETURN_TYPES = ()
    RETURN_NAMES = ()
    ESSENTIALS_CATEGORY = None
    SEARCH_ALIASES = ["image with prompt", "preview with prompt", "prompt preview", "batch preview"]
    FUNCTION = "show"
    OUTPUT_NODE = True
    CATEGORY = "LC Vision"
    DESCRIPTION = ("Preview that keeps each picture's prompt. Double click the node (or 🔍) to see the prompt next to "
                   "the picture; click the prompt to copy it.")

    def show(self, images, prompt, prompt_info=None, extra_pnginfo=None):
        pi = prompt_info[0] if isinstance(prompt_info, list) and prompt_info else prompt_info
        ex = extra_pnginfo[0] if isinstance(extra_pnginfo, list) and extra_pnginfo else extra_pnginfo
        prompts = [str(p) for p in (prompt if isinstance(prompt, list) else [prompt])] or [""]
        shown, texts = [], []
        for i, im in enumerate(images):
            res = self.save_images(im, "LC_image_with_prompt", pi, ex)["ui"]["images"]
            shown += res
            texts += [prompts[min(i, len(prompts) - 1)]] * len(res)  # a batch of 2 per prompt: both get it
        return {"ui": {"images": shown, "lc_image_prompts": texts}}


NODE_CLASS_MAPPINGS = {NODE_ID: LCVisionImageWithPrompt}
NODE_DISPLAY_NAME_MAPPINGS = {NODE_ID: NODE_DISPLAY_NAME}
