"""
ComfyUI_LC_Vision_nodes — LC Vision Nodes by lonecatone23

Qwen-VL GGUF vision/captioning tools. Separate repo, separate Registry name.
Shares no code with ComfyUI_LC123_nodes or ComfyUI_LC_ModelBuilder_nodes on
purpose — this pack is for local vision-language inference (captioning,
prompt enhancement, multi-reference alignment), not image/audio/video
pipelines or model merging.

https://github.com/lonecatone23
https://ko-fi.com/lonecatone
"""

import os as _os

_PACK_DIR = _os.path.dirname(_os.path.abspath(__file__))
print(f"[LC Vision] loading from {_PACK_DIR}")
_nested = _os.path.join(_PACK_DIR, "ComfyUI_LC_Vision_nodes", "__init__.py")
if _os.path.isfile(_nested):
    print(
        "[LC Vision] WARNING: nested pack folder detected. "
        f"{_nested} will be ignored. Unzip so __init__.py sits in {_PACK_DIR}"
    )

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}


def _load(module_name: str) -> None:
    """Import a submodule and merge its mappings. Log and skip on failure."""
    import importlib
    import traceback

    try:
        mod = importlib.import_module(f".{module_name}", __name__)
        maps = getattr(mod, "NODE_CLASS_MAPPINGS", None) or {}
        disp = getattr(mod, "NODE_DISPLAY_NAME_MAPPINGS", None) or {}
        NODE_CLASS_MAPPINGS.update(maps)
        NODE_DISPLAY_NAME_MAPPINGS.update(disp)
        print(f"[LC Vision] + {module_name}: {list(maps.keys())}")
    except Exception as e:
        print(f"[LC Vision] ! failed to load {module_name}: {e}")
        traceback.print_exc()


_load("lc_vision_loader")
_load("lc_vision_caption")
_load("lc_vision_prompt_enhancer")
_load("lc_vision_moviemaker")

WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

print(f"[LC Vision] total {len(NODE_CLASS_MAPPINGS)} nodes: {sorted(NODE_CLASS_MAPPINGS.keys())}")
