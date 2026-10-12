// LC Settings ⚙️ > Vision: the Vision Assistant switch, the default context size for new LC Vision Loaders, and
// which vision models are on disk (with a download button when there are none).
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const CAT = "LC Settings ⚙️";
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const CTX = ["4096", "8192", "16384", "32768"];

function modelsPanel() {
  const el = document.createElement("div");
  el.style.cssText = "display:flex;flex-direction:column;gap:8px;font-size:13px;max-width:560px;line-height:1.45";
  let poll = null;

  const draw = async () => {
    let d;
    try {
      d = await (await api.fetchApi("/lc_vision/models")).json();
    } catch (_) {
      el.innerHTML = `<div style="color:#e77">Couldn't read the model list. Restart ComfyUI.</div>`;
      return;
    }
    const st = await (await api.fetchApi("/lc_vision/download/status")).json().catch(() => ({}));
    const missing = d.curated.filter((c) => !c.have);
    const none = !d.installed.length;
    el.innerHTML = `
      ${none ? `<div style="border:1px solid #db5;border-radius:8px;padding:8px 10px">
        <b>⚠️ No vision model yet.</b> The LC Vision nodes and the Vision Assistant chat need one.
        <ol style="margin:6px 0 0 18px;padding:0">
          <li><b>Preferred:</b> pick one below and click <b>Download</b>. Progress shows here and in the console.</li>
          <li><b>By hand:</b> download the model <code>.gguf</code> <b>and</b> its <code>mmproj</code> <code>.gguf</code> from the Hugging Face page,
            then put both in the same folder anywhere under <code>ComfyUI/models/LLM/</code> (one folder per model is tidiest) and restart ComfyUI.</li>
        </ol></div>`
        : `<div><b>On disk (${d.installed.length}):</b></div>
        <ul style="margin:0 0 0 18px;padding:0">${d.installed.map((m) => `<li>${esc(m.name)} <span style="opacity:.6">(${m.gb} GB${m.arch ? `, ${esc(m.arch)}` : ""})</span></li>`).join("")}</ul>`}
      ${missing.length ? `<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        <select data-x="pick" class="p-inputtext p-component" style="flex:1;min-width:220px;padding:4px 6px" title="Models made for LC Vision. 4B is lighter, 8B / 9B describe better.">
          ${missing.map((c) => `<option value="${esc(c.key)}">${esc(c.label)}</option>`).join("")}</select>
        <button data-x="go" class="p-button p-component p-button-sm" type="button" ${st.active ? "disabled" : ""}>${st.active ? "Downloading…" : "Download"}</button>
        <a data-x="page" href="#" target="_blank" rel="noopener" style="font-size:12px">Hugging Face page ↗</a></div>` : `<div style="opacity:.7">Every LC Vision model is already on disk.</div>`}
      <div data-x="status" style="font-size:12px;opacity:.85"></div>
      <div style="font-size:12px;opacity:.6">Folder: ${esc(d.folder)}</div>`;
    const pick = el.querySelector('[data-x="pick"]');
    const page = el.querySelector('[data-x="page"]');
    const setPage = () => {
      const c = d.curated.find((x) => x.key === pick?.value);
      if (page && c) page.href = `https://huggingface.co/${c.repo}/tree/main`;
    };
    setPage();
    if (pick) pick.onchange = setPage;
    const go = el.querySelector('[data-x="go"]');
    if (go) go.onclick = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const r = await api.fetchApi("/lc_vision/download", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ label: pick.value }) });
      const j = await r.json();
      if (j.error) el.querySelector('[data-x="status"]').textContent = j.error;
      watch();
    };
    showStatus(st);
    if (st.active) watch();
  };

  const showStatus = (st) => {
    const box = el.querySelector('[data-x="status"]');
    if (!box) return;
    if (st.active) {
      const pct = st.total ? Math.min(100, Math.round((st.done / st.total) * 100)) : null;
      box.textContent = `Downloading ${st.file || "…"}${pct !== null ? `: ${pct}% of ${(st.total / 1024 ** 3).toFixed(2)} GB` : ` (${(st.done / 1024 ** 3).toFixed(2)} GB so far)`}. You can close Settings, it keeps going.`;
    } else if (st.error) box.textContent = `Download failed: ${st.error}`;
    else if (st.finished) box.textContent = "✓ Downloaded. Pick it in an LC Vision Loader (refresh with R if it isn't listed yet).";
  };

  const watch = () => {
    clearInterval(poll);
    poll = setInterval(async () => {
      if (!el.isConnected) return clearInterval(poll);
      const st = await (await api.fetchApi("/lc_vision/download/status")).json().catch(() => ({}));
      if (!st.active) {
        clearInterval(poll);
        return draw();
      }
      showStatus(st);
    }, 1000);
  };

  draw();
  return el;
}

app.registerExtension({
  name: "LCVision.Settings",
  settings: [
    {
      id: "LCVision.Assistant.Enabled",
      category: [CAT, "Vision", "Vision Assistant"],
      name: "Vision Assistant",
      type: "boolean",
      defaultValue: true,
      sortOrder: 50, // the section's highest sortOrder places it: 50 = after Align / Connections, before Notes (40)
      tooltip: "Shows the Vision Assistant in the left sidebar: snapshots, your library, the checkup and the chat. Off removes the tab and stops its checks.",
      onChange: (v) => window.LCVisionAssistant?.setEnabled?.(v !== false),
    },
    {
      id: "LCVision.Chat.Model",
      category: [CAT, "Vision", "Chat model"],
      name: "Vision Assistant chat model",
      defaultValue: "auto",
      sortOrder: 40,
      tooltip: "Auto picks the biggest model that fits your card and only loads it while you chat (it unloads a minute after the last answer, or when you queue):\n"
        + "20 GB+ cards: 8B Q8 at 16k context, about 10 GB. It can also build guided tours.\n"
        + "16 GB: 8B Q5 at 8k, about 7 GB.\n"
        + "12 GB: 4B Q8 at 8k, about 5 GB.\n"
        + "8 GB: 4B Q4 at 8k, about 3.5 GB.\n"
        + "Smaller: CPU chat, under 1 GB of VRAM, 10 to 30 seconds an answer.\n"
        + "The checkup, snapshots and saved tours never use VRAM.\n"
        + "Off = never load a chat model.",
      type: (name, setter, value) => {
        const sel = document.createElement("select");
        sel.className = "p-inputtext p-component";
        sel.style.cssText = "min-width:260px;padding:4px 6px";
        const fill = (models = [], plan = null) => {
          const cur = value || "auto";
          sel.innerHTML = `<option value="auto">Auto${plan?.name ? `: ${esc(plan.name)} · ${plan.ctx / 1024}k · ${plan.mode === "cpu" ? "CPU" : `~${plan.need_gb} GB`}` : ""}</option>`
            + models.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join("")
            + '<option value="off">Off: checkup only, no VRAM</option>';
          sel.value = [...sel.options].some((o) => o.value === cur) ? cur : "auto";
        };
        fill();
        api.fetchApi("/lc_vision/assistant/status?model=auto").then((r) => r.json()).then((j) => fill(j.models || [], j.plan)).catch(() => {});
        sel.onchange = () => {
          setter(sel.value);
          api.fetchApi("/lc_vision/assistant/unload", { method: "POST" }).catch(() => {});
        };
        return sel;
      },
    },
    {
      id: "LCVision.Loader.DefaultCtx",
      category: [CAT, "Vision", "Default n_ctx"],
      name: "Default n_ctx for new LC Vision Loaders",
      type: "combo",
      options: CTX,
      defaultValue: "8192",
      sortOrder: 20,
      tooltip: "How much a vision model can read and write at once. It is reserved up front, used or not, so smaller saves memory:\n"
        + "4096 = about 0.6 GB: one image and a short prompt (Danbooru Caption).\n"
        + "8192 = about 1.1 GB: Caption, Prompt Enhancer, a few reference images. The best pick for most people.\n"
        + "16384 = about 2.3 GB / 32768 = about 4.5 GB: Moviemaker with several references or video frames.\n"
        + "Only new loaders take it. Saved workflows keep their own value.",
    },
    {
      id: "LCVision.Models",
      category: [CAT, "Vision", "Vision models"],
      name: "Vision models",
      defaultValue: "",
      sortOrder: 10,
      tooltip: "The vision models LC Vision can use, and a download button for the ones made for it.",
      type: () => modelsPanel(),
    },
  ],
  nodeCreated(node) {
    // a loader from a saved workflow gets its saved value right after this, so only new ones keep the default
    if (node.comfyClass !== "LCVisionLoader") return;
    const v = app.extensionManager?.setting?.get?.("LCVision.Loader.DefaultCtx");
    const w = node.widgets?.find((x) => x.name === "n_ctx");
    if (w && v && CTX.includes(String(v))) w.value = String(v);
  },
});
