import { app } from "../../scripts/app.js";

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
