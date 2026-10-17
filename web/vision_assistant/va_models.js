// Vision Assistant: the models this workflow uses. Present or missing, the size, and where to get each one on
// CivitAI: the exact page by the file's hash, or a name search for a file that is missing. Links saved in the workflow
// (📌) give whoever opens it the exact page for anything they are missing. Snapshots remember each file's size and
// hash, so applying one later says when a file has the same name but is not the same model any more.
// CivitAI is only contacted when the person presses a button: it gets the file's hash, never the file.
import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

const EXT = /\.(safetensors|ckpt|pt|pth|bin|gguf|sft)$/i;
const HINT = {
  ckpt_name: "checkpoints", unet_name: "diffusion_models", lora_name: "loras", vae_name: "vae", clip_name: "text_encoders",
  clip_name1: "text_encoders", clip_name2: "text_encoders", clip_name3: "text_encoders", clip_name4: "text_encoders",
  control_net_name: "controlnet", style_model_name: "style_models", upscale_model: "upscale_models", ipadapter_file: "ipadapter",
  model_patch: "model_patch", model_name: null, model_file: "diffusion_models", sam3_model: "sam3",
};
// some LC widgets add a label after the file name: "sam3.1_multiplex_fp16.safetensors (SAM 3.1, SAM License)"
const fileOf = (v) => (typeof v === "string" ? v.replace(/^(.+\.(?:safetensors|ckpt|pt|pth|bin|gguf|sft)) \(.*\)$/i, "$1") : v);
const SKIP_NODE = /LoadImage|LoadVideo|LoadAudio|SaveImage|Preview|VHS_/i;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const short = (n) => String(n).split(/[\\/]/).pop();
const gb = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`);

async function post(path, body) {
  const r = await api.fetchApi(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return r.json();
}

const root = () => app.rootGraph || app.graph;
const extra = () => {
  const g = root();
  g.extra = g.extra || {};
  g.extra.vision_assistant = g.extra.vision_assistant || { snapshots: [] };
  return g.extra.vision_assistant;
};
const pinned = () => extra().models || {};

/** Every model file the workflow points at: [{name, hint, where: ["Node › widget", ...]}], one row per file. */
export function collect() {
  const by = new Map();
  const add = (name, hint, where) => {
    if (!name || typeof name !== "string" || !EXT.test(name)) return;
    const row = by.get(name) || { name, hint, where: [] };
    row.where.push(where);
    by.set(name, row);
  };
  for (const n of root()?._nodes || []) {
    if (n.mode === 2 || n.mode === 4 || SKIP_NODE.test(n.type || "")) continue;
    const label = n.title || n.type;
    for (const w of n.widgets || []) {
      if (!w?.name) continue;
      if (w.name === "lora_rows" && typeof w.value === "string") { // LC LoRA Loader: the switched-on rows
        try {
          for (const r of JSON.parse(w.value)) if (r.on !== false && r.lora) add(r.lora, "loras", `${label} › LoRA`);
        } catch (_) {}
        continue;
      }
      const v = fileOf(w.value);
      if (typeof v === "string" && EXT.test(v)) add(v, HINT[w.name] ?? null, `${label} › ${w.label || w.name}`);
    }
  }
  return [...by.values()];
}

const state = { rows: null, busy: {}, found: {}, open: false, key: "" };

async function refresh() {
  const list = collect();
  const key = list.map((r) => r.name).join("|");
  if (state.rows && key === state.key) return state.rows;
  const res = await post("/lc_vision/assistant/models", { items: list.map((r) => ({ name: r.name, hint: r.hint })) });
  const info = new Map((res.items || []).map((x) => [x.name, x]));
  state.rows = list.map((r) => ({ ...r, ...(info.get(r.name) || {}) }));
  state.key = key;
  return state.rows;
}

async function lookup(row, toast) {
  const name = row.name;
  state.busy[name] = "hash";
  try {
    if (!row.exists) {
      const pin = pinned()[name];
      if (pin?.url) {
        state.found[name] = { exact: true, ...pin };
        return;
      }
      state.busy[name] = "search";
      const r = await post("/lc_vision/assistant/civitai", { query: name });
      if (r.error) return toast("error", "CivitAI", r.error);
      state.found[name] = { results: r.results || [] };
      return;
    }
    if (!row.sha256) {
      const h = await post("/lc_vision/assistant/model_hash", { name, hint: row.hint });
      if (h.error) return toast("error", "Couldn't read the file", h.error);
      row.sha256 = h.sha256;
    }
    state.busy[name] = "civitai";
    const r = await post("/lc_vision/assistant/civitai", { sha256: row.sha256 });
    if (r.error) return toast("error", "CivitAI", r.error);
    state.found[name] = r.match ? { exact: true, ...r.match } : { none: true };
  } finally {
    delete state.busy[name];
  }
}

/** 📌 Hash every model that is here, look each up on CivitAI, and keep the exact pages in the workflow. */
async function pinAll(toast, rerender) {
  const rows = (state.rows || []).filter((r) => r.exists);
  const models = { ...pinned() };
  let done = 0;
  for (const row of rows) {
    await lookup(row, toast);
    const f = state.found[row.name];
    models[row.name] = { sha256: row.sha256, size: row.size, ...(f?.exact ? { url: f.url, model: f.model, version: f.version } : {}) };
    done++;
    rerender();
  }
  extra().models = models;
  try {
    app.extensionManager?.workflow?.activeWorkflow?.changeTracker?.checkState?.();
  } catch (_) {}
  const linked = Object.values(models).filter((m) => m.url).length;
  toast("success", "Download links saved in this workflow", `${linked} of ${done} models have a CivitAI page. Save the workflow to keep them.`);
}

function rowHtml(r) {
  const busy = state.busy[r.name];
  const f = state.found[r.name];
  const pin = pinned()[r.name];
  let out = "";
  if (f?.exact) out = `<a class="va-link" href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.model)}${f.version ? ` · ${esc(f.version)}` : ""} on CivitAI ↗</a>`;
  else if (f?.none) out = `<span class="va-sub">Not on CivitAI (custom, private or a merge)</span>`;
  else if (f?.results) out = f.results.length ? `<div class="va-sub">By name, so check it is the right one:</div>${f.results.map((x) =>
    `<div><a class="va-link" href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.model)}</a> <span class="va-sub">${esc(x.type)}${x.base ? ` · ${esc(x.base)}` : ""}</span></div>`).join("")}`
    : `<span class="va-sub">Nothing on CivitAI by that name.</span>`;
  const btn = busy ? `<span class="va-sub">${busy === "hash" ? "Reading the file (big files take a moment)…" : "Asking CivitAI…"}</span>`
    : f ? "" : `<button class="va-btn" data-m="${esc(r.name)}" title="${r.exists ? "Finds the exact page by the file's hash (only the hash is sent)" : pin?.url ? "The workflow has the exact page saved" : "Searches CivitAI by the file name"}">${r.exists ? "Find on CivitAI" : pin?.url ? "Download page" : "Search CivitAI"}</button>`;
  return `<div class="va-row" style="align-items:flex-start">
    <div style="width:18px">${r.exists ? "✅" : "❌"}</div>
    <div class="va-grow" style="min-width:0">
      <div class="va-name" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(r.name)}">${esc(short(r.name))}</div>
      <div class="va-sub">${esc(r.folder || "")}${r.exists ? ` · ${gb(r.size)}` : " · not on this computer"}${r.moved ? ` · found in ${esc(r.moved)}` : ""} · ${esc(r.where[0])}${r.where.length > 1 ? ` +${r.where.length - 1}` : ""}</div>
      ${out}
    </div>${btn}</div>`;
}

/** Draws the panel into el (the Chat tab's slot under the checkup). */
export async function mount(el, { toast }) {
  if (!el) return;
  const draw = () => {
    if (!el.isConnected) return;
    const rows = state.rows || [];
    const miss = rows.filter((r) => !r.exists).length;
    el.innerHTML = `<div class="va-row" style="border-top:0;padding-top:4px">
        <button class="va-link va-grow" style="text-align:left" data-mt>${state.open ? "▾" : "▸"} Models in this workflow: ${rows.length}${miss ? `, <b style="color:#e77">${miss} missing</b>` : ""}</button>
        ${state.open && rows.some((r) => r.exists) ? `<button class="va-btn" data-mp title="Reads each model's hash and saves its exact CivitAI page in the workflow, so whoever opens it can download anything they are missing. Sends only the hashes to CivitAI.">📌 Save download links</button>` : ""}
      </div>
      ${state.open ? (rows.length ? rows.map(rowHtml).join("") : `<div class="va-hint">This workflow doesn't load any model files.</div>`) : ""}`;
    el.querySelector("[data-mt]").onclick = () => {
      state.open = !state.open;
      draw();
    };
    const pinBtn = el.querySelector("[data-mp]");
    if (pinBtn) pinBtn.onclick = () => pinAll(toast, draw).then(draw);
    el.querySelectorAll("[data-m]").forEach((b) => (b.onclick = async () => {
      const row = rows.find((r) => r.name === b.dataset.m);
      const p = lookup(row, toast);
      draw();
      await p;
      draw();
    }));
  };
  try {
    await refresh();
  } catch (_) {
    state.rows = [];
  }
  draw();
}

// ------------------------------------------------------------------ snapshots: same name, same file?
/** The model files a snapshot's settings point at: [{name, hint}] (LC LoRA Loader rows included). */
function snapFiles(snap) {
  const out = new Map();
  for (const it of snap.items || []) {
    if (it.name === "lora_rows" && typeof it.value === "string") {
      try {
        for (const r of JSON.parse(it.value)) if (r.on !== false && r.lora) out.set(r.lora, { name: r.lora, hint: "loras" });
      } catch (_) {}
      continue;
    }
    const v = fileOf(it.value);
    if (typeof v === "string" && EXT.test(v)) out.set(v, { name: v, hint: HINT[it.name] ?? null });
  }
  return [...out.values()];
}

/** Remember each model file's size (and hash) in the snapshot. Calls save() again once the hashes are read. */
export async function stamp(snap, save) {
  const items = snapFiles(snap);
  if (!items.length) return;
  const res = await post("/lc_vision/assistant/models", { items });
  snap.files = {};
  for (const r of res.items || []) if (r.exists) snap.files[r.name] = { size: r.size, sha256: r.sha256 || null };
  save();
  // hashes not read yet: read them in the background (once per file, cached), then save again
  let more = false;
  for (const it of items) {
    const f = snap.files[it.name];
    if (!f || f.sha256) continue;
    const h = await post("/lc_vision/assistant/model_hash", it);
    if (h.sha256) {
      f.sha256 = h.sha256;
      more = true;
    }
  }
  if (more) save();
}

/** Model files that changed since the snapshot was saved: [{name, why}]. */
export async function check(snap) {
  const files = snap.files || {};
  const names = Object.keys(files);
  if (!names.length) return [];
  const res = await post("/lc_vision/assistant/models", { items: names.map((name) => ({ name })) });
  const out = [];
  for (const r of res.items || []) {
    const was = files[r.name];
    if (!r.exists) continue; // missing files are already reported as skipped
    if (was.size && r.size !== was.size) out.push({ name: r.name, why: "a different size" });
    else if (was.sha256 && r.sha256 && r.sha256 !== was.sha256) out.push({ name: r.name, why: "different contents" });
  }
  return out;
}
