/**
 * LC Vision Moviemaker -- output sockets grow/shrink with the `segments`
 * widget. Python always declares MAX_SEGMENTS (20) outputs (RETURN_TYPES is
 * fixed at class-definition time, no per-instance dynamic outputs), so this
 * just adds/removes real sockets to match how many are actually wanted --
 * removed sockets are gone from node.outputs entirely, not merely hidden,
 * so ComfyUI's execution only maps the function's returned tuple onto the
 * ones that still exist.
 */
import { app } from "../../scripts/app.js";

const NODE_CLASS = "LCVisionMoviemaker";
const MAX_SEGMENTS = 20;
const OUTPUT_TYPE = "STRING";

function outputName(i) {
  return `segment_${i}`;
}

function segmentsWidget(node) {
  return (node.widgets || []).find((w) => w && w.name === "segments");
}

function currentCount(node) {
  const w = segmentsWidget(node);
  let n = w ? parseInt(w.value, 10) : 1;
  if (Number.isNaN(n)) n = 1;
  return Math.max(1, Math.min(MAX_SEGMENTS, n));
}

function syncOutputs(node) {
  if (!node.outputs) return;
  const want = currentCount(node);

  // Remove any segment_* output beyond `want`, from the end backward so
  // indices never shift out from under an in-progress removal.
  for (let i = node.outputs.length - 1; i >= 0; i--) {
    const out = node.outputs[i];
    if (!out) continue;
    const m = /^segment_(\d+)$/.exec(out.name || "");
    if (m && parseInt(m[1], 10) > want) {
      node.removeOutput(i);
    }
  }
  // Add any missing segment_* output up to `want`, in order.
  for (let i = 1; i <= want; i++) {
    const name = outputName(i);
    const exists = (node.outputs || []).some((o) => o && o.name === name);
    if (!exists) {
      node.addOutput(name, OUTPUT_TYPE);
    }
  }
  node.setDirtyCanvas?.(true, true);
}

app.registerExtension({
  name: "LCVision.Moviemaker",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if ((nodeData?.name || "") !== NODE_CLASS) return;

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated?.apply(this, arguments);
      const w = segmentsWidget(this);
      if (w) {
        const prev = w.callback;
        w.callback = (v, ...a) => {
          const o = prev?.apply(w, [v, ...a]);
          syncOutputs(this);
          return o;
        };
      }
      setTimeout(() => syncOutputs(this), 0);
      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (data) {
      const r = onConfigure?.apply(this, arguments);
      // Saved workflows restore the full MAX_SEGMENTS output set before this
      // runs; trim back to whatever `segments` was actually saved as.
      setTimeout(() => syncOutputs(this), 20);
      return r;
    };
  },
});
