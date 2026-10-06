import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// One hint line on LC Vision Danbooru Caption: the Qwen3-VL size / quant that suits this card for this node
// (short 4k context, model unloaded after each run, so it gets nearly the whole card). A hint only.
let suggestion; // undefined = not fetched, null = unavailable
async function getSuggestion() {
  if (suggestion !== undefined) return suggestion;
  try {
    const r = await api.fetchApi("/lc_vision/danbooru/suggest");
    suggestion = r.ok ? await r.json() : null;
  } catch (e) {
    suggestion = null;
  }
  return suggestion;
}

async function addHint(node) {
  if (node._lcDanbooruHint) return;
  const s = await getSuggestion();
  if (!s || node._lcDanbooruHint) return;
  const el = document.createElement("div");
  el.style.cssText = "font:12px sans-serif;color:#9fd8b0;padding:2px 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
  el.textContent = `★ For this node: Qwen3-VL ${s.size} ${s.quant} · n_ctx ${s.ctx}`;
  el.title =
    `Best Qwen3-VL for this node on your card${s.vram_gb ? ` (${s.vram_gb} GB)` : ""}: ${s.size} ${s.quant}, about ${s.need_gb} GB.\n` +
    `Set the LC Vision Loader to it, with n_ctx ${s.ctx} (one image and a short prompt need no more).\n` +
    "Turn keep_model_loaded off on the Loader so your SDXL checkpoint gets the card back after each prompt." +
    (s.note ? `\n${s.note}` : "");
  const hw = node.addDOMWidget("lc_danbooru_hint", "LC_DANBOORU_HINT", el, { serialize: false, getMinHeight: () => 20, getMaxHeight: () => 20 });
  hw.serializeValue = () => undefined;
  node._lcDanbooruHint = hw;
  const sz = node.computeSize?.();
  if (sz) node.setSize([Math.max(node.size[0], sz[0]), Math.max(node.size[1], sz[1])]);
  node.setDirtyCanvas?.(true, true);
}

app.registerExtension({
  name: "LCVision.DanbooruHint",
  nodeCreated(node) { if (node.comfyClass === "LCVisionDanbooruCaption") addHint(node); },
  loadedGraphNode(node) { if (node.comfyClass === "LCVisionDanbooruCaption") addHint(node); },
});
