/**
 * LC Vision Storyboard Sheet: the storyboard on the node, like the Proof Sheet. A card for every picture the movie can
 * use (a face per cast member, a picture per place, an anchor per place with several people), read from the project.
 * ✅ Use puts the picture in the Reference Assembler, ↻ makes it again (new seed, only that picture), ✎ changes its
 * prompt. Follows the Showrunner's project; refreshes after every Storyboard Save.
 */
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { projectSource, save as saveProject } from "./lc_vision_project.js";

const NODE = "LCVisionStoryboardSheet";
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const nodesOf = (type) => (app.graph?._nodes || []).filter((n) => n.type === type);
const widget = (node, name) => node?.widgets?.find((w) => w.name === name);
const KIND = { face: "🙂 face", place: "📍 place", anchor: "🎬 anchor" };

function toast(detail, severity = "info") {
  try {
    app.extensionManager?.toast?.add({ severity, summary: "Storyboard", detail, life: 4500 });
  } catch (_e) {}
}

async function projectName() {
  const dir = nodesOf("LCVisionDirector")[0];
  return dir ? (await projectSource(dir)).name : "";
}

function ensureStyle() {
  if (document.getElementById("lc-sb-sheet-css")) return;
  const st = document.createElement("style");
  st.id = "lc-sb-sheet-css";
  st.textContent = `
  .lcsb{font:12px/1.35 system-ui,sans-serif;color:#ddd;display:flex;flex-direction:column;gap:6px;height:100%;box-sizing:border-box;padding:2px 2px 8px}
  .lcsb-top{display:flex;align-items:center;gap:8px}.lcsb-top b{color:#ffc850}.lcsb-top span{opacity:.7;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .lcsb button{background:#2a2a2a;color:#ddd;border:1px solid #444;border-radius:5px;padding:2px 8px;cursor:pointer;font-size:12px}
  .lcsb button:hover{background:#3a3a3a}
  .lcsb-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));grid-auto-rows:max-content;align-content:start;gap:8px;overflow:auto;flex:1;min-height:0}
  .lcsb-card{background:#181818;border:1px solid #333;border-radius:6px;overflow:hidden;display:flex;flex-direction:column}
  .lcsb-card.used{border-color:#3a7d44}
  .lcsb-pic{position:relative;background:#262626;aspect-ratio:16/9;display:flex;align-items:center;justify-content:center;color:#777}
  .lcsb-pic img{width:100%;height:100%;object-fit:contain}
  .lcsb-act{position:absolute;top:4px;right:4px;display:flex;gap:4px}.lcsb-act button{padding:0 6px;background:rgba(0,0,0,.6)}
  .lcsb-cap{padding:4px 6px}.lcsb-cap .h{color:#ffc850;font-weight:600}.lcsb-cap .s{opacity:.75}
  .lcsb-ed{padding:6px 7px;border-top:1px solid #333;display:flex;flex-direction:column;gap:5px}
  .lcsb-ed textarea{width:100%;min-height:90px;box-sizing:border-box;background:#111;color:#ddd;border:1px solid #444;border-radius:5px;font:12px system-ui;resize:vertical}`;
  document.head.appendChild(st);
}

// queue only the storyboard (its Save node), with the Builder set to make just these pictures
async function makePictures(node, only, everything) {
  const b = nodesOf("LCVisionStoryboardBuilder")[0], sv = nodesOf("LCVisionStoryboardSave")[0];
  if (!b || !sv) return toast("This workflow has no Storyboard Builder / Save.", "warn");
  if (b.mode !== 0 || sv.mode !== 0) return toast("Turn on Storyboard Bypass first (the storyboard group is off).", "warn");
  const ow = widget(b, "only"), mw = widget(b, "make");
  const keep = [ow?.value, mw?.value];
  if (ow) ow.value = only;
  if (mw) mw.value = everything ? "everything" : "missing only";
  try {
    // only the storyboard runs, not the movie: the Save node plus whatever shows its outputs (a Show Text on summary)
    const graph = app.graph;
    const after = (sv.outputs || []).flatMap((o) => (o.links || []).map((id) => graph.links?.[id] ?? graph.links?.get?.(id)))
      .filter(Boolean).map((l) => String(l.target_id));
    await app.queuePrompt(0, 1, [String(sv.id), ...new Set(after)]);
    toast(only ? `Making ${only} again.` : "Making the missing pictures.");
  } finally {
    if (ow) ow.value = keep[0];
    if (mw) mw.value = keep[1];
    app.graph.setDirtyCanvas(true, true);
  }
}

// ✅ Use: the picture goes into the Reference Assembler (replacing an earlier storyboard picture for the same thing)
async function usePicture(node, card) {
  const asm = nodesOf("LCH3ReferenceAssembler")[0];
  if (!asm) return toast("There is no LC H3 Reference Assembler in this workflow.", "warn");
  const w = widget(asm, "references");
  let data;
  try {
    data = JSON.parse(w.value || "{}");
  } catch (_e) {
    data = {};
  }
  const items = data.items || [];
  const same = (x) => x.role === card.role && String(x.name || "").trim().toLowerCase() === card.name.toLowerCase();
  if (items.some((x) => same(x) && !x.storyboard && x.on !== false)
      && !window.confirm(`The Reference Assembler already has your own ${card.role} picture for ${card.name}. Turn it off and use the storyboard picture?`)) return;
  const kept = items.filter((x) => !(same(x) && x.storyboard)).map((x) => (same(x) ? { ...x, on: false } : x));
  const it = card.item;
  kept.push({ id: it.id, kind: "image", file: it.file, on: true, role: card.role, name: card.name, note: it.note || "", crop: [0, 0, 1, 1], storyboard: true });
  w.value = JSON.stringify({ ...data, items: kept });
  asm.onConfigure?.({});
  app.graph.setDirtyCanvas(true, true);
  const dir = nodesOf("LCVisionDirector")[0];
  if (dir) await saveProject(dir, true); // the project file knows right away
  toast(`${card.name} (${card.role}) is in the Reference Assembler.`, "success");
  refresh(node);
}

async function refresh(node) {
  const box = node._lcsb;
  if (!box) return;
  const project = await projectName();
  box.title.textContent = project || "no project";
  if (!project) {
    box.grid.innerHTML = `<div style="opacity:.6">Set a project on LC Vision Showrunner.</div>`;
    return;
  }
  const d = await fetch(`/lc_vision/storyboard/status?project=${encodeURIComponent(project)}&t=${Date.now()}`, { cache: "no-store" })
    .then((x) => x.json()).catch(() => ({ error: "The storyboard routes are missing (update LC Vision)." }));
  if (!d || d.error) {
    box.info.textContent = "";
    box.grid.innerHTML = `<div style="opacity:.6">${esc(d?.error || "Nothing yet.")}</div>`;
    return;
  }
  // in use = in the Assembler on the canvas (or the project file)
  const asm = nodesOf("LCH3ReferenceAssembler")[0];
  let files = new Set();
  try {
    files = new Set((JSON.parse(widget(asm, "references")?.value || "{}").items || []).filter((x) => x.on !== false).map((x) => x.file));
  } catch (_e) {}
  const cards = d.cards || [];
  for (const c of cards) c.inUse = c.item ? files.has(c.item.file) || (!asm && c.used) : false;
  box.info.textContent = `${cards.filter((c) => c.item).length} of ${cards.length} made · ${cards.filter((c) => c.inUse).length} in use`;
  box.grid.innerHTML = cards.map((c, k) => `<div class="lcsb-card${c.inUse ? " used" : ""}" data-k="${k}" data-tour="picture: ${esc(c.kind)} · ${esc(c.name)}">
      <div class="lcsb-pic">${c.item ? `<img src="${esc(c.url)}" loading="lazy">` : "not made yet"}<div class="lcsb-act">
        ${c.item && !c.inUse ? `<button data-use="${k}" title="Put this picture in the Reference Assembler">✅ Use</button>` : ""}
        <button data-edit="${k}" title="Change this picture's prompt">✎</button>
        <button data-redo="${k}" title="${c.item ? "Make it again with a new seed (only this picture)" : "Make this picture"}">↻</button></div></div>
      <div class="lcsb-cap"><div class="h">${KIND[c.kind] || c.kind} · ${esc(c.name)}</div>
        <div class="s">${c.inUse ? "✅ in the Reference Assembler" : c.item ? "made, not in use" : c.own ? "you have your own picture" : "missing"}${c.custom ? " · ✎ your words" : ""}</div></div></div>`).join("");
  box.grid.querySelectorAll("[data-use]").forEach((b) => (b.onclick = () => usePicture(node, cards[+b.dataset.use])));
  box.grid.querySelectorAll("[data-redo]").forEach((b) => (b.onclick = async () => {
    const c = cards[+b.dataset.redo];
    // a made picture gets a new take: its seed moves on, even when the Builder's seed is wired from a fixed seed node
    if (c.item) {
      const project = await projectName();
      if (project) await fetch("/lc_vision/storyboard/retake", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project, kind: c.kind, name: c.name }) }).catch(() => {});
    }
    makePictures(node, `${c.kind}: ${c.name}`, true);
  }));
  box.grid.querySelectorAll("[data-edit]").forEach((b) => (b.onclick = () => {
    const c = cards[+b.dataset.edit];
    const card = b.closest(".lcsb-card");
    if (card.querySelector(".lcsb-ed")) return;
    const ed = document.createElement("div");
    ed.className = "lcsb-ed";
    ed.innerHTML = `<textarea spellcheck="true"></textarea>
      <div style="display:flex;gap:5px"><button data-a="save">Save</button><button data-a="redo">Save & make</button>
      ${c.custom ? `<button data-a="reset" title="Back to the prompt written from the Shot List">Reset</button>` : ""}<button data-a="x">Cancel</button></div>`;
    const ta = ed.querySelector("textarea");
    ta.value = c.prompt || "";
    ta.addEventListener("keydown", (e) => e.stopPropagation());
    card.appendChild(ed);
    ta.focus();
    const send = async (text, thenMake) => {
      const r = await fetch("/lc_vision/storyboard/prompt", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project, kind: c.kind, name: c.name, prompt: text }) }).then((x) => x.json()).catch((e) => ({ error: String(e) }));
      if (r.error) return toast(`Not saved: ${r.error}`, "warn");
      if (thenMake) await makePictures(node, `${c.kind}: ${c.name}`, true);
      refresh(node);
    };
    ed.querySelector('[data-a="save"]').onclick = () => send(ta.value, false);
    ed.querySelector('[data-a="redo"]').onclick = () => send(ta.value, true);
    const rs = ed.querySelector('[data-a="reset"]');
    if (rs) rs.onclick = () => send("", false);
    ed.querySelector('[data-a="x"]').onclick = () => ed.remove();
  }));
}

function build(node) {
  if (node._lcsb) return;
  ensureStyle();
  const root = document.createElement("div");
  root.className = "lcsb";
  root.innerHTML = `<div class="lcsb-top"><b></b><span></span>
    <button data-top="missing" data-tour="➕ Make missing" title="Make every picture the project doesn't have yet (only the storyboard runs)">➕ Make missing</button>
    <button data-top="refresh" title="Refresh">↻ Refresh</button></div><div class="lcsb-grid"></div>`;
  node._lcsb = { root, title: root.querySelector("b"), info: root.querySelector("span"), grid: root.querySelector(".lcsb-grid") };
  root.querySelector('[data-top="refresh"]').onclick = () => refresh(node);
  root.querySelector('[data-top="missing"]').onclick = () => makePictures(node, "", false);
  const w = node.addDOMWidget("lc_sb_sheet", "storyboard", root, { serialize: false, hideOnZoom: false, getMinHeight: () => 200, getValue: () => "", setValue() {} });
  Object.defineProperty(w, "width", { get: () => undefined, set: () => {}, configurable: true });
  root.addEventListener("mouseenter", async () => {
    if (node._lcsb.title.textContent !== ((await projectName()) || "no project")) refresh(node);
  });
  setTimeout(() => refresh(node), 300);
}

// a picture made for something the Reference Assembler has nothing for goes straight in (made but never ✅ Used, the
// lobby shots went out with no picture of the lobby). Anything already covered is left alone: ✅ Use swaps on purpose.
async function autoUse(detail) {
  const asm = nodesOf("LCH3ReferenceAssembler")[0];
  const items = detail?.items || [];
  if (!asm || !items.length || (detail.project && detail.project !== (await projectName()))) return;
  const w = widget(asm, "references");
  let data;
  try {
    data = JSON.parse(w.value || "{}");
  } catch (_e) {
    return;
  }
  const have = data.items || [];
  const added = [];
  for (const it of items) {
    const nm = String(it.name || "").trim().toLowerCase();
    if (!it.file || !it.role || have.some((x) => x.on !== false && x.role === it.role && String(x.name || "").trim().toLowerCase() === nm)) continue;
    have.push({ id: it.id, kind: "image", file: it.file, on: true, role: it.role, name: it.name, note: it.note || "", crop: [0, 0, 1, 1], storyboard: true });
    added.push(`${it.name} (${it.role})`);
  }
  if (!added.length) return;
  w.value = JSON.stringify({ ...data, items: have });
  asm.onConfigure?.({});
  app.graph.setDirtyCanvas(true, true);
  const dir = nodesOf("LCVisionDirector")[0];
  if (dir) await saveProject(dir, true); // the project file knows right away
  toast(`In the Reference Assembler now: ${added.join(", ")}.`, "success");
}

api.addEventListener("lc_storyboard_saved", async (e) => {
  try {
    await autoUse(e.detail);
  } catch (_e) {}
  for (const n of nodesOf(NODE)) setTimeout(() => refresh(n), 500);
});

// only (set by the Sheet's ↻ / Make missing) and style (free words, style_tag replaces it) stay on the node, hidden:
// same widget order, so saved workflows load as before
function hideInternal(node) {
  for (const name of ["only", "style"]) {
    const w = node.widgets?.find((x) => x.name === name);
    if (!w || w._lcHidden) continue;
    w._lcHidden = true;
    w.type = "hidden";
    w.computeSize = () => [0, -4];
    try {
      w.hidden = true;
    } catch (_) {}
    if (w.options) w.options.hidden = true;
    if (w.element) w.element.style.display = "none";
  }
  node.setSize?.([node.size[0], node.computeSize()[1]]);
}

// the Storyboard Builder: its project comes in on a socket; the name shows at the bottom, like on the Showrunner
function builderName(node) {
  if (node._lcsbName) return;
  const box = document.createElement("div");
  const el = document.createElement("div");
  el.style.cssText = "font:bold 14px system-ui;color:#ffc850;padding:6px 4px 10px;line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";
  // the last run's summary: what it made, which take, your ✎ words, what was already there
  const sum = document.createElement("div");
  sum.style.cssText = "font:12px ui-monospace,monospace;color:#ccc;padding:0 4px 6px;line-height:16px;white-space:pre-wrap;max-height:160px;overflow:auto";
  box.append(el, sum);
  node._lcsbName = el;
  node._lcsbSum = sum;
  const w = node.addDOMWidget("lc_sb_project", "project_name", box, { serialize: false, hideOnZoom: false, getValue: () => "", setValue() {} });
  w.computeSize = () => [node.size?.[0] || 300, 40 + (sum.textContent ? Math.min(160, sum.scrollHeight || 16 * (sum.textContent.split("\n").length)) + 6 : 0)];
  const show = async () => {
    const linked = node.inputs?.find((i) => i.name === "project_name")?.link != null;
    el.textContent = linked ? `🎬 ${(await projectName()) || "no project"}` : "🎬 wire the Showrunner's project_name output";
  };
  node._lcsbShow = show;
  // a node from a saved workflow keeps its old height: make room for the name line
  setTimeout(() => {
    const min = node.computeSize();
    if (node.size[1] < min[1]) node.setSize([node.size[0], min[1]]);
    node.setDirtyCanvas?.(true, true);
  }, 60);
  el.title = "The project this storyboard is for (from LC Vision Showrunner's project_name output)";
  setTimeout(show, 300);
}

window.addEventListener("lc-vision-project", () => {
  for (const n of nodesOf("LCVisionStoryboardBuilder")) n._lcsbShow?.();
});

app.registerExtension({
  name: "LC.Vision.StoryboardBuilder",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== "LCVisionStoryboardBuilder") return;
    const created = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = created?.apply(this, arguments);
      builderName(this);
      hideInternal(this);
      return r;
    };
    // a workflow saved when project was a typed field carries its value first: after loading, every setting sits one
    // place too far down. Straighten them (once) when base_model holds something that isn't a model
    const FAM = ["Krea 2", "Z-Image"];
    const RENAMED = { family: "base_model", wide_width: "landscape_width", wide_height: "landscape_height" };
    const onCfg = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onCfg?.apply(this, arguments);
      const ws = (this.widgets || []).filter((w) => w.name !== "lc_sb_project");
      if (ws.length > 2 && !FAM.includes(ws[0].value) && FAM.includes(ws[1].value)) {
        const vals = ws.map((w) => w.value).slice(1);
        ws.forEach((w, i) => {
          if (i < vals.length) w.value = vals[i];
        });
        const ctl = ws.find((w) => w.name === "control_after_generate");
        if (ctl && !ctl.options?.values?.includes(ctl.value)) ctl.value = "fixed";
      }
      // inputs renamed in 1.6.4: a saved workflow still carries the old socket names
      for (const inp of this.inputs || []) {
        const nu = RENAMED[inp.widget?.name];
        if (nu) {
          inp.name = nu;
          inp.widget.name = nu;
        }
      }
      hideInternal(this);
      return r;
    };
    const changed = nodeType.prototype.onConnectionsChange;
    nodeType.prototype.onConnectionsChange = function () {
      const r = changed?.apply(this, arguments);
      this._lcsbShow?.();
      return r;
    };
    const executed = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      const r = executed?.apply(this, arguments);
      const t = message?.text;
      if (this._lcsbSum && t) {
        this._lcsbSum.textContent = Array.isArray(t) ? t.join("\n") : String(t);
        requestAnimationFrame(() => {
          const min = this.computeSize();
          if (this.size[1] < min[1]) this.setSize([this.size[0], min[1]]);
          this.setDirtyCanvas?.(true, true);
        });
      }
      return r;
    };
  },
});

app.registerExtension({
  name: "LC.Vision.StoryboardSheet",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE) return;
    const created = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = created?.apply(this, arguments);
      build(this);
      if (!this.size || this.size[0] < 640) this.setSize([860, 560]);
      return r;
    };
    const cfg = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = cfg?.apply(this, arguments);
      build(this);
      return r;
    };
  },
});
