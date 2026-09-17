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

  // addOutput/removeOutput below trigger LiteGraph's own size recompute
  // as a side effect -- capture whatever size the node actually has right
  // now (a user's own resize, or a size just restored from a saved
  // workflow by the default onConfigure that ran before this) and put it
  // back afterward, so a segment-count change never silently resizes the
  // node out from under whatever was already there.
  const keepW = node.size ? node.size[0] : undefined;
  const keepH = node.size ? node.size[1] : undefined;

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

  if (keepW !== undefined && keepH !== undefined && node.size) {
    node.size[0] = keepW;
    node.size[1] = keepH;
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
      // That restore-to-20-outputs step inflates node.size via LiteGraph's
      // own addOutput side effect (more sockets need more height) before
      // syncOutputs gets a chance to run, so syncOutputs's own capture/
      // restore ends up locking in that inflated size instead of the real
      // saved one -- invisible when the saved size was already taller than
      // the 20-output minimum, but any size near the true (trimmed) minimum
      // gets silently bumped up. Re-assert the exact size from the raw
      // serialized data afterward so it always wins.
      const savedSize = data?.size ? [data.size[0], data.size[1]] : null;
      setTimeout(() => {
        syncOutputs(this);
        if (savedSize && this.size) {
          this.size[0] = savedSize[0];
          this.size[1] = savedSize[1];
          this.setDirtyCanvas?.(true, true);
        }
      }, 20);
      return r;
    };
  },
});
