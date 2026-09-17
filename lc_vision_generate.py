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


def generate_with_recovery(model: LCVisionModel, **chat_kwargs: Any) -> dict:
    """Reset, generate, and self-heal on the one specific known-bad decode
    failure. chat_kwargs are passed straight through to
    create_chat_completion (messages, max_tokens, temperature, ...)."""
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
