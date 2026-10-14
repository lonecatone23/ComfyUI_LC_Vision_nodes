// Vision Assistant core: read the open workflow's settings, compare them with a baseline, and save / apply snapshots.
// A snapshot holds only settings (widget values) and node states (on / bypass / mute), never the wiring.
// Workflow snapshots live in graph.extra.vision_assistant (they travel with the workflow); library snapshots live in
// user/default/vision_assistant/library.json and match nodes by type, so they apply to any workflow.
import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

const LIB_PATH = "vision_assistant/library.json";
const MAX_STRING = 20000; // bigger values (embedded images, caches) are not settings
const SKIP_TYPES = new Set(["LCNote", "Note", "MarkdownNote", "LCLabel", "Label (rgthree)", "LCImageLabel", "Reroute",
  "PrimitiveNode", "LCShowText", "LCShowAny", "ShowText|pysssss", "PreviewAny", "Display Any (rgthree)"]);
const IMAGE_TYPES = /^(LoadImage|LoadImageMask|LoadImageOutput|LoadVideo|LoadAudio|VHS_Load|LC Load Audio|LCLoadAudio|Image Load)/i;
export const MODE_NAMES = { 0: "on", 2: "muted", 4: "bypassed" };

export const nodesOf = (graph = app.graph) => (graph?._nodes || graph?.nodes || []);
export const nodeLabel = (n) => (n.title && n.title !== n.type ? n.title : (n.constructor?.title || n.type));

// ------------------------------------------------------------------ capture and compare
function plain(v) {
  if (v === undefined || typeof v === "function") return undefined;
  if (typeof v === "string") return v.length > MAX_STRING ? undefined : v;
  if (v === null || typeof v !== "object") return v;
  try {
    const s = JSON.stringify(v);
    return s.length > MAX_STRING ? undefined : JSON.parse(s);
  } catch (_) {
    return undefined;
  }
}

function widgetsOf(n) {
  return (n.widgets || []).filter((w) => w?.name && w.type !== "button" && w.options?.serialize !== false && w.serialize !== false);
}

/** Every node's settings and state, keyed by node id. */
export function capture(graph = app.graph) {
  const out = {};
  for (const n of nodesOf(graph)) {
    if (SKIP_TYPES.has(n.type)) continue;
    const w = {};
    for (const wd of widgetsOf(n)) {
      const v = plain(wd.value);
      if (v !== undefined) w[wd.name] = v;
    }
    out[n.id] = { id: n.id, type: n.type, title: nodeLabel(n), mode: n.mode ?? 0, w };
  }
  return out;
}

const same = (a, b) => (typeof a === "object" || typeof b === "object" ? JSON.stringify(a) === JSON.stringify(b) : a === b);

/** Why a setting is left out by default (prompt, seed, input image), or "" when it goes in. */
export function defaultOff(node, name, value) {
  const t = node.type || "";
  if (/seed/i.test(name) || name === "control_after_generate" || /^LCSeed|Seed \(rgthree\)/.test(t)) return "seed";
  if (IMAGE_TYPES.test(t) || /^(image|video|audio|upload|file)$/i.test(name)) return "input";
  const n = app.graph && nodesOf().find((x) => String(x.id) === String(node.id));
  const wd = n?.widgets?.find((w) => w.name === name);
  if (typeof value === "string" && (wd?.options?.multiline || wd?.type === "customtext" ||
      /prompt|positive|negative|caption|^text$|^string$/i.test(name))) return "prompt";
  return "";
}

/** What changed from base to cur: one item per changed setting or node state. */
export function diff(base, cur, { all = false } = {}) {
  const items = [];
  for (const c of Object.values(cur)) {
    const b = base?.[c.id];
    const fresh = !b || b.type !== c.type;
    if (all || fresh || b.mode !== c.mode) {
      if (all || !fresh) items.push({ key: keyOf(c), kind: "mode", from: fresh ? undefined : b.mode, value: c.mode, changed: !fresh && b.mode !== c.mode });
    }
    for (const [name, v] of Object.entries(c.w)) {
      const was = fresh ? undefined : b.w[name];
      const changed = !fresh && !same(was, v);
      if (changed || all) items.push({ key: keyOf(c), kind: "widget", name, from: was, value: v, changed, off: defaultOff(c, name, v) });
    }
  }
  return items;
}

export const keyOf = (c) => ({ id: c.id, type: c.type, title: c.title });

// ------------------------------------------------------------------ apply
function candidates(key, graph, library) {
  const all = nodesOf(graph).filter((n) => n.type === key.type);
  if (!library) {
    const byId = all.find((n) => String(n.id) === String(key.id));
    if (byId) return [byId];
    const byTitle = all.filter((n) => nodeLabel(n) === key.title);
    if (byTitle.length) return byTitle.slice(0, 1);
    return [];
  }
  const byTitle = all.filter((n) => nodeLabel(n) === key.title);
  return byTitle.length === 1 ? byTitle : all;
}

/** How much of a library snapshot can land in this workflow: {ok, total, miss: [text]} */
export function fitOf(snap, graph = app.graph) {
  let ok = 0;
  const miss = [];
  for (const it of snap.items || []) {
    const c = candidates(it.key, graph, true);
    const fine = c.length && (it.kind === "mode" || c.some((n) => n.widgets?.some((w) => w.name === it.name)));
    if (fine) ok++;
    else miss.push(it.kind === "mode" ? `${it.key.title} (on / off)` : `${it.key.title}: ${it.name}`);
  }
  return { ok, total: (snap.items || []).length, miss: [...new Set(miss)] };
}

/** Nodes a library snapshot can't place on its own: [{key, options:[node]}]. */
export function ambiguous(snap, graph = app.graph) {
  const seen = new Map();
  for (const it of snap.items) {
    const k = `${it.key.type}|${it.key.title}|${it.key.id}`;
    if (seen.has(k)) continue;
    const c = candidates(it.key, graph, true);
    if (c.length > 1) seen.set(k, { key: it.key, options: c });
  }
  return [...seen.values()];
}

function comboAllows(wd, v) {
  const vals = wd?.options?.values;
  const list = typeof vals === "function" ? vals() : vals;
  return !Array.isArray(list) || !list.length || list.includes(v);
}

/**
 * Apply a snapshot. picks: {"type|title|id": [nodeId, ...]} for library nodes the user placed by hand.
 * Returns {changed, skipped: [text], before} (before = the state to undo to).
 */
export function apply(snap, { library = false, picks = {} } = {}, graph = app.graph) {
  const before = capture(graph);
  let changed = 0;
  const skipped = [];
  for (const it of snap.items) {
    const k = `${it.key.type}|${it.key.title}|${it.key.id}`;
    let targets = picks[k] ? picks[k].map((id) => nodesOf(graph).find((n) => String(n.id) === String(id))).filter(Boolean) : candidates(it.key, graph, library);
    if (library && !picks[k] && targets.length > 1) targets = []; // should have been placed by ambiguous()
    if (!targets.length) {
      skipped.push(`${it.key.title}: not in this workflow`);
      continue;
    }
    for (const n of targets) {
      if (it.kind === "mode") {
        if (n.mode !== it.value) {
          n.mode = it.value;
          changed++;
        }
        continue;
      }
      const wd = n.widgets?.find((w) => w.name === it.name);
      if (!wd) {
        skipped.push(`${nodeLabel(n)}: has no "${it.name}"`);
        continue;
      }
      if (!comboAllows(wd, it.value)) {
        skipped.push(`${nodeLabel(n)}: ${it.name} "${it.value}" is not on this computer`);
        continue;
      }
      if (!same(wd.value, it.value)) {
        wd.value = plain(it.value);
        try {
          wd.callback?.(wd.value, app.canvas, n);
        } catch (_) {}
        changed++;
      }
    }
  }
  touch(graph);
  return { changed, skipped: [...new Set(skipped)], before };
}

/** Put a captured state back (one step undo). */
export function restore(state, graph = app.graph) {
  for (const n of nodesOf(graph)) {
    const s = state[n.id];
    if (!s || s.type !== n.type) continue;
    n.mode = s.mode;
    for (const wd of widgetsOf(n)) {
      if (wd.name in s.w && !same(wd.value, s.w[wd.name])) {
        wd.value = plain(s.w[wd.name]);
        try {
          wd.callback?.(wd.value, app.canvas, n);
        } catch (_) {}
      }
    }
  }
  touch(graph);
}

function touch(graph) {
  graph.setDirtyCanvas?.(true, true);
  try {
    app.extensionManager?.workflow?.activeWorkflow?.changeTracker?.checkState?.();
  } catch (_) {}
}

// ------------------------------------------------------------------ storage
export function workflowSnaps(graph = app.graph) {
  graph.extra = graph.extra || {};
  graph.extra.vision_assistant = graph.extra.vision_assistant || { snapshots: [] };
  return graph.extra.vision_assistant.snapshots || []; // a workflow can carry a tour and no snapshots
}

export function saveWorkflowSnaps(list, graph = app.graph) {
  workflowSnaps(graph);
  graph.extra.vision_assistant.snapshots = list;
  touch(graph);
}

export async function loadLibrary() {
  try {
    const r = await api.fetchApi(`/userdata/${encodeURIComponent(LIB_PATH)}`);
    if (r.status !== 200) return [];
    const j = await r.json();
    return Array.isArray(j?.snapshots) ? j.snapshots : [];
  } catch (_) {
    return [];
  }
}

export async function saveLibrary(list) {
  const r = await api.fetchApi(`/userdata/${encodeURIComponent(LIB_PATH)}?overwrite=true`, {
    method: "POST",
    body: JSON.stringify({ version: 1, snapshots: list }, null, 1),
    headers: { "Content-Type": "application/json" },
  });
  if (r.status !== 200) throw new Error(`Could not save the library (${r.status})`);
}

/** "9 settings, 2 nodes off" */
export function summary(snap) {
  const w = snap.items.filter((i) => i.kind === "widget").length;
  const m = snap.items.filter((i) => i.kind === "mode");
  const off = m.filter((i) => i.value !== 0).length;
  const on = m.length - off;
  const parts = [];
  if (w) parts.push(`${w} setting${w === 1 ? "" : "s"}`);
  if (off) parts.push(`${off} node${off === 1 ? "" : "s"} off`);
  if (on) parts.push(`${on} node${on === 1 ? "" : "s"} on`);
  return parts.join(", ") || "empty";
}

export const fmt = (v) => {
  if (v === undefined) return "";
  if (typeof v === "string") return v.length > 40 ? v.slice(0, 37) + "…" : v.split(/[\\/]/).pop();
  if (typeof v === "number") return String(Math.round(v * 1000) / 1000);
  if (typeof v === "boolean") return v ? "on" : "off";
  return JSON.stringify(v).slice(0, 40);
};
