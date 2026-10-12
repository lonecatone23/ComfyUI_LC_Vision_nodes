// Vision Assistant guided tour: the workflow's parts in reading order, each with a short explanation and the settings
// that matter. A card floats on the canvas next to the part, the part stays lit, and its settings get numbered markers.
// A tour can be saved inside the workflow (graph.extra.vision_assistant.tour); a saved tour plays without the model.
import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import * as core from "./va_core.js";
import * as chat from "./va_chat.js";
import { highlight, clearGlow, boxOf } from "./va_glow.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const nodes = () => app.graph?._nodes || [];
const isNote = (n) => /Note|Label|Reroute|Primitive$/i.test(n.type);
const groupsOf = () => app.graph?._groups || [];
const byId = (id) => nodes().find((n) => String(n.id) === String(id));
const CARD_W = 320;
const unesc = (t) => String(t ?? "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

// ------------------------------------------------------------------ the parts, in reading order
function inGroup(n, g) {
  const [x, y, w, h] = g._bounding || [g.pos[0], g.pos[1], g.size[0], g.size[1]];
  return n.pos[0] >= x && n.pos[1] >= y && n.pos[0] < x + w && n.pos[1] < y + h;
}

/** [{id: "P1", label, group, nodes}] from the groups (smallest group a node sits in wins), else from columns of nodes. */
export function parts() {
  const list = nodes().filter((n) => !isNote(n));
  const gs = groupsOf().map((g) => ({ g, area: (g.size?.[0] || 0) * (g.size?.[1] || 0), nodes: [] }));
  const loose = [];
  for (const n of list) {
    const homes = gs.filter((x) => inGroup(n, x.g)).sort((a, b) => a.area - b.area);
    if (homes.length) homes[0].nodes.push(n);
    else loose.push(n);
  }
  let out = gs.filter((x) => x.nodes.length).map((x) => ({ label: x.g.title, group: x.g, nodes: x.nodes }));
  // reading order: rows of groups top to bottom (a row = tops within 300 px), left to right inside a row
  out.sort((a, b) => a.group.pos[1] - b.group.pos[1]);
  const rows = [];
  for (const p of out) {
    const row = rows.find((r) => Math.abs(r[0].group.pos[1] - p.group.pos[1]) < 300);
    if (row) row.push(p);
    else rows.push([p]);
  }
  out = rows.flatMap((r) => r.sort((a, b) => a.group.pos[0] - b.group.pos[0]));
  if (!out.length && loose.length) {
    // no groups: split the nodes into columns where there's a clear gap, at most 8 parts
    const sorted = [...loose].sort((a, b) => a.pos[0] - b.pos[0]);
    let cols = [[sorted[0]]];
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      if (sorted[i].pos[0] - (prev.pos[0] + prev.size[0]) > 120) cols.push([]);
      cols[cols.length - 1].push(sorted[i]);
    }
    while (cols.length > 8) {
      let k = 0;
      for (let i = 1; i < cols.length - 1; i++) if (cols[i].length + cols[i + 1].length < cols[k].length + cols[k + 1].length) k = i;
      cols.splice(k, 2, [...cols[k], ...cols[k + 1]]);
    }
    out = cols.map((c, i) => ({ label: `Column ${i + 1}`, group: null, nodes: c }));
  } else if (loose.length) {
    out.push({ label: "Outside the groups", group: null, nodes: loose });
  }
  return chapters(out).map((p, i) => ({ ...p, id: `P${i + 1}` }));
}

const MAX_STEPS = 16;
const useful = (p) => p.nodes.filter((n) => !PLUMBING.test(n.type));
// groups people name for what they are: wiring and helpers, not something to explain
const PLUMB_LABEL = /get ?sets?|noodle|plumbing|wiring|bypass|switch|reroute|relay/i;
// "Image Group 3" and "Image Group 4", "Anypaint" and "# Anypaint 🖌️": the same kind of part
const kind = (label) => String(label).toLowerCase().replace(/[^a-z ]+/g, " ").replace(/\b(group|lc|the|and|w|s)\b/g, " ").replace(/\s+/g, " ").trim();

/** Parts become tour chapters: plumbing out, siblings together, tiny parts into a neighbour, at most MAX_STEPS. */
function chapters(list) {
  let out = list.filter((p) => useful(p).length && !PLUMB_LABEL.test(p.label))
    .map((p) => ({ label: p.label, groups: p.group ? [p.group] : [], nodes: [...p.nodes] }));
  const size = (p) => useful(p).length;
  const merge = (a, b) => ({ label: kind(a.label) === kind(b.label) ? a.label : `${a.label} + ${b.label}`, groups: [...a.groups, ...b.groups], nodes: [...a.nodes, ...b.nodes] });
  for (let i = out.length - 1; i > 0; i--) {
    if (kind(out[i].label) && kind(out[i].label) === kind(out[i - 1].label)) out.splice(i - 1, 2, merge(out[i - 1], out[i]));
  }
  // a part with one or two real nodes joins whichever neighbour is smaller
  for (let i = 0; i < out.length && out.length > 1; i++) {
    if (size(out[i]) > 2) continue;
    const left = i > 0 ? i - 1 : -1, right = i < out.length - 1 ? i + 1 : -1;
    const j = left < 0 ? right : right < 0 ? left : size(out[left]) <= size(out[right]) ? left : right;
    const [a, b] = j < i ? [j, i] : [i, j];
    out.splice(a, 2, merge(out[a], out[b]));
    i = Math.max(-1, a - 1);
  }
  while (out.length > MAX_STEPS) {
    let k = 0;
    for (let i = 1; i < out.length - 1; i++) if (size(out[i]) + size(out[i + 1]) < size(out[k]) + size(out[k + 1])) k = i;
    out.splice(k, 2, merge(out[k], out[k + 1]));
  }
  return out;
}

// Plumbing a beginner never touches: wiring helpers, switches, constants, logic
const PLUMBING = /^(SetNode|GetNode|Reroute|Primitive|PrimitiveNode|LCAnySwitch|LCInvertBoolean|LogicGate|CM_|Constant|INTConstant|FloatConstant|Display|ShowText|PreviewAny|LCShowAny|LCShowText|LCBypassRelay)|Switch|Bypass|Relay|Bool|Compare/i;
const BUDGET = 14000; // characters for all parts together

/** A compact list of the parts for the model: the nodes that matter and the settings people change. */
export function partsText(ps) {
  const per = Math.max(220, Math.floor(BUDGET / Math.max(1, ps.length)));
  const show = (w) => w?.name && !/^[_$]|^UNKNOWN/i.test(w.name) && w.type !== "button" && typeof w.value !== "object" && w.value !== undefined
    && !(typeof w.value === "string" && w.value.length > 120 && !/\.\w{2,5}$/.test(w.value));
  const line = (n) => {
    const ws = (n.widgets || []).filter(show).slice(0, 6);
    const st = n.mode === 4 ? " [bypassed]" : n.mode === 2 ? " [muted]" : "";
    const val = (v) => JSON.stringify(typeof v === "string" ? v.split(/[\/]/).pop().slice(0, 30) : typeof v === "number" ? Math.round(v * 1000) / 1000 : v);
    return `  #${n.id} "${core.nodeLabel(n)}"${st}${ws.length ? ": " + ws.map((w) => `${w.name}=${val(w.value)}`).join("; ") : ""}`;
  };
  return ps.map((p) => {
    const useful = p.nodes.filter((n) => !PLUMBING.test(n.type)).sort((a, b) => (b.widgets?.length || 0) - (a.widgets?.length || 0));
    if (!useful.length) return ""; // plumbing only: not part of the tour
    let out = `${p.id} ${p.groups.length ? `(group${p.groups.length > 1 ? "s" : ""} "${p.groups.map((g) => g.title).join('", "')}")` : `(${p.label})`}:`;
    for (const n of useful) {
      const l = line(n);
      if (out.length + l.length > per) {
        out += `\n  …${useful.length - useful.indexOf(n)} more nodes`;
        break;
      }
      out += "\n" + l;
    }
    return out;
  }).filter(Boolean).join("\n");
}

// ------------------------------------------------------------------ build, check, save
/** Ask the model for a tour of the open workflow. Returns a checked tour. */
export async function build(model) {
  const ps = parts();
  if (!ps.length) throw new Error("This workflow has nothing to tour yet.");
  const ctx = await chat.context("explain the workflow, its notes and its parts", []);
  const r = await api.fetchApi("/lc_vision/assistant/tour", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parts: partsText(ps), context: ctx, model: model || undefined }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  const steps = [];
  for (const st of j.tour?.steps || []) {
    const ids = [].concat(st.parts ?? st.part ?? []).map((x) => String(x).trim().toUpperCase());
    const mine = ids.map((id) => ps.find((x) => x.id === id)).filter(Boolean);
    if (!mine.length || /plumbing|wiring/i.test(st.title || "")) continue;
    const step = {
      title: unesc(st.title || mine[0].label).slice(0, 80), text: unesc(st.text).slice(0, 600),
      groups: mine.flatMap((p) => p.groups).map((g) => ({ title: g.title, index: groupsOf().indexOf(g) })),
      nodes: mine.flatMap((p) => p.nodes.map((n) => n.id)),
      settings: (st.settings || []).slice(0, 3).map((x) => ({ node: String(x.node ?? "").replace(/^#/, "").trim(), widget: String(x.widget || "").trim(), why: unesc(x.why).slice(0, 120) })),
    };
    const prev = steps[steps.length - 1];
    if (prev && (prev.title === step.title || prev.text === step.text)) { // the same step for neighbouring parts: one step
      prev.groups.push(...step.groups);
      prev.nodes.push(...step.nodes);
      continue;
    }
    steps.push(step);
  }
  const tour = check({ title: unesc(j.tour?.title || "How this workflow works").slice(0, 80), steps, source: "model" });
  if (!tour.steps.length) throw new Error("The tour came out empty. Try again.");
  return tour;
}

/** Drop anything that no longer exists (nodes, settings), so an old saved tour still plays. */
export function check(tour) {
  const steps = (tour.steps || []).map((s) => {
    const ns = (s.nodes || []).map(byId).filter(Boolean);
    if (!ns.length && !stepGroups(s).length) return null;
    // the model may write "#12" or a setting's label: match loosely, keep the real names
    const settings = (s.settings || []).map((x) => {
      const n = byId(String(x.node).replace(/^#/, ""));
      const want = String(x.widget || "").toLowerCase();
      const w = n?.widgets?.find((y) => y.name?.toLowerCase() === want || String(y.label || "").toLowerCase() === want);
      return w ? { ...x, node: n.id, widget: w.name } : null;
    }).filter(Boolean);
    return { ...s, settings };
  }).filter(Boolean);
  return { ...tour, steps };
}

const extra = () => {
  const g = app.graph;
  g.extra = g.extra || {};
  g.extra.vision_assistant = g.extra.vision_assistant || { snapshots: [] };
  return g.extra.vision_assistant;
};
export const saved = () => (extra().tour ? check(extra().tour) : null);

function touch() {
  app.graph.setDirtyCanvas?.(true, true);
  try {
    app.extensionManager?.workflow?.activeWorkflow?.changeTracker?.checkState?.();
  } catch (_) {}
}

/** A saved tour is locked: nothing can replace, edit or delete it until it is unlocked on purpose. */
export const isLocked = () => extra().tour?.locked !== false && !!extra().tour;

export function setLocked(on) {
  if (!extra().tour) return;
  extra().tour.locked = !!on;
  touch();
}

/** Save a tour into the workflow (locked). Refuses to replace a locked one. */
export function save(tour) {
  if (isLocked()) throw new Error("The saved tour is locked. Unlock it first (right-click the tour).");
  extra().tour = { ...JSON.parse(JSON.stringify(tour)), source: "saved", saved: Date.now(), locked: true };
  touch();
}

export function remove() {
  if (isLocked()) throw new Error("The saved tour is locked. Unlock it first (right-click the tour).");
  delete extra().tour;
  touch();
}

// ------------------------------------------------------------------ the player: a card on the canvas
let play = null; // {tour, i, card, raf}

// a step lights one or more groups (tours saved before this have a single "group")
function stepGroups(s) {
  const refs = s.groups || (s.group ? [s.group] : []);
  return refs.map((r) => groupsOf().find((x) => x.title === r.title) || groupsOf()[r.index]).filter(Boolean);
}

function stepTargets(s) {
  return { ns: (s.nodes || []).map(byId).filter(Boolean), gs: stepGroups(s) };
}

function place() {
  if (!play) return;
  const c = app.canvas;
  const s = play.tour.steps[play.i];
  const { ns, gs } = stepTargets(s);
  const box = boxOf(gs.length ? [] : ns, gs);
  const r = c.canvas.getBoundingClientRect();
  const card = play.card;
  const ch = card.offsetHeight || 220;
  let x = r.right - CARD_W - 16, y = r.top + 70;
  if (box) {
    const sx = (box[0] + c.ds.offset[0]) * c.ds.scale + r.left, sy = (box[1] + c.ds.offset[1]) * c.ds.scale + r.top;
    const sw = box[2] * c.ds.scale;
    x = sx + sw + 18 + CARD_W < r.right ? sx + sw + 18 : sx - CARD_W - 18 > r.left ? sx - CARD_W - 18 : r.right - CARD_W - 16;
    y = sy;
  }
  // the canvas runs under ComfyUI's menus: keep the card below the top bar and clear of the bottom toolbar
  const top = r.top + 120; // under the workflow tabs and the action bar
  card.style.left = `${Math.round(Math.max(r.left + 56, Math.min(x, r.right - CARD_W - 12)))}px`;
  card.style.top = `${Math.round(Math.max(top, Math.min(y, r.bottom - ch - 70)))}px`;
  play.raf = requestAnimationFrame(place);
}

function drawCard() {
  const { tour, i } = play;
  const s = tour.steps[i];
  const last = i === tour.steps.length - 1;
  play.card.innerHTML = `
    <div class="vt-head"><span>${esc(tour.title)} · step ${i + 1} of ${tour.steps.length}</span><button class="vt-x" data-t="exit" title="End the tour (Esc)">✕</button></div>
    <div class="vt-title">${esc(s.title)}</div>
    <div class="vt-text">${esc(s.text)}</div>
    ${s.settings.length ? `<div class="vt-sets">${s.settings.map((x, k) => `<div class="vt-set" data-k="${k}" title="Show this setting"><span class="vt-num">${k + 1}</span><span><b>${esc(core.nodeLabel(byId(x.node)))} › ${esc(x.widget)}</b>${x.why ? `: ${esc(x.why)}` : ""}</span></div>`).join("")}</div>` : ""}
    <div class="vt-foot">
      <button class="vt-btn" data-t="back" ${i ? "" : "disabled"}>‹ Back</button>
      <span class="vt-dots">${tour.steps.map((_, k) => `<i class="${k === i ? "on" : ""}" data-go="${k}" title="${esc(tour.steps[k].title)}"></i>`).join("")}</span>
      <button class="vt-btn pri" data-t="${last ? "exit" : "next"}">${last ? "Finish" : "Next ›"}</button>
    </div>`;
  play.card.querySelectorAll("[data-t]").forEach((b) => (b.onclick = () => (b.dataset.t === "exit" ? stop() : go(play.i + (b.dataset.t === "next" ? 1 : -1)))));
  play.card.querySelectorAll("[data-go]").forEach((d) => (d.onclick = () => go(Number(d.dataset.go))));
  play.card.querySelectorAll("[data-k]").forEach((d) => (d.onclick = () => {
    const x = s.settings[Number(d.dataset.k)];
    highlight([byId(x.node)], [], { persist: true, marks: [{ node: byId(x.node), widget: x.widget, n: Number(d.dataset.k) + 1 }], room: CARD_W + 40 });
  }));
}

export function go(i) {
  if (!play) return;
  play.i = Math.max(0, Math.min(play.tour.steps.length - 1, i));
  const s = play.tour.steps[play.i];
  const { ns, gs } = stepTargets(s);
  const marks = s.settings.map((x, k) => ({ node: byId(x.node), widget: x.widget, n: k + 1 })).filter((m) => m.node);
  highlight(gs.length ? [] : ns, gs, { persist: true, marks, room: CARD_W + 40 });
  drawCard();
  play.onStep?.(play.i);
}

function onKey(e) {
  if (!play || e.target?.closest?.("input, textarea, [contenteditable]")) return;
  if (e.key === "Escape") stop();
  else if (e.key === "ArrowRight") go(play.i + 1);
  else if (e.key === "ArrowLeft") go(play.i - 1);
  else return;
  e.preventDefault();
  e.stopPropagation();
}

/** Start (or jump within) a tour. onStep(i) lets the panel mark the current step. */
export function start(tour, i = 0, onStep) {
  if (!tour?.steps?.length) return;
  if (!play) {
    const card = document.createElement("div");
    card.className = "vt-card";
    document.body.appendChild(card);
    play = { card };
    document.addEventListener("keydown", onKey, true);
    play.raf = requestAnimationFrame(place);
  }
  play.tour = tour;
  play.onStep = onStep;
  go(i);
  setTimeout(() => play && go(play.i), 400); // a workflow that just opened restores its own view a moment later
}

export function stop() {
  if (!play) return;
  cancelAnimationFrame(play.raf);
  play.card.remove();
  document.removeEventListener("keydown", onKey, true);
  const cb = play.onStep;
  play = null;
  clearGlow();
  cb?.(-1);
}

export const playing = () => (play ? play.i : -1);

const st = document.createElement("style");
st.textContent = `
.vt-card{position:fixed;z-index:1000;width:${CARD_W}px;box-sizing:border-box;background:var(--comfy-menu-bg,#222);color:var(--fg-color,#ddd);border:1px solid #ffb84a;border-radius:12px;padding:10px 12px;box-shadow:0 10px 30px rgba(0,0,0,.5);font:13px/1.45 sans-serif}
.vt-head{display:flex;justify-content:space-between;align-items:center;font-size:11px;color:var(--descrip-text,#999)}
.vt-x{background:none;border:0;color:var(--descrip-text,#999);cursor:pointer;font-size:14px}
.vt-title{font-weight:700;font-size:15px;margin:4px 0}
.vt-text{margin-bottom:6px}
.vt-sets{display:flex;flex-direction:column;gap:4px;margin:6px 0;padding-top:6px;border-top:1px dashed var(--border-color,#444)}
.vt-set{display:flex;gap:7px;align-items:flex-start;cursor:pointer;font-size:12px}
.vt-set:hover{color:#ffb84a}
.vt-num{flex:none;width:18px;height:18px;border-radius:50%;background:#ffb84a;color:#1a1a1a;font-weight:700;font-size:11px;display:flex;align-items:center;justify-content:center}
.vt-foot{display:flex;align-items:center;gap:6px;margin-top:8px}
.vt-btn{background:var(--comfy-input-bg,#333);color:var(--fg-color,#ddd);border:1px solid var(--border-color,#444);border-radius:6px;padding:4px 10px;cursor:pointer;font-size:12px}
.vt-btn.pri{border-color:#ffb84a}
.vt-btn:disabled{opacity:.4;cursor:default}
.vt-dots{flex:1;display:flex;justify-content:center;gap:4px;flex-wrap:wrap}
.vt-dots i{width:7px;height:7px;border-radius:50%;background:var(--border-color,#555);cursor:pointer}
.vt-dots i.on{background:#ffb84a}`;
document.head.appendChild(st);
