// LC Vision Prompt Batch: a "What changes" picker for the vary box, a Clear button for the kept base, and the kept base
// filled in after a run (the enhanced or styled base stays on the node until cleared).
import { app } from "../../scripts/app.js";

const NODE = "LCVisionPromptBatch";
const PARTS = ["Camera angle", "Framing", "Lighting", "Time of day", "Location", "Weather", "Season", "Hair color",
  "Hairstyle", "Outfit", "Expression", "Pose"];

const widget = (node, name) => node.widgets?.find((w) => w.name === name);

function hideWidget(node, name) {
  const w = widget(node, name);
  if (!w || w._lcHidden) return;
  w._lcHidden = true;
  w.type = "hidden";
  w.computeSize = () => [0, -4];
  try {
    w.hidden = true;
  } catch (_) {}
  if (w.options) w.options.hidden = true;
}

const picked = (s) => String(s || "").split(/[,\n;]+/).map((p) => p.trim()).filter(Boolean);

function togglePart(node, name, part) {
  const w = widget(node, name);
  if (!w) return;
  const list = picked(w.value);
  const i = list.findIndex((p) => p.toLowerCase() === part.toLowerCase());
  if (i >= 0) list.splice(i, 1);
  else list.push(part);
  w.value = list.join(", ");
  w.callback?.(w.value);
  node.setDirtyCanvas(true, true);
}

// a ✓ list over a comma-separated text widget (also used by LC Vision Filter)
function partsMenu(node, name, parts, title, event) {
  const now = picked(widget(node, name)?.value).map((p) => p.toLowerCase());
  const items = parts.map((p) => ({
    content: (now.includes(p.toLowerCase()) ? "✓ " : "   ") + p,
    callback: () => togglePart(node, name, p),
  }));
  new LiteGraph.ContextMenu(items, { event, title });
}

function noSave(...widgets) {
  for (const b of widgets) {
    b.serialize = false;
    if (b.options) b.options.serialize = false;
  }
}

function addButtons(node) {
  if (node._lcBatchButtons) return;
  node._lcBatchButtons = true;
  const b1 = node.addWidget("button", "🎯 What changes", null, (_v, _c, _n, _p, e) =>
    partsMenu(node, "vary", PARTS, "What changes", e || app.canvas?.last_mouse_event || window.event));
  const b2 = node.addWidget("button", "🗑 Clear kept base", null, () => {
    const k = widget(node, "kept_base");
    const f = widget(node, "kept_for");
    if (k) k.value = "";
    if (f) f.value = "";
    node.setDirtyCanvas(true, true);
  });
  noSave(b1, b2);
}

app.registerExtension({
  name: "LC.Vision.PromptBatch",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE) return;
    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);
      hideWidget(this, "kept_for");
      addButtons(this);
      return r;
    };
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onConfigure?.apply(this, arguments);
      hideWidget(this, "kept_for");
      return r;
    };
    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      onExecuted?.apply(this, arguments);
      const info = message?.lc_batch?.[0];
      if (!info) return;
      const k = widget(this, "kept_base");
      const f = widget(this, "kept_for");
      if (k && info.kept_base !== undefined) k.value = info.kept_base;
      if (f && info.kept_for !== undefined) f.value = info.kept_for;
      if (info.marked) console.log("[LC Vision] Prompt Batch, what changes: [vary] {follow}\n" + info.marked);
      this.setDirtyCanvas(true, true);
    };
  },
});
