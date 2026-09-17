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

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);
      lcApplyLaunchColor(this, COLOR, BGCOLOR);
      // Default width only when brand-new (not restored from a saved
      // workflow) -- same _lcVisionSized-guard idea as lc_show_text.js.
      if (!this._lcVisionSized) {
        this._lcVisionSized = true;
        if (this.size) {
          this.size[0] = DEFAULT_WIDTH;
        }
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
      return r;
    };
  },
});
