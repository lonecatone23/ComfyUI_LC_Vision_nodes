# ComfyUI LC Vision Nodes

Custom nodes for [ComfyUI](https://github.com/comfyanonymous/ComfyUI) by [lonecatone23](https://github.com/lonecatone23).

- **Repo:** [https://github.com/lonecatone23/ComfyUI_LC_Vision_nodes](https://github.com/lonecatone23/ComfyUI_LC_Vision_nodes)
- **Civitai:** [lonecatone23](https://civitai.com/user/lonecatone23)
- **Instagram:** [synth.studio.models](https://www.instagram.com/synth.studio.models/)
- **Support:** [Buy me a ☕](https://ko-fi.com/lonecatone)
- **Version:** 1.1.1 · **4 Python nodes**

> Local Qwen-VL vision tools built to survive a real ComfyUI session: model stays loaded, several references in one call, and it heals itself when the upstream backend's own decode bug fires.

Companion pack to [ComfyUI_LC123_nodes](https://github.com/lonecatone23/ComfyUI_LC123_nodes), kept separate on purpose.

Release history lives in **git tags**. This page describes the pack **as it is right now**, not a changelog.

---

## Introduction

`ComfyUI-QwenVL-Mod` is the node most people reach for to run Qwen-VL GGUF models in ComfyUI, and it's genuinely feature-rich. Problem is, the GGUF backend crashes partway through a session more often than it should, and that's not bad luck. Three real, fixable causes:

- **The vision backend only exists in a fork.** `Qwen3VLChatHandler`/`Qwen25VLChatHandler` live in `JamePeng/llama-cpp-python`, never merged upstream. That fork ships wheels as GitHub Release assets only, one per exact Python × platform × CUDA combo, not on PyPI. A plain `pip install -r requirements.txt` can never resolve the right one on its own.
- **No memory citizenship.** It manages its own `torch.cuda.empty_cache()` calls and never asks ComfyUI's own `comfy.model_management` for room. Share the GPU with a staged MiniMax H3 pipeline and it grabs whatever's left over, which can be nothing.
- **A real state bug on reused models.** `Llama.reset()` never touches `_hybrid_cache_mgr`, a KV-cache checkpoint the fork builds for hybrid/sliding-window models. Reuse the same `Llama` object twice (completely normal in a real workflow) and it throws `Fatal Decode Error at Pos 0`.

None of that gets fixed by updating a GPU driver. It needs an installer that resolves the right wheel for the machine it's actually running on, a Loader that plays by ComfyUI's memory rules, and a Run node that clears the specific stale state instead of trusting a `reset()` that doesn't do what it says.

---

## LC Vision Loader 🔬

Loads a Qwen-VL GGUF model + its mmproj vision handler once, then hands a persistent handle downstream. ComfyUI's own node caching keeps it resident across queues as long as its inputs don't change.

- **Model discovery:** scans every path registered under the `LLM` folder key (`models/LLM/GGUF` by default), pairs each model `.gguf` with an mmproj `.gguf` in the same folder. Only lists pairs that actually have both.
- **Auto-download on first use:** the dropdown also lists a small curated set of `Download:` entries (Qwen3-VL 4B and 8B, each abliterated, each at `Q8_0` or `f16`) that aren't downloaded yet. Picking one pulls it, and its `mmproj-f16`, straight from HuggingFace into the same folder discovery already scans. `Q8_0` for low-VRAM or new setups, `f16` for well-equipped machines and cloud rigs. An entry drops off the list once it's actually on disk.
- **`device: auto / cuda / cpu`:** any option runs from the same installed wheel, so CPU inference on an NVIDIA machine doesn't need a separate CPU build. ⚠️ The prebuilt wheel is a CUDA build: on AMD, Intel or any machine without an NVIDIA CUDA runtime it cannot load, see *AMD, Intel and other non-NVIDIA GPUs* below.
- **`n_gpu_layers`:** `-1` offloads everything, `0` forces CPU-only, anything else offloads that many layers.
- **`n_batch`** also sets `n_ubatch` to match. ⚠️ llama-cpp-python defaults `n_ubatch` to 512 **independently** of `n_batch`. Raising only `n_batch` silently does nothing unless something also raises `n_ubatch`. This node does that for you.

## LC Vision Caption 📝

Handle + prompt + references → text.

- **Up to three independent reference images plus a separate reference video**, each labeled distinctly (`<Reference 1>`, `<Reference 2>`, `<Target Video>`) instead of merged into one batch. That's the actual gap in the upstream node this pack exists to close.
- **`max_image_side`** downscales references before sending. Oversized references were the direct cause of the original node's "exceeding capacity" crashes, keep it in proportion with the Loader's `n_batch`.
- **`style_tag`** (shared with Prompt Enhancer): pushes the response toward a specific visual style regardless of what the reference actually looks like. `None / Realistic / Anime / Cartoon / Cinematic / Hentai / Fantasy`.
- **Self-heals on the upstream decode bug.** Resets context first, and if that specific `llama_decode failed` error still surfaces, rebuilds the model from the Loader's own parameters and retries once, automatically. Any other error is not swallowed.

## LC Vision Prompt Enhancer 📝

Text-only rewrite pass over the same model handle. A vision model is still a perfectly good text-only LLM when nothing gets attached to the message.

- **Presets live in `lc_vision_presets.json`**, not code. Ships with four original presets: `Enhance`, `Refine`, `Creative Rewrite`, `Detailed Visual`.
- **`Custom` preset** sits at the top of the dropdown. Reads the system prompt straight from the `custom_system_prompt` socket instead of the JSON file, for full per-workflow control. A new node starts on `Enhance`, and an empty `custom_system_prompt` falls back to `Enhance` instead of erroring.
- **`style_tag`**, same shared list as Caption.
- **Think-leak retry:** if the output looks like leftover planning text instead of the actual rewritten prompt, one retry asks explicitly for just the final text.

## LC Vision Moviemaker 🎥

Plans a video as N independently-generated segments in **one** LLM call, not N calls, so the whole arc stays continuous while each segment still comes out as its own self-contained MiniMax H3 prompt.

- **One call, whole plan.** Story, `length_seconds`, `segments`, and preset all go in together. The model writes every segment in one response using a delimiter this node controls, so segment 2 can explicitly continue where segment 1 left off.
- **Output sockets grow with `segments`.** Same autogrow idea as LC Batch Image. Add another wire and the count raises automatically.
- **Presets cover 6 MiniMax H3 modes:** T2V, R2VA, FL2VA, each with an NSFW variant. 💡 **These are a first draft** written from observed conventions, not an authoritative spec. You have far more hands-on MiniMax H3 experience than any of this was written from, refine them freely.
- **`Custom` preset**, same pattern as Prompt Enhancer. The structural rules (clock, continuity, reference handling, timing) still apply underneath it, only the creative wording gets swapped.
- **Four reference images plus one reference video.** `reference_image_1..4` write back as `<Picture N>` tied to `[Shot N]`. `reference_video` labels as `<Target Video>` and feeds motion/style continuity rather than needing the same per-reference description treatment as a still.
- **Segments plan on their own local clock.** Early on, the model tried (and reliably failed) to track a running global timestamp across segments itself, it kept resetting to 0:00 no matter how explicitly that was spelled out. Each segment now plans on its own self-contained clock instead, the thing it's actually good at, and the real global timeline gets stitched in afterward by code. Exact every time.
- **`length_seconds`** defaults to 10.

---

## 💡 Quick tips

- Restart ComfyUI after installing. Brand-new pack, needs a restart to be discovered.
- Start with `device: cpu` on the Loader for your very first test so it can't collide with whatever else has the GPU, then switch to `cuda` or `auto` once you know it works.
- Seeing `[LC Vision] Decode failed on a reused model instance...; rebuilding and retrying once.` in the console is **expected, not a bug**. That's the self-heal catching the upstream decode bug and recovering on its own. Only flag it if the retry fails too.
- 4B suits Moviemaker and video workloads (more memory headroom for multi-frame batches). 8B suits Caption and image fidelity.
- ✋ Moviemaker's `[Shot N]` label identifies which reference a moment involves. It is not a cut instruction. Ask it for one continuous take per segment if you see it start cross-cutting.

## Example workflow

`example workflows/LC Vision Example Workflow.json`. Loader into all three Run nodes, wired up and ready. Drop your own model and references in.

## Licensing note

`ComfyUI-QwenVL-Mod` (GPL-3.0) has a genuinely good 22-preset library for its Prompt Enhancer. That's real creative content, not mechanical plumbing, so none of it is ported here. Prompt Enhancer ships with a small set of original presets instead.

The GGUF-header reader in `lc_vision_loader.py` is the one piece that resembles upstream code in shape. It isn't ported, it's an independent implementation against the [public GGUF spec](https://github.com/ggml-org/ggml/blob/master/docs/gguf.md), about as mechanical as code gets.

## Install

1. **Get the files.** Clone it into `ComfyUI/custom_nodes/`:
   ```bash
   git clone https://github.com/lonecatone23/ComfyUI_LC_Vision_nodes.git
   ```
   Or grab the zip from the repo page and unzip it there instead.
2. **Check the folder.** `__init__.py` needs to sit directly in `ComfyUI/custom_nodes/ComfyUI_LC_Vision_nodes/`, not nested a level down.
3. **Run `install.py`** (ComfyUI-Manager does this automatically on install/update). It checks for a vision-capable `llama_cpp` first and does nothing if you already have one. Otherwise it detects your Python, platform, and CUDA version, and installs the matching wheel from `JamePeng/llama-cpp-python` directly.
4. **Restart ComfyUI.** The console should print the LC Vision load line (4 nodes). If it doesn't, the folder structure is off, go back to step 2.
5. 💡 Hard-refresh your browser after any `web/` JS update going forward. It won't pick up changes on its own.

### AMD, Intel and other non-NVIDIA GPUs
- ⚠️ The prebuilt `JamePeng/llama-cpp-python` wheels are **CUDA-only** (plus Metal on macOS). Without an NVIDIA CUDA runtime they cannot be imported, so `install.py` stops there and changes nothing instead of installing a wheel that can't load.
- You need to build the fork for your backend yourself, with ComfyUI's own Python, a C++ toolchain and CMake:
  - **Vulkan (AMD or Intel):** install the Vulkan SDK, set `CMAKE_ARGS=-DGGML_VULKAN=on`, then `python -m pip install "llama-cpp-python @ git+https://github.com/JamePeng/llama-cpp-python.git"`
  - **AMD HIP / ROCm:** the fork's README has the steps (Windows needs the ROCm SDK environment variables set first; Linux uses `CMAKE_ARGS="-DGGML_HIP=ON"`)
  - **CPU only:** the same pip command with no `CMAKE_ARGS`
- *note:* I have only tested this pack on NVIDIA. These build steps come from the fork's own README, so treat them as a starting point.
- If the Loader still says `llama_cpp` is missing, its error now includes the real import error. Send that line with any bug report.

## License

MIT. See `LICENSE`.

**"True, nothing is. Permitted, everything is"**
_Yoda Auditore. *Assassin's Wars*_
