import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// One hint line from the LC123 System & Model Optimization Report (only when LC123 is installed and the
// report has been run): the model size / quant and the context size that suit this machine.
let suggestion; // undefined = not fetched, null = no report
async function getSuggestion() {
  if (suggestion !== undefined) return suggestion;
  try {
    const r = await api.fetchApi("/lc123/syscheck/profile");
    suggestion = r.ok ? (await r.json())?.lc_vision?.tiers || null : null;
  } catch (e) {
    suggestion = null;
  }
  return suggestion;
}

async function addHint(node) {
  if (node._lcVisionHint) return;
  const tiers = await getSuggestion();
  const opt = tiers?.Optimal || tiers?.Fast;
  if (!opt || node._lcVisionHint) return;
  // ★ in front of the model that matches the suggestion (display only: the saved value stays the file name)
  const w = (node.widgets || []).find((x) => x.name === "model_name");
  const match = (v, t) => {
    const n = String(v).toLowerCase().replace(/-/g, "_");
    if (n.startsWith("⬇")) return n.includes(`${t.size.toLowerCase()}_`) && n.includes(`(${t.quant.toLowerCase()},`);
    return n.includes("vl") && new RegExp(`(^|[_.])${t.size.toLowerCase()}([_.]|$)`).test(n) && n.includes(t.quant.toLowerCase());
  };
  const values = w?.options?.values || [];
  let star = null;
  for (const t of [tiers.Optimal, tiers.Fast].filter(Boolean)) {
    star = values.find((v) => !String(v).startsWith("⬇") && match(v, t)) || values.find((v) => String(v).startsWith("⬇") && match(v, t));
    if (star) break;
  }
  if (w && star) w.options.getOptionLabel = (v) => (v === star ? `★ ${v}` : v);

  const el = document.createElement("div");
  el.style.cssText = "font:12px sans-serif;color:#9fd8b0;padding:2px 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
  el.textContent = `★ Report suggests: Qwen3-VL ${opt.size} ${opt.quant} · n_ctx ${opt.ctx}`;
  el.title = ["Quality", "Optimal", "Fast"].filter((k) => tiers[k]).map((k) => `${k}: Qwen3-VL ${tiers[k].size} ${tiers[k].quant}, n_ctx ${tiers[k].ctx} (~${tiers[k].need_gb} GB)`).join("\n") +
    "\n\n★ in the model list = the model that matches the Optimal row (a hint only, nothing is picked for you)";
  const hw = node.addDOMWidget("lc_vision_hint", "LC_VISION_HINT", el, { serialize: false, getMinHeight: () => 20, getMaxHeight: () => 20 });
  hw.serializeValue = () => undefined;
  node._lcVisionHint = hw;
  const sz = node.computeSize?.();
  if (sz) node.setSize([Math.max(node.size[0], sz[0]), Math.max(node.size[1], sz[1])]);
  node.setDirtyCanvas?.(true, true);
}

app.registerExtension({
  name: "LCVision.LoaderReportHint",
  nodeCreated(node) { if (node.comfyClass === "LCVisionLoader") addHint(node); },
  loadedGraphNode(node) {
    if (node.comfyClass !== "LCVisionLoader") return;
    // workflows saved before keep_model_loaded existed carry '' in its slot: show it as on (what they did before)
    const k = (node.widgets || []).find((x) => x.name === "keep_model_loaded");
    if (k && typeof k.value !== "boolean") k.value = true;
    addHint(node);
  },
});

// After a "⬇ Download:" entry has downloaded, point the dropdown at the file it now has on disk,
// so the stale download label does not stay selected (it is no longer in the list).
app.registerExtension({
  name: "LCVision.LoaderDownloadSwap",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== "LCVisionLoader") return;
    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      onExecuted?.apply(this, arguments);
      const name = message?.lc_vision_model_name?.[0];
      const w = this.widgets?.find((x) => x.name === "model_name");
      if (!name || !w || w.value === name) return;
      const values = w.options?.values;
      if (Array.isArray(values)) {
        const old = w.value;
        const next = values.filter((v) => v !== old);
        if (!next.includes(name)) next.push(name);
        next.sort((a, b) => (a.startsWith("⬇") - b.startsWith("⬇")) || a.localeCompare(b));
        w.options.values = next;
      }
      w.value = name;
      w.callback?.(name);
      this.setDirtyCanvas(true, true);
    };
  },
});
