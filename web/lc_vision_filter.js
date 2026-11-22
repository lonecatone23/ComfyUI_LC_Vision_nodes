// LC Vision Filter: ✓ lists for the describe and leave_out boxes (same picker as Prompt Batch's "What changes").
import { app } from "../../scripts/app.js";

const widget = (node, name) => node.widgets?.find((w) => w.name === name);
const picked = (s) => String(s || "").split(/[,\n;]+/).map((p) => p.trim()).filter(Boolean);

function toggle(node, name, part) {
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

function partsMenu(node, name, parts, title, event) {
  const now = picked(widget(node, name)?.value).map((p) => p.toLowerCase());
  const items = parts.map((p) => ({ content: (now.includes(p.toLowerCase()) ? "✓ " : "   ") + p, callback: () => toggle(node, name, p) }));
  new LiteGraph.ContextMenu(items, { event, title });
}

function noSave(...widgets) {
  for (const b of widgets) {
    b.serialize = false;
    if (b.options) b.options.serialize = false;
  }
}

const NODE = "LCVisionFilter";
const PARTS = ["Camera angle", "Framing", "Lighting", "Time of day", "Location", "Background", "Props", "Weather",
  "Person", "Face", "Hair", "Body", "Outfit", "Accessories", "Expression", "Pose", "Style"];

const ev = (e) => e || app.canvas?.last_mouse_event || window.event;

app.registerExtension({
  name: "LC.Vision.Filter",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE) return;
    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);
      const b1 = this.addWidget("button", "🎯 Describe only", null, (_v, _c, _n, _p, e) =>
        partsMenu(this, "describe", PARTS, "Describe only", ev(e)));
      const b2 = this.addWidget("button", "🚫 Leave out", null, (_v, _c, _n, _p, e) =>
        partsMenu(this, "leave_out", PARTS, "Leave out", ev(e)));
      noSave(b1, b2);
      return r;
    };
  },
});
