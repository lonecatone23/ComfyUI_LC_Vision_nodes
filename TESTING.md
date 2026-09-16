# LC Vision — manual test note

Paste this into a Note node on your test workflow. Covers Loader, Caption, Prompt Enhancer.

## Setup

1. Restart ComfyUI (brand-new pack, needs a restart to be discovered).
2. Add **LC Vision Loader** (category `LC Vision`). Model dropdown should list vision-capable pairs found under `models/LLM/GGUF` — on this machine that's the 5 Qwen3-VL GGUF/mmproj pairs already there. If the dropdown says "no vision GGUF models found," a model or its mmproj sibling isn't in the same folder.
3. Start with `device: cpu` for the first pass so it can't collide with whatever else has the GPU — confirm it works before trying `cuda`/`auto`.

## Test 1 — basic Caption, single image

- Loader → **LC Vision Caption**. Wire one `LoadImage` into `reference_image_1`. Leave `prompt` at default or ask something the image can answer.
- Expect: a real, on-topic answer. Console should NOT print `[LC Vision] Decode failed...` on this first call.

## Test 2 — multi-reference (the actual point of this node)

- Same Caption node: wire a **second and third** image into `reference_image_2`/`3`, and optionally a batch of frames (e.g. from a video loader) into `reference_video`.
- Ask something that requires distinguishing them, e.g. *"List what's different between Reference 1, Reference 2, and Reference 3."*
- Expect: the answer addresses them separately and correctly, not merged into one description.

## Test 3 — the regression test that actually matters

- **Queue the same Caption node 3–4 times in a row** without touching the Loader (so it reuses the same loaded model instead of reloading).
- Watch the console. You will very likely see, on the 2nd+ run:
  ```
  [LC Vision] Decode failed on a reused model instance (...); rebuilding and retrying once.
  ```
  **This line appearing is expected and correct, not a bug** — this is the whole reason this pack exists. It means the known upstream decode bug fired, and this node caught it and self-healed automatically. Confirm you still got a real answer back on every single run, with no crash and no red error box in ComfyUI.
- If you ever see a crash instead of a clean recovery, or the same decode error twice in a row (retry also failed) — that's a real bug, flag it.
- Known current limitation: because the rebuild fires on most/all reused calls on this install, repeated Caption calls are currently about as slow as a fresh load each time. That's a known, documented tradeoff (correctness first) — not something to re-report.

## Test 4 — device switching

- Set Loader `device` to `cuda` (or `auto` while your GPU has headroom) and re-run Test 1. Should behave the same, just faster.
- If you deliberately run this while the GPU is nearly full (e.g. mid-MiniMax-H3-generation), `device: cpu` should still work without disturbing the other process — that's the scenario this was built to fix.

## Test 5 — Prompt Enhancer

- Loader → **LC Vision Prompt Enhancer**. Type a short rough prompt into `prompt_text` (e.g. `a cat on a roof`).
- Try each of the 4 presets in turn: `Enhance`, `Refine`, `Creative Rewrite`, `Detailed Visual`. Each should read distinctly different in character (Enhance = fuller version of the same idea, Refine = cleanup only, Creative Rewrite = new angle, Detailed Visual = technical/photographic detail).
- Repeat 2–3 times on the same loaded model like Test 3 — same expectation: self-heal, no crash.
- Output should never contain visible `<think>` tags or leftover planning text ("Okay, first I'll..."). If it does slip through, note what prompt caused it.

## Test 6 — Moviemaker

- Loader → **LC Vision Moviemaker**. Type a short story into `story`, pick a preset (start with `Minimax H3 T2V`, no references needed), set `length_seconds` and `segments` (try 3).
- Confirm exactly 3 output sockets appear on the node (grow the `segments` widget and watch a 4th appear live; shrink it back and watch it disappear).
- Read all 3 segment outputs: each should be a complete, timestamped-from-0.00 prompt on its own, but read together they should tell one continuous story (segment 2 picking up from segment 1, not starting a new scene).
- Try `Minimax H3 R2VA` with a real reference image (not a blank test swatch) and a story describing what the person/subject in it should do. Confirm the output references `<Picture 1>` / `[Shot 1]` and describes plausible motion from that starting image.
- If the model doesn't split cleanly into the requested count, you'll see a console line about a retry — same self-healing philosophy as the other nodes, not a bug on its own.
- These 6 presets are a **first draft** — if the actual MiniMax H3 format they produce doesn't match what you know works, edit `lc_vision_moviemaker_presets.json` directly; no code change needed.

## What to report back

- Any crash that ISN'T the self-healing message followed by a successful retry.
- Any answer that's clearly wrong for the images shown (real quality issue, not a pipeline bug).
- Whether the rebuild-on-every-call pattern from Test 3 holds true for you too, or whether some calls skip it (would suggest the bug is less than 100% deterministic in general, not just on this machine).
