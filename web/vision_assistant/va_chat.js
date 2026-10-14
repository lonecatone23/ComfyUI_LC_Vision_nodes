// Vision Assistant chat: what the model is told about the open workflow, and how its proposed actions are
// checked, described and (after the user says yes) carried out.
import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import * as core from "./va_core.js";
import * as check from "./va_checkup.js";
import { highlight } from "./va_glow.js";

const BUDGET = 14000; // characters of workflow summary
const KEY_TYPES = /Loader|Sampler|Scheduler|Sigmas|Latent|AspectRatio|Lora|Seed|CLIPTextEncode|Positive|Negative|Guider|Upscale|Detailer|Inpaint|Save/i;
const MODE_IN = { on: 0, bypass: 4, bypassed: 4, mute: 2, muted: 2, off: 4 };

const nodes = () => app.graph?._nodes || [];
const short = (v) => (typeof v === "string" ? (v.length > 80 ? JSON.stringify(v.slice(0, 77) + "…") : JSON.stringify(v)) : JSON.stringify(v));
const optsOf = (w) => {
  const v = w.options?.values;
  const list = typeof v === "function" ? v() : v;
  return Array.isArray(list) ? list : null;
};

// ------------------------------------------------------------------ status, chat, unload
/** The chat model choice: LC Settings ⚙️ > Vision > Chat model ("auto", "off" or a model name). */
export const choice = () => app.extensionManager?.setting?.get?.("LCVision.Chat.Model") || "auto";

export async function status() {
  try {
    return await (await api.fetchApi(`/lc_vision/assistant/status?model=${encodeURIComponent(choice())}`)).json();
  } catch (_) {
    return { available: false, why: "LC Vision's chat routes didn't load. Restart ComfyUI." };
  }
}

export async function send(messages, context, model) {
  const r = await api.fetchApi("/lc_vision/assistant/chat", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, context, model: model || undefined }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j;
}

export const unload = () => api.fetchApi("/lc_vision/assistant/unload", { method: "POST" }).catch(() => {});

// ------------------------------------------------------------------ groups
export function groupNodes(g) {
  const [gx, gy, gw, gh] = g._bounding || [g.pos?.[0], g.pos?.[1], g.size?.[0], g.size?.[1]];
  return nodes().filter((n) => n.pos[0] >= gx && n.pos[1] >= gy && n.pos[0] < gx + gw && n.pos[1] < gy + gh);
}

// ------------------------------------------------------------------ what the model is told
const STOP = new Set(["the", "and", "base", "turbo", "lora", "file", "files", "version", "into", "only", "runs", "run", "model", "models", "node", "nodes", "set", "use", "switch", "change", "make", "with", "from", "this", "that", "every", "all", "what", "how", "why", "safetensors", "gguf"]);
const isFile = (o) => o && o.length && o.some((x) => /\.\w{2,12}$/.test(String(x)));
const isInput = (n, w) => /^(image|video|audio|upload|file)$/i.test(w.name) || /^Load(Image|Video|Audio)/.test(n.type);
const groupsOf = () => app.graph?._groups || [];
const groupId = (g) => `G${groupsOf().indexOf(g) + 1}`;

function nodeLine(n, full, words, inGroup) {
  const st = n.mode === 4 ? " [bypassed]" : n.mode === 2 ? " [muted]" : "";
  const head = `#${n.id} ${n.type}${core.nodeLabel(n) !== n.type ? ` "${core.nodeLabel(n)}"` : ""}${inGroup ? ` in ${inGroup}` : ""}${st}`;
  if (!full) return head;
  const ws = (n.widgets || []).filter((w) => w?.name && !/^[_$]/.test(w.name) && w.type !== "button" && w.value !== undefined && typeof w.value !== "object");
  const parts = ws.slice(0, 16).map((w) => {
    const o = optsOf(w);
    let opts = "";
    if (o && o.length && isInput(n, w)) opts = "";
    else if (isFile(o)) {
      // file lists are long: only the files that match what the user asked about
      const score = (x) => words.filter((wd) => String(x).toLowerCase().includes(wd)).length;
      const hits = o.filter((x) => score(x) > 0).sort((a, b) => score(b) - score(a)).slice(0, 12);
      opts = hits.length ? ` (matching files: ${hits.map((x) => String(x).split(/[\/]/).pop()).join(" | ")})` : "";
    } else if (o && o.length) opts = ` (options: ${o.slice(0, 30).join(" | ")}${o.length > 30 ? ` | …${o.length - 30} more` : ""})`;
    const v = typeof w.value === "string" && isFile(o) ? String(w.value).split(/[\/]/).pop() : w.value;
    const there = isFile(o) && typeof w.value === "string" && !isInput(n, w) ? (o.includes(w.value) ? " [file is on disk]" : " [file NOT on disk]") : "";
    return `${w.name}=${short(v)}${there}${opts}`;
  });
  return parts.length ? `${head}: ${parts.join("; ")}` : head;
}

/** A compact summary of the workflow. Nodes the user mentions, and the key ones, get their settings listed. */
// Support and social links live at the end of long notes, past the summary's cut: read them from every note's full text
const LINK_RX = /https?:\/\/(?:www\.)?(?:ko-fi\.com|patreon\.com|buymeacoffee\.com|instagram\.com|civitai\.com\/(?:user|u)\/|github\.com\/sponsors\/|youtube\.com\/@|x\.com|twitter\.com|discord\.gg|bilibili\.com\/video)[^\s)<>"\]]*/gi;
const noteNodes = () => nodes().filter((n) => /Note/i.test(n.type));
export const hasNotes = () => noteNodes().length > 0;

export function authorLinks() {
  return [...new Set(noteNodes().flatMap((n) => {
    const raw = (n.widgets || []).filter((x) => typeof x.value === "string").map((x) => x.value).join("\n") + " " + (n.properties?.text || "");
    return raw.match(LINK_RX) || [];
  }).map((u) => u.replace(/[).,]+$/, "")))].slice(0, 10);
}

/** The links people can pay through: [{site, href}] */
export function supportLinks() {
  const SITES = [[/ko-fi\.com/i, "Ko-fi"], [/patreon\.com/i, "Patreon"], [/buymeacoffee\.com/i, "Buy Me a Coffee"], [/github\.com\/sponsors/i, "GitHub Sponsors"]];
  return authorLinks().map((href) => ({ href, site: (SITES.find(([rx]) => rx.test(href)) || [])[1] })).filter((x) => x.site);
}

let lastCards = []; // the checkup the model saw, so "fix 3" means the same card

export async function context(question, cards) {
  lastCards = cards || [];
  const sys = await check.system();
  const q = String(question || "").toLowerCase();
  const words = q.split(/[^a-z0-9._-]+/).filter((w) => w.length > 2 && !STOP.has(w));
  const skip = (n) => /Note|Label|Reroute|Primitive$/i.test(n.type);
  const list = nodes().filter((n) => !skip(n));
  const where = new Map();
  const groups = groupsOf().map((g) => {
    const ns = groupNodes(g).filter((n) => !skip(n));
    ns.forEach((n) => where.set(n.id, groupId(g)));
    const off = ns.filter((n) => n.mode === 4 || n.mode === 2).length;
    return `${groupId(g)} "${g.title}" (${ns.length} nodes${off === ns.length && off ? ", all off" : off ? `, ${off} off` : ""})`;
  });
  const mentioned = (n) => {
    const t = core.nodeLabel(n).toLowerCase();
    return q.includes(`#${n.id}`) || (t.length > 2 && q.includes(t)) || words.some((w) => t.includes(w) || n.type.toLowerCase().includes(w));
  };
  const ranked = [...list].sort((a, b) => (mentioned(b) - mentioned(a)) || (KEY_TYPES.test(b.type) - KEY_TYPES.test(a.type)) || (a.id - b.id));
  const lines = [];
  let used = 0;
  for (const n of ranked) {
    const full = mentioned(n) || KEY_TYPES.test(n.type) || list.length <= 40;
    let l = nodeLine(n, full && used < BUDGET, words, where.get(n.id));
    if (used + l.length > BUDGET * 1.3) l = nodeLine(n, false, words, where.get(n.id));
    used += l.length;
    lines.push([n.id, l]);
  }
  lines.sort((a, b) => a[0] - b[0]);
  const sel = selected();
  // the workflow's own notes: the author's intro, links, how-to and credits live there
  const noteText = (n) => {
    const w = (n.widgets || []).filter((x) => typeof x.value === "string").sort((a, b) => b.value.length - a.value.length)[0];
    return String(w?.value || n.properties?.text || "").replace(/@\[card:\s*([^\]]*)\]\(([^)]*)\)/g, "$1 ($2)").replace(/<[^>]+>/g, "").replace(/\n{2,}/g, "\n").trim();
  };
  const authors = authorLinks();
  let noteBudget = 4500;
  // notes about what was asked first, then the ones with the author's links, then the rest
  const noteScore = (n) => {
    const t = `${core.nodeLabel(n)} ${noteText(n)}`.toLowerCase();
    return words.filter((w) => t.includes(w)).length * 2 + (/instagram|ko-fi|patreon|civitai\.com|github\.com|youtube|bilibili|my guide|made by|created by|author/.test(t) ? 3 : 0);
  };
  const notes = nodes().filter((n) => /Note/i.test(n.type)).map((n) => [noteScore(n), n]).sort((a, b) => b[0] - a[0]).map(([, n]) => n).map((n) => {
    const t = noteText(n).slice(0, Math.min(1200, noteBudget));
    noteBudget -= t.length;
    return t ? `[${core.nodeLabel(n)} #${n.id}]\n${t}` : "";
  }).filter(Boolean);
  const snaps = core.workflowSnaps().map((s) => `"${s.name}"`);
  const wf = app.extensionManager?.workflow?.activeWorkflow;
  const checkup = ["CHECKUP (use the number in a fix action):", ...(cards?.length ? cards.map((c, i) => {
    const fx = check.fixesOf(c);
    return `${i + 1}. ${c.level === 3 ? "problem" : c.level === 1 ? "tip" : "info"}: ${c.title}. ${String(c.text).replace(/\n/g, " ")}`
      + (fx.length ? ` [one-click fix: ${fx.map((a, j) => `option ${j}: ${a.label}${a.run?.add ? " (adds a stand-in node next to the broken one; it installs nothing)" : ""}`).join("; ")}]` : " [no fix I can do: the user has to install or download it]")
      + ((c.actions || []).filter((a) => a.href).map((a) => ` [link: ${a.href}]`).join(""));
  }) : ["- nothing found"])];
  // most important first: a small chat model gets a short window, and the end of this is what gets cut
  let symptoms = [];
  try {
    symptoms = await check.symptomReport(question);
  } catch (e) {
    console.warn("[Vision Assistant] symptom check failed", e);
  }
  return [
    `MACHINE: ${sys.gpu}, ${Math.round(sys.vram)} GB VRAM, ComfyUI ${sys.comfy || "?"}`,
    `WORKFLOW "${(wf?.filename || "untitled").replace(/\.json$/i, "")}": ${list.length} nodes`,
    ...symptoms,
    ...checkup,
    ...(sel.length ? [`SELECTED (what "this", "this node" or "these" means): ${sel.length} node${sel.length === 1 ? "" : "s"}`, ...sel.map(explainNode)] : ["SELECTED: nothing"]),
    ...(authors.length ? [`AUTHOR LINKS FOUND IN THE NOTES (support and social pages): ${authors.join(" | ")}`] : []),
    groups.length ? `GROUPS (use the G number in actions): ${groups.join(", ")}` : "",
    snaps.length ? `SNAPSHOTS: ${snaps.join(", ")}` : "",
    "NODES:", ...lines.map((x) => x[1]),
    ...(notes.length ? ["WORKFLOW NOTES (written by the workflow's author):", ...notes] : []),
  ].filter(Boolean).join("\n");
}

// ------------------------------------------------------------------ the selected node(s): "how does this work?"
export const selected = () => Object.values(app.canvas?.selected_nodes || {}).slice(0, 5);

function linkName(n, slot, dir) {
  const g = app.graph;
  if (dir === "in") {
    const l = g.links?.[n.inputs?.[slot]?.link] || g.links?.get?.(n.inputs?.[slot]?.link);
    const src = l && g.getNodeById(l.origin_id);
    return src ? `${core.nodeLabel(src)} #${src.id}` : "";
  }
  const ids = n.outputs?.[slot]?.links || [];
  return ids.map((id) => g.links?.[id] || g.links?.get?.(id)).filter(Boolean)
    .map((l) => g.getNodeById(l.target_id)).filter(Boolean).map((t) => `${core.nodeLabel(t)} #${t.id}`).slice(0, 4).join(", ");
}

/** Everything ComfyUI knows about a node: its description, each setting's tooltip, and what it is wired to. */
function explainNode(n) {
  const nd = LiteGraph.registered_node_types?.[n.type]?.nodeData || {};
  const tips = {};
  for (const sect of ["required", "optional"]) {
    for (const [name, spec] of Object.entries(nd.input?.[sect] || {})) {
      const t = Array.isArray(spec) ? spec[1]?.tooltip : null;
      if (t) tips[name] = String(t).slice(0, 300);
    }
  }
  const out = [`${nodeLine(n, true, [], null)}`];
  const desc = nd.description || n.constructor?.description;
  if (desc) out.push(`  what it does: ${String(desc).replace(/\s+/g, " ").slice(0, 700)}`);
  if (nd.python_module) out.push(`  from: ${String(nd.python_module).replace(/^custom_nodes\./, "")}`);
  for (const w of n.widgets || []) {
    if (tips[w.name] && !/^[_$]/.test(w.name)) out.push(`  ${w.name}: ${tips[w.name]}`);
  }
  (n.inputs || []).forEach((inp, i) => {
    const from = inp.link != null ? linkName(n, i, "in") : "";
    if (!from && (inp.widget || n.widgets?.some((w) => w.name === inp.name))) return; // a setting, already listed
    if (from || tips[inp.name]) out.push(`  input ${inp.name}${from ? ` ← ${from}` : " (not connected)"}${tips[inp.name] && !n.widgets?.some((w) => w.name === inp.name) ? `: ${tips[inp.name]}` : ""}`);
  });
  (n.outputs || []).forEach((o, i) => {
    const to = linkName(n, i, "out");
    out.push(`  output ${o.name}${to ? ` → ${to}` : " (not connected)"}`);
  });
  return out.join("\n");
}

// ------------------------------------------------------------------ proposed actions
function comboMatch(list, v) {
  if (!list) return { ok: true, value: v };
  if (list.includes(v)) return { ok: true, value: v };
  const s = String(v).toLowerCase();
  const hit = list.find((x) => String(x).toLowerCase() === s) || list.find((x) => String(x).split(/[\\/]/).pop().toLowerCase() === s);
  return hit !== undefined ? { ok: true, value: hit } : { ok: false };
}

/** Check one proposed action against the workflow. Returns {ok, text, run} or {ok:false, text}. */
export function vet(a) {
  const n = a.node != null ? check.nodeById(a.node) : null;
  const twins = n ? nodes().filter((x) => core.nodeLabel(x) === core.nodeLabel(n)).length : 0;
  const nl = n ? `${core.nodeLabel(n)}${twins > 1 ? ` #${n.id}` : ""}` : "";
  switch (a.do) {
    case "set": {
      if (!n) return { ok: false, text: `node #${a.node} isn't in this workflow` };
      const w = n.widgets?.find((x) => x.name === a.widget);
      if (!w) return { ok: false, text: `${nl} has no "${a.widget}"` };
      let v = a.value;
      if (typeof w.value === "number") v = Number(v);
      if (typeof w.value === "boolean") v = v === true || v === "true" || v === "on";
      if (typeof w.value === "number" && !Number.isFinite(v)) return { ok: false, text: `${nl} ${a.widget}: "${a.value}" isn't a number` };
      const m = comboMatch(optsOf(w), v);
      if (!m.ok) return { ok: false, text: `${nl} ${a.widget}: "${a.value}" isn't one of its options` };
      if (w.value === m.value) return { ok: false, text: `${nl} ${a.widget} is already ${core.fmt(m.value)}` };
      const short = (x) => (typeof x === "string" && /[\\/]/.test(x) ? x.split(/[\\/]/).pop() : core.fmt(x));
      const f = short(w.value) === short(m.value) ? core.fmt : short; // only the folder changes: show it
      return { ok: true, text: `${nl}: ${a.widget} ${f(w.value)} → ${f(m.value)}`, run: () => check.setWidget(n.id, w.name, m.value) };
    }
    case "mode": {
      if (!n) return { ok: false, text: `node #${a.node} isn't in this workflow` };
      const mode = MODE_IN[String(a.mode).toLowerCase()];
      if (mode === undefined) return { ok: false, text: `unknown state "${a.mode}"` };
      if (n.mode === mode) return { ok: false, text: `${nl} is already ${core.MODE_NAMES[mode]}` };
      return { ok: true, text: `${nl}: ${core.MODE_NAMES[n.mode] || "on"} → ${core.MODE_NAMES[mode]}`, run: () => { n.mode = mode; } };
    }
    case "group": {
      const gs = groupsOf();
      const key = String(a.group ?? "").trim();
      const byNum = /^G?\d+$/i.test(key) ? gs[Number(key.replace(/\D/g, "")) - 1] : null;
      const byTitle = gs.filter((x) => x.title.toLowerCase() === key.toLowerCase());
      const g = byNum || (byTitle.length === 1 ? byTitle[0] : null);
      const mode = MODE_IN[String(a.mode).toLowerCase()];
      if (!g) return { ok: false, text: byTitle.length > 1 ? `there are ${byTitle.length} groups called "${key}"` : `there's no group "${key}"` };
      if (mode === undefined) return { ok: false, text: `unknown state "${a.mode}"` };
      const ns = groupNodes(g);
      return { ok: true, text: `Group ${groupId(g)} "${g.title}" (${ns.length} nodes) → ${core.MODE_NAMES[mode]}`, run: () => ns.forEach((x) => (x.mode = mode)) };
    }
    case "snapshot": {
      const s = core.workflowSnaps().find((x) => x.name.toLowerCase() === String(a.name).toLowerCase());
      if (!s) return { ok: false, text: `there's no snapshot "${a.name}" in this workflow` };
      return { ok: true, text: `Apply snapshot "${s.name}" (${core.summary(s)})`, run: () => core.apply(s) };
    }
    case "show":
      if (!n) return { ok: false, text: `node #${a.node} isn't in this workflow` };
      return { ok: true, safe: true, auto: true, text: `Show ${nl}`, run: () => highlight([n]) };
    case "highlight": {
      const ids = [].concat(a.nodes ?? a.node ?? []);
      const ns = ids.map((id) => check.nodeById(id)).filter(Boolean);
      const gs = [].concat(a.groups ?? a.group ?? []).map((k) => {
        const key = String(k).trim();
        const all = groupsOf();
        return /^G?\d+$/i.test(key) ? all[Number(key.replace(/\D/g, "")) - 1] : all.find((x) => x.title.toLowerCase() === key.toLowerCase());
      }).filter(Boolean);
      if (!ns.length && !gs.length) return { ok: false, text: "nothing to point at" };
      const counts = new Map();
      [...ns.map((x) => core.nodeLabel(x)), ...gs.map((g) => `group "${g.title}"`)].forEach((t) => counts.set(t, (counts.get(t) || 0) + 1));
      const names = [...counts].map(([t, c]) => (c > 1 ? `${t} ×${c}` : t)); // two nodes with one title read once
      return { ok: true, safe: true, auto: true, text: `Show ${names.slice(0, 3).join(", ")}${names.length > 3 ? ` +${names.length - 3}` : ""}`, run: () => highlight(ns, gs) };
    }
    case "fix": {
      const c = lastCards[Number(a.card) - 1];
      if (!c) return { ok: false, text: `there's no checkup item ${a.card}` };
      const fx = check.fixesOf(c);
      const f = fx[Number(a.option) || 0];
      if (!f) return { ok: false, text: `"${c.title}" has no fix I can do: it needs installing or downloading` };
      return { ok: true, text: `${c.title}: ${f.label}`, run: () => check.runFix(f) };
    }
    case "suggest": {
      const t = String(a.text || "").trim().replace(/^["'“”‘’]+|["'“”‘’]+$/g, "");
      return t && t.length <= 80 ? { ok: true, suggest: true, text: t } : { ok: false, text: "" };
    }
    case "queue":
      return { ok: true, last: true, text: "Queue the workflow (run it once)", run: () => app.queuePrompt(0, 1) };
    default:
      return { ok: false, text: `unknown action "${a.do}"` };
  }
}

/** Do the vetted actions in order (queue last). Returns the state from before, for undo. */
export async function carryOut(vetted) {
  const before = core.capture();
  const list = [...vetted.filter((v) => v.ok && !v.last), ...vetted.filter((v) => v.ok && v.last)];
  for (const v of list) {
    if (v.last) app.graph.setDirtyCanvas(true, true);
    await v.run();
  }
  app.graph.setDirtyCanvas(true, true);
  try {
    app.extensionManager?.workflow?.activeWorkflow?.changeTracker?.checkState?.();
  } catch (_) {}
  return before;
}
