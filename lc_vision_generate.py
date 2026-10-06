"""
LC Vision Generate
-------------------
The self-healing chat-completion call shared by every LC Vision Run node
(Caption, Prompt Enhancer, and whatever else needs one later). Owns the
fix for the reused-model decode bug documented in README.md: reset() and
clearing _hybrid_cache_mgr don't fully cover every stale-state path this
installed llama-cpp-python build can hit, so on the specific
"llama_decode failed" error this node rebuilds the model from the
Loader's recorded parameters and retries exactly once, rather than
chasing every private cache by hand.
"""

from __future__ import annotations

from typing import Any

from .lc_vision_loader import LCVisionModel, build_llama


def reset_model_state(llm: Any) -> None:
    if hasattr(llm, "reset"):
        try:
            llm.reset()
        except Exception as exc:
            print(f"[LC Vision] context reset skipped: {exc}")

    cache_mgr = getattr(llm, "_hybrid_cache_mgr", None)
    if cache_mgr is not None and hasattr(cache_mgr, "clear"):
        try:
            cache_mgr.clear()
        except Exception as exc:
            print(f"[LC Vision] hybrid cache clear skipped: {exc}")


def ensure_loaded(model: LCVisionModel) -> None:
    """A model unloaded after an earlier run (keep_model_loaded off) is loaded again from the Loader's own settings."""
    if getattr(model, "llm", None) is None and getattr(model, "build_params", None) is not None:
        print(f"[LC Vision] Loading '{model.model_name}' again (it was unloaded after the last run).")
        model.llm, model.chat_handler = build_llama(model.build_params)


def _unload_now(model: LCVisionModel) -> None:
    llm = getattr(model, "llm", None)
    if llm is None:
        return
    model.llm = None
    model.chat_handler = None
    if hasattr(llm, "close"):
        try:
            llm.close()
        except Exception as exc:
            print(f"[LC Vision] unload: close() failed (non-fatal): {exc}")
    del llm
    import gc

    gc.collect()
    print(f"[LC Vision] Unloaded '{model.model_name}' (keep_model_loaded is off).")


# keep_model_loaded off: a node marks the model, and it unloads when the next node that needs the GPU starts (a sampler,
# text encode, VAE encode, ...) or when the run ends. So analyze -> enhance in one run uses one load, and the image model
# still gets the whole card.
VISION_NODES = {"LCVisionLoader", "LCVisionCaption", "LCVisionPromptEnhancer", "LCVisionMoviemaker", "LCVisionDanbooruCaption"}
GPU_INPUTS = {"MODEL", "CLIP", "VAE", "LATENT", "CONDITIONING", "CONTROL_NET", "UPSCALE_MODEL", "SAM_MODEL"}
_pending: dict[int, LCVisionModel] = {}
_hooked = False
_gpu_class: dict[str, bool] = {}


def _uses_gpu(class_type: str) -> bool:
    if class_type in _gpu_class:
        return _gpu_class[class_type]
    hit = False
    try:
        import nodes

        cls = nodes.NODE_CLASS_MAPPINGS.get(class_type)
        spec = cls.INPUT_TYPES() if cls is not None else {}
        for group in ("required", "optional"):
            for v in (spec.get(group) or {}).values():
                if isinstance(v, (tuple, list)) and v and isinstance(v[0], str) and v[0] in GPU_INPUTS:
                    hit = True
    except Exception:
        hit = False
    _gpu_class[class_type] = hit
    return hit


def _unload_pending() -> None:
    for model in list(_pending.values()):
        _unload_now(model)
    _pending.clear()


def _install_hook() -> None:
    """Follows the run without a browser attached: ComfyUI starts progress for every node before it runs (we check its
    class there) and calls task_done when the run is over."""
    global _hooked
    if _hooked:
        return
    try:
        from comfy_execution.progress import ProgressRegistry
        from execution import PromptQueue
    except Exception:
        return
    start = ProgressRegistry.start_progress
    done = PromptQueue.task_done

    def start_progress(self, node_id, *a, **kw):
        try:
            if _pending:
                node = self.dynprompt.get_node(node_id) if self.dynprompt is not None else None
                cls = node.get("class_type") if node else None
                if cls and cls not in VISION_NODES and _uses_gpu(cls):
                    _unload_pending()  # before the next GPU node loads its model
        except Exception as exc:
            print(f"[LC Vision] keep_model_loaded hook: {exc}")
        return start(self, node_id, *a, **kw)

    def task_done(self, *a, **kw):
        try:
            _unload_pending()  # the run is over (finished, failed or stopped)
        except Exception as exc:
            print(f"[LC Vision] keep_model_loaded hook: {exc}")
        return done(self, *a, **kw)

    ProgressRegistry.start_progress = start_progress
    PromptQueue.task_done = task_done
    _hooked = True


def release(model: LCVisionModel) -> None:
    """keep_model_loaded off: mark the model to unload before the next GPU node, or at the end of the run."""
    if model is None or getattr(model, "keep_loaded", True) or getattr(model, "llm", None) is None:
        return
    _install_hook()
    if not _hooked:  # outside ComfyUI: no run to follow, unload now
        _unload_now(model)
        return
    _pending[id(model)] = model


def generate_with_recovery(model: LCVisionModel, **chat_kwargs: Any) -> dict:
    """Reset, generate, and self-heal on the one specific known-bad decode
    failure. chat_kwargs are passed straight through to
    create_chat_completion (messages, max_tokens, temperature, ...)."""
    ensure_loaded(model)
    reset_model_state(model.llm)

    def _call():
        return model.llm.create_chat_completion(**chat_kwargs)

    try:
        return _call()
    except RuntimeError as exc:
        if "llama_decode failed" not in str(exc):
            raise
        print(f"[LC Vision] Decode failed on a reused model instance ({exc}); rebuilding and retrying once.")
        if model.build_params is None:
            raise
        old_llm = model.llm
        new_llm, new_chat_handler = build_llama(model.build_params)
        model.llm = new_llm
        model.chat_handler = new_chat_handler
        if hasattr(old_llm, "close"):
            try:
                old_llm.close()
            except Exception as close_exc:
                print(f"[LC Vision] old instance close() failed (non-fatal): {close_exc}")
        return model.llm.create_chat_completion(**chat_kwargs)
