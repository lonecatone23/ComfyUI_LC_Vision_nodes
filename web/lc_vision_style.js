/**
 * Pack-wide default launch color + width for every LC Vision node.
 * lc_vision_moviemaker.js handles its own dynamic-output-socket concern
 * separately -- this only ever touches color and the initial width.
 */
import { app } from "../../scripts/app.js";
import { lcApplyLaunchColor, lcRestoreSerializedColor } from "./lc_color.js";

const COLOR = "#465f5a";
const BGCOLOR = "#324b46";
const DEFAULT_WIDTH = 340;

// Moviemaker's multiline text widgets (story, custom_system_prompt) auto-grow
// to fill whatever height the node ends up with, so its natural/unconstrained
// launch size comes out much taller (~858px) than a normal LC Vision node --
// Caption and Prompt Enhancer's boxes stay compact by comparison. Forcing a
// launch height here matches how the node looks after manually resizing it
// smaller (confirmed 340x580 renders the text boxes at a normal, Caption-like
// size). Other node types get no entry here and keep their natural height.
const DEFAULT_HEIGHTS = {
  LCVisionMoviemaker: 580,
};

const TYPES = new Set([
  "LCVisionLoader",
  "LCVisionCaption",
  "LCVisionPromptEnhancer",
  "LCVisionMoviemaker",
]);

app.registerExtension({
  name: "LCVision.Style",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (!TYPES.has(nodeData?.name)) return;
    const defaultHeight = DEFAULT_HEIGHTS[nodeData.name];

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);
      lcApplyLaunchColor(this, COLOR, BGCOLOR);
      // Default width/height only when brand-new (not restored from a saved
      // workflow) -- same _lcVisionSized-guard idea as lc_show_text.js.
      if (!this._lcVisionSized) {
        this._lcVisionSized = true;
        const applySize = () => {
          if (!this.size) return;
          this.size[0] = DEFAULT_WIDTH;
          if (defaultHeight !== undefined) {
            this.size[1] = defaultHeight;
          }
          this.setDirtyCanvas?.(true, true);
        };
        applySize();
        // ComfyUI's own "add node" search dialog (sidebar library and the
        // canvas double-click search alike) re-assigns the newly-inserted
        // node's size from its own preview render right after this hook
        // returns -- for Moviemaker that preview reflects the full,
        // untrimmed 20-output definition, overwriting the 580 set above
        // with ~840+ in the same synchronous call. A plain LiteGraph.
        // createNode() + graph.add() call (no search dialog involved)
        // never does this and keeps 580 as-is. Re-applying once more on
        // the next tick wins regardless of which path created the node --
        // UNLESS a saved workflow's onConfigure ran in between (it runs
        // synchronously, in the same tick, right after onNodeCreated),
        // which means this node was restored, not freshly created, and
        // its real saved size must never be overwritten.
        setTimeout(() => {
          if (this._lcVisionConfigured) return;
          applySize();
        }, 0);
      }
      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function (data) {
      const r = onConfigure?.apply(this, arguments);
      if (!lcRestoreSerializedColor(this, data)) {
        lcApplyLaunchColor(this, COLOR, BGCOLOR);
      }
      this._lcVisionSized = true;
      this._lcVisionConfigured = true;
      return r;
    };
  },
});
