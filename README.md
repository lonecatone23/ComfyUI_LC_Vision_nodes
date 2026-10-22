# ComfyUI LC Vision Nodes

Custom nodes for [ComfyUI](https://github.com/comfyanonymous/ComfyUI) by [lonecatone23](https://github.com/lonecatone23).

- **Repo:** [https://github.com/lonecatone23/ComfyUI_LC_Vision_nodes](https://github.com/lonecatone23/ComfyUI_LC_Vision_nodes)
- **Civitai:** [lonecatone23](https://civitai.com/user/lonecatone23)
- **Instagram:** [synth.studio.models](https://www.instagram.com/synth.studio.models/)
- **Support:** [Buy me a ☕](https://ko-fi.com/lonecatone)
- **Version:** 1.4.1 · **8 Python nodes** + the **Vision Assistant** sidebar

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
    - After the download, the node switches itself to the real file name, so the next run just works.
    - **Qwen3.5 VL** (4B Q8, 9B Q4_K_M, 9B Q8) is in the list too. Qwen3-VL stays the ★ pick: in my tests Qwen3.5 was slower and guessed more.
    - Or download from **LC Settings ⚙️ > Vision > Vision models**.
- **★ Report suggestion** (only with [LC123](https://github.com/lonecatone23/ComfyUI_LC123_nodes) installed and its **System & Model Optimization Report** run once):
    - A ★ in front of the model that suits your card, and a line on the node: **★ Report suggests: Qwen3-VL 8B Q8_0 · n_ctx 32768**.
    - Hover the line for the Quality / Optimal / Fast rows.
    - It is only a hint. Nothing is picked for you, and the saved model name never changes.
- **`device: auto / cuda / cpu`:** any option runs from the same installed wheel, so CPU inference on an NVIDIA machine doesn't need a separate CPU build. ⚠️ The prebuilt wheel is a CUDA build: on AMD, Intel or any machine without an NVIDIA CUDA runtime it cannot load, see *AMD, Intel and other non-NVIDIA GPUs* below.
- **`n_ctx`:** **4096 / 8192 / 16384 / 32768**, default **8192**. It is reserved in VRAM up front (about 0.6 / 1.1 / 2.3 / 4.5 GB). 4096 for one image and a short prompt, 8192 for Caption and Prompt Enhancer, 16384–32768 for Moviemaker with several references or video frames. Workflows saved with another number keep it.
- **`keep_model_loaded`:** on (the default) keeps the model in VRAM between runs. Off: every LC Vision node unloads it once it has answered, so your image model gets the whole card, and the next node or run loads it again (a few seconds). 💡 Turn it off on smaller cards, e.g. with SDXL / Pony / Illustrious.
- **Less VRAM, same answers:** flash attention and an 8-bit context cache are on automatically (about 0.5 GB less on a 4B, up to 2 GB on an 8B at 16k). Older llama-cpp-python builds just load the plain way.
- **`n_gpu_layers`:** `-1` offloads everything, `0` forces CPU-only, anything else offloads that many layers.
- **`n_batch`** also sets `n_ubatch` to match. ⚠️ llama-cpp-python defaults `n_ubatch` to 512 **independently** of `n_batch`. Raising only `n_batch` silently does nothing unless something also raises `n_ubatch`. This node does that for you.

## LC Vision Caption 📝

Handle + prompt + references → text.

- **Up to three independent reference images plus a separate reference video**, each labeled distinctly (`<Reference 1>`, `<Reference 2>`, `<Target Video>`) instead of merged into one batch. That's the actual gap in the upstream node this pack exists to close.
- **`max_image_side`** downscales references before sending. Oversized references were the direct cause of the original node's "exceeding capacity" crashes, keep it in proportion with the Loader's `n_batch`.
- **`max_tokens`** is a length limit the model actually follows: it's told to fit under it and end on a whole sentence. If it still runs over, the text is cut back to the last complete sentence, so a low limit gives a shorter caption, never a chopped one. Same for Prompt Enhancer.
- **`style_tag`** (shared with Prompt Enhancer): pushes the response toward a specific visual style regardless of what the reference actually looks like. `None / Realistic / Anime / Cartoon / Cinematic / Hentai / Fantasy / B&W / Noir / Cyberpunk / Illustration / NSFW`.
- **Self-heals on the upstream decode bug.** Resets context first, and if that specific `llama_decode failed` error still surfaces, rebuilds the model from the Loader's own parameters and retries once, automatically. Any other error is not swallowed.

## LC Vision Reviewer 🕵️ (BETA)

A quality gate for finished renders. Asks the vision model yes/no questions and passes the image on with **passed** and a **report**.

- Checks: **hands**, **faces**, **text** (signs spelled right), **artifacts**, plus a **prompt** match when you wire the positive prompt in.
- **custom_checks**: your own, one per line, written so yes = good (e.g. Is she wearing a parka?).
- **on_fail**: **flag** (default) always passes the image on. **block** stops everything wired after it (the save, the upscaler, etc.).
- A batch of more than 4 frames is read as a video: a few frames across the clip are checked together.
- ⚠️ A vision model is a shortlist, not a judge. It misses things. Trust your eye over it.

## LC Vision Prompt Enhancer 📝

Text-only rewrite pass over the same model handle. A vision model is still a perfectly good text-only LLM when nothing gets attached to the message.

- **Presets live in `lc_vision_presets.json`**, not code. Ships with four original presets: `Enhance`, `Refine`, `Creative Rewrite`, `Detailed Visual`.
- **`Custom` preset** sits at the top of the dropdown. Reads the system prompt straight from the `custom_system_prompt` socket instead of the JSON file, for full per-workflow control. A new node starts on `Enhance`, and an empty `custom_system_prompt` falls back to `Enhance` instead of erroring.
- **`Character Anchor` preset** for character datasets: give it the reference picture(s) and a few notes ("blonde hair, fit") and it writes one short description of the person only (face, eyes, hair, skin, build). Never the clothing, pose, background or light, so every prompt in a list can set those. Its inputs don't change between rows, so it runs once per list.
- **`style_tag`**, same shared list as Caption.
- **MOSS BBOX:** base prompt into LC MOSS Layout Prompt's prompt box, its output into `prompt_text`. The output stays a layout: the scene and every box are enhanced on their own, box names and positions kept. Box captions stay short (about 60 tokens): longer, the subjects outgrow their boxes. Bypass the Layout Prompt and the base prompt comes through as a normal prompt. No base prompt: the scene stays empty and the model picks the setting.
- **Think-leak retry:** if the output looks like leftover planning text instead of the actual rewritten prompt, one retry asks explicitly for just the final text.

## LC Vision Danbooru Caption 🏷️

Prompts built for **SDXL, Pony and Illustrious**. One image in, or a rough idea in the prompt box, out comes a prompt short enough for SDXL.

- **mode:** **Image analysis** writes the prompt from the image (the prompt box is not used). **Prompt enhance** rewrites the idea in the prompt box.
- **output:** **short caption**, **detailed caption**, **Danbooru tags**, or **prompt gen mixed** (one or two plain sentences, then the tags). Each finetune likes a different one: Pony and Illustrious lean on tags, realism finetunes on captions.
- **Real Danbooru tags only.** Every tag is checked against the real tag list and repaired or dropped: "denim jeans" becomes `jeans`, "smiling" becomes `smile`, made-up tags are removed, and `no humans` next to `1girl` is cleaned out.
- **max_tokens:** how long the prompt can be, for every output. The instructions follow it. Rough guide: short caption 80, detailed caption 150, tags 150, mixed 200.
- **style_tag:** the same styles as the other LC Vision nodes. On tags it adds the real style tags (Anime = `anime coloring, anime screencap`, Realistic = `realistic, photorealistic`, etc.).
- **quality_tags:** **none**, **Illustrious** (`masterpiece, best quality, ...`), **NoobAI** (`very awa, masterpiece, ...`) or **Pony** (`score_9, score_8_up, ...`). Their opposites go into the negative (`worst quality, low quality` or `score_4, score_5, score_6`). Off by default: they sometimes do more harm than good.
- **negative** box under the prompt: your own negative goes first, the automatic tags follow, duplicates removed.
- **positive** and **negative** outputs. The negative always holds the anatomy, artifact and censorship tags (`bad anatomy, malformed hands, fused fingers, blurry, watermark, censored, mosaic censoring, bar censor, ...`).
- **★ hint on the node:** the Qwen3-VL size that suits your card for this node (it needs only a 4k context), e.g. 4B Q8_0 on 8 GB, 8B Q6_K on 10 GB, 8B Q8_0 on 12 GB and up. Set the Loader to it with **n_ctx 4096** and turn the Loader's **keep_model_loaded** off.
- One image slot and small token counts on purpose. The other LC Vision nodes are for long prompts (video, Krea 2, Qwen-Image).

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

## LC Vision Showrunner (BETA) 🎬

Moviemaker's big brother for long videos: it plans a chain of short segments that pick up from each other, made one per Run by the LC H3 Segment nodes (LC AV, coming next).

- **One style block for every segment.** Who's in it, where, the light and the camera are written once and pasted word for word into every segment, so nothing gets reworded halfway through.
- **One continuous take.** Every segment continues from the last 1.6 s of the one before (`overlap_seconds`), so its new action is planned on the time that's left. A **CUT** only happens where your story writes one ("cut to..."). Walking into a new place happens inside the take.
- **Ends settled.** Each segment ends on a calm pose with the face visible, so the next one has a clean handoff. A line of dialogue never gets split across two segments, and the story's own lines are checked for.
- **Projects.** 💾 **Save** (and every Run) writes the Shot List, the Reference Assembler's list and the settings to `output/LC_H3/<project>/project.json`. 📂 **Load** brings one back; the Reference Assembler keeps its own pictures when it already has some.
- **Plans once.** The plan saves to `output/LC_H3/<project>/plan.json` and reloads in about 2 s without loading the model, until you change the story or the timing, or turn on **replan**.
- **Staging and props.** The camera leads the main person so the face stays visible, and anything that comes back (the cup, the bag) is described once and repeated word for word, so it doesn't change between segments.
- **Fixes the joins.** Before each CONTINUE segment it looks at how the one before **really** ended and rewrites the start to match. Most jumps at a join come from the plan saying "she opens the door" when the door is already open, and H3 snaps the pose to match the words. Timestamps and spoken lines are protected: a rewrite that loses either is thrown out.
- **extend_segments** (on): a shot with a long line gets its own longer segment, up to 10 s, instead of a warning to shorten it. Off: every segment is `segment_seconds` long.
- 💡 **`segment_seconds`** 5 is a good default. Shorter segments = less VRAM. The first segment is 5 s and each CONTINUE adds about 3.5 s, so about 16 segments make a minute.

---

## LC Vision Shot List (BETA) 📋

The story for the Showrunner, filled in like a form instead of written from scratch. No AI involved.

- **The place**, **the cast** (name, man / woman, look) and **one row per shot**: framing, camera move, action, who speaks and the line.
- It writes the story the way the Showrunner reads it best: the place, the cast by name, "Cut to ..." for every new shot and at most one short line per shot.
- **segments:** a suggested segment count: one per shot. A long line gets a longer segment from the Showrunner's **extend_segments**. Plug it into the Showrunner's segments.
- 🧹 **Clear** empties the whole list for a new project (click twice). The Reference Assembler is never cleared.
- **warnings:** what to fix, like a line too long for its shot or a speaker who is not in the cast. Empty when it all looks good.

---

## LC Vision Redirect (BETA) 🔬

The Showrunner does this itself now. Kept so older workflows still open; it passes the plan straight through when the Showrunner already fixed the join.

---

## LC Note translation 🌐

LC Vision is also the translator behind **LC Note 📝** (in LC123). There's no node for it and nothing to wire.

- Pick a ❌ language on an LC Note and click **Translate now**. LC Vision loads a model on its own (text only), translates the note and its title, and unloads it again, so it never sits in your VRAM between clicks.
- It uses your best local LC Vision model: an 8B quant first, then a 4B quant. Run an LC Vision Loader once if you don't have one yet.
- Links, `code`, file names and numbers are locked before translation and checked after. If the model changes one, it retries on its own.
- 💡 It's a 4B-8B model, so it's good, not native. Have someone proofread the languages that matter most to you. Hand edits to a translation are kept.

---

## Vision Assistant 🔬

A sidebar tab (the LC logo on the left) that reads the open workflow for you. Works on **any** workflow.

- **Checkup:** runs by itself on every workflow: missing packs (one card per pack), missing models with download links (or a one-click switch when you already have the same model under another name or format, like qwen3-4B for qwen_3_4b), files in a subfolder (one-click fix), the wrong text encoder, model formats your card can't run well, placeholder files, damaged wiring (one-click repair) and your last error in plain words. No model, no VRAM.
    - 💡 **Swap for LC nodes** comes first: nodes from other packs that have an LC twin doing the same job (rgthree Seed and KSampler Config (as LC Sampler Configure Simple), pysssss ShowText, KJNodes JoinStrings / Image Batch Multi / Get Image Size, Comfyroll and WAS text nodes, mxToolkit Slider / Seed, and its 2D slider as LC Size Pad, etc.). Tick the ones to swap: settings and wires carry over and the LC node takes its place. A node only shows when every wired socket has a match. Undo is on the Snapshots tab. Needs the LC pack that has the twin.
    - 📝 **Convert notes to LC Notes** comes next: core **Note**, **Markdown Note** and any other note node ("note" in its name, holds text, nothing wired). Text, title, colours and place carry over; plain text keeps its line breaks and every web address becomes a real link. Rich notes from other packs keep their headings, bold, lists, tables and code, and their download buttons become LC Note download buttons with their 📂 Place in line, even when that pack isn't installed. Why: LC Notes translate, fix spelling and turn links into link cards. Undo is on the Snapshots tab. Needs LC123.
- **Chat:** ask about the workflow in plain words ("What's broken?", "Can you fix it?", "Where do I put my image?"). Select a node first and ask "how does this work?" to have it explained.
    - 🛑 It never changes anything without asking: every change gets **Yes, do it / No**, with **Undo**.
    - "Where is...?" makes the nodes glow and zooms to them.
- **Guided tour:** "Explain this workflow", then **▶ Guided tour** walks you through it part by part on the canvas, with numbered markers on the settings that matter.
    - Authors: **Snapshots > Guided tour > Save to workflow** ships your tour inside the file. Saved tours are locked (right-click to unlock and edit) and play on any card with no model.
    - **Editing a tour:** right-click it in **Snapshots > Guided tour**, **🔓 Unlock to edit**, right-click again, **Edit tour…**
        - Change the tour's name and each step's title and text.
        - **+ Add a setting…** under a step marks one more setting with the next number on the canvas, with a box for why it matters. **×** removes a marker. Up to 8 per step.
        - 💡 To mark a node outside the step, select it on the canvas first. Its settings show at the top under **Selected on the canvas**.
        - **Add a step** (at the bottom): pick what it lights up (any group, or the nodes you selected on the canvas) and where it goes (at the end or after step N), then **+ Add step**.
        - **↑ ↓** move a step, **×** removes it.
        - **LC Model Optimizer model/clip/vae ⚙️**: showcase your own files. Paste a Hugging Face file link for the model, text encoder or VAE and it shows at the top of the LC Model Optimizer's ★ Recommended list for everyone who opens the workflow (it downloads on their first run). Other links are shown to them to get it. Blank = the defaults. Needs LC123.
        - **Save** locks the tour again. Save the workflow to keep it.
- **Movie:** shows up when a workflow has the LC H3 Segment node. Every segment of the project with a thumbnail and a player, plus face, join and color checks in plain words with a fix button (**Redo segment N**, **Make all remaining**). **Ask about this movie** opens Chat with the numbers already typed in.
- **Batch snapshot:** a look at the run before it starts. A single image always goes straight through. Run only stops to ask when it looks like a mistake: more than 16 images, several runs on a fixed seed, a big upscale on many images. It says which of those settings you changed since opening the workflow. The Snapshots tab shows what the next Run makes. Off in **LC Settings ⚙️ > Vision**.
- **Snapshots and Library:** save the settings you changed (models, LoRAs, steps, bypasses) and put them back in one click. Prompts, seeds and input images stay out unless you tick them.
    - A snapshot remembers each model file's size and hash. Applying it later warns when a file has the same name but is not the same model any more.
- **Models in this workflow** (under the checkup): every model file the workflow uses, ✅ here or ❌ missing, its size and which node uses it. A file you moved to another subfolder still counts ("found in MiniMax\Utility"), and RIFE weights in ComfyUI-Frame-Interpolation's folder are found too.
    - **Find on CivitAI** finds the exact page by the file's hash. **Search CivitAI** looks up a missing file by name (check it is the right one).
    - **📌 Save download links** keeps the exact pages in the workflow, so whoever opens it can download anything they are missing.
    - CivitAI is only contacted when you press a button, and it only gets the hash, never the file.
- **VRAM:** none until you ask the chat something. **Auto** picks the model for your card (8B Q8 on 20 GB+, down to 4B Q4 on 8 GB, CPU chat on smaller cards) and unloads it a minute after the last answer, or the moment you hit Run.
- **Settings:** **LC Settings ⚙️ > Vision** (works without LC123): Assistant on/off, chat model (Auto / Off / a model), default n_ctx for new Loaders, and the model list with a Download button.
- 💡 Hit **?** in the panel for the full help.

---

## 💡 Quick tips

- Restart ComfyUI after installing. Brand-new pack, needs a restart to be discovered.
- Start with `device: cpu` on the Loader for your very first test so it can't collide with whatever else has the GPU, then switch to `cuda` or `auto` once you know it works.
- Seeing `[LC Vision] Decode failed on a reused model instance...; rebuilding and retrying once.` in the console is **expected, not a bug**. That's the self-heal catching the upstream decode bug and recovering on its own. Only flag it if the retry fails too.
- 4B suits Moviemaker and video workloads (more memory headroom for multi-frame batches). 8B suits Caption and image fidelity.
- ✋ Moviemaker's `[Shot N]` label identifies which reference a moment involves. It is not a cut instruction. Ask it for one continuous take per segment if you see it start cross-cutting.

## Example workflows

In `workflows/`:
- **LC Vision LLM Modules**: Caption, Prompt Enhancer, Moviemaker and Reviewer, wired up and ready. Drop your own model and references in.

## Licensing note

`ComfyUI-QwenVL-Mod` (GPL-3.0) has a genuinely good 22-preset library for its Prompt Enhancer. That's real creative content, not mechanical plumbing, so none of it is ported here. Prompt Enhancer ships with a small set of original presets instead.

The GGUF-header reader in `lc_vision_loader.py` is the one piece that resembles upstream code in shape. It isn't ported, it's an independent implementation against the [public GGUF spec](https://github.com/ggml-org/ggml/blob/master/docs/gguf.md), about as mechanical as code gets.

`danbooru_tags.csv` is the tag list from SmilingWolf's WD tagger models ([Here](https://huggingface.co/SmilingWolf/wd-eva02-large-tagger-v3)), Apache-2.0. Used by LC Vision Danbooru Caption to keep only real Danbooru tags.

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
- You need to build the fork for your backend yourself, with a C++ toolchain (Visual Studio Build Tools on Windows) and **ComfyUI's own Python**.
- ✋ **Use ComfyUI's Python, by its full path.** A plain `python -m pip` usually installs into a different Python, and the Loader keeps saying `llama_cpp` is missing. The Loader's error message prints the exact path ComfyUI runs on. Typical ones:
  - Portable: `ComfyUI_windows_portable\python_embeded\python.exe`
  - Desktop app, venv or other installs: the `python.exe` inside that install's `.venv`, `venv` or `python_env` folder
- **Vulkan (AMD or Intel), Windows PowerShell:** install the Vulkan SDK first, then (swap in your path):
```powershell
$py = "N:\ComfyUI\python_env\python.exe"
& $py -m pip install --upgrade cmake ninja scikit-build-core
$env:CMAKE_ARGS = "-DGGML_VULKAN=on"
& $py -m pip install --no-build-isolation --force-reinstall --no-cache-dir "llama-cpp-python @ git+https://github.com/JamePeng/llama-cpp-python.git"
& $py -c "import llama_cpp; print(llama_cpp.__version__)"
```
  - The last line should print a version. If it errors, the build went somewhere else or failed.
- **AMD HIP / ROCm:** the fork's README has the steps (Windows needs the ROCm SDK environment variables set first; Linux uses `CMAKE_ARGS="-DGGML_HIP=ON"`). Same rule: ComfyUI's Python by its full path.
- **CPU only:** the same commands with no `CMAKE_ARGS`.
- *note:* I have only tested this pack on NVIDIA. These build steps come from the fork's own README, so treat them as a starting point.
- If the Loader still says `llama_cpp` is missing, its error shows the real import error and the Python ComfyUI runs on. Send that line with any bug report.

## License

MIT. See `LICENSE`.

**"True, nothing is. Permitted, everything is"**
_Yoda Auditore. *Assassin's Wars*_
