// Vision Assistant guided tour: the workflow's parts in reading order, each with a short explanation and the settings
// that matter. A card floats on the canvas next to the part, the part stays lit, and its settings get numbered markers.
// A tour can be saved inside the workflow (graph.extra.vision_assistant.tour); a saved tour plays without the model.
import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import * as core from "./va_core.js";
import * as chat from "./va_chat.js";
import { highlight, clearGlow, boxOf } from "./va_glow.js";
import * as i18n from "./va_i18n.js";
import { t, BY_CODE } from "./va_i18n.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
// a tour is about the workflow's top level, also while the canvas shows the inside of a subgraph
const root = () => app.rootGraph || app.graph;
const nodes = () => root()?._nodes || [];
const isNote = (n) => /Note|Label|Reroute|Primitive$/i.test(n.type);
const groupsOf = () => root()?._groups || [];
const byId = (id) => nodes().find((n) => String(n.id) === String(id));
/** What a setting is called on the node face (panel toggles carry their target's name as a label, not as the name). */
export const widgetLabel = (id, name) => {
  if (String(name).startsWith("part:")) return String(name).slice(5); // a part of the node's own panel
  const w = byId(id)?.widgets?.find((x) => x.name === name);
  return String(w?.label || name).trim();
};
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
const PLUMB_LABEL = /get ?sets?|noodle|spaghetti|plumbing|wiring|bypass|switch|reroute|relay/i;
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
      if (n && want.startsWith("part:")) return { ...x, node: n.id }; // found on screen when the step plays
      const w = n?.widgets?.find((y) => y.name?.toLowerCase() === want || String(y.label || "").toLowerCase() === want);
      return w ? { ...x, node: n.id, widget: w.name } : null;
    }).filter(Boolean);
    return { ...s, settings };
  }).filter(Boolean);
  return { ...tour, steps };
}

const extra = () => {
  const g = app.rootGraph || app.graph; // the workflow's own extra, also while you are inside a subgraph
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

/** Settings an author can mark on a step: whatever is selected on the canvas first (so a node outside the step works
 * too), then the step's own nodes and the nodes inside its groups. [{group, node, widget, label}] */
export function stepChoices(s) {
  const inGroup = (n, g) => {
    const [x, y, w, h] = g._bounding || g.bounding || [0, 0, 0, 0];
    return n.pos[0] >= x && n.pos[1] >= y && n.pos[0] < x + w && n.pos[1] < y + h;
  };
  const own = new Set((s.nodes || []).map(String));
  for (const g of stepGroups(s)) for (const n of nodes()) if (inGroup(n, g)) own.add(String(n.id));
  const picked = Object.keys(app.canvas?.selected_nodes || {});
  const out = [];
  const seen = new Set();
  const add = (id, group) => {
    const n = byId(id);
    if (!n) return;
    for (const w of n.widgets || []) {
      if (!w.name || w.type === "button" || w.type === "hidden" || w.hidden || w.options?.serialize === false
        || /^(_|lc_|\$\$)/.test(w.name) || /^[A-Z0-9_]+$/.test(w.name)) continue; // spacers, buttons and internal widgets are nothing to point at
      const key = `${n.id}|${w.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ group, node: n.id, widget: w.name, label: `${core.nodeLabel(n)} › ${w.label || w.name}` });
    }
    // the parts of the node's own panel (a Proof Sheet card, an Assembler card, a Shot List box)
    for (const el of n.widgets?.flatMap((w) => (w.element ? [...w.element.querySelectorAll("[data-tour]")] : [])) || []) {
      const part = String(el.dataset.tour || "").replace(/\|/g, "/").trim();
      const key = `${n.id}|part:${part}`;
      if (!part || seen.has(key)) continue;
      seen.add(key);
      out.push({ group, node: n.id, widget: `part:${part}`, label: `${core.nodeLabel(n)} › ${part}` });
    }
  };
  picked.forEach((id) => add(id, "Selected on the canvas"));
  own.forEach((id) => add(id, "This step"));
  return out;
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

// ------------------------------------------------------------------ languages: a saved tour can carry translations
// tour.lang = the language its author wrote it in (tours from before this are English). Each step keeps its own
// translations: step.i18n = {zh: {title, text, src, why: {"<node>|<widget>": {text, src}}}}, the tour's title in
// tour.i18n = {zh: {title}}. src = a hash of the original it was made from, so a step (or a setting note) edited
// later plays in the original until it is translated again. The reader's language is LC123's Note language.
export function hash(s) { // the same FNV-1a as LC Note, so translation tools can share it
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16);
}
export const stepSrc = (s) => hash(`${s.title || ""}\u0001${s.text || ""}`);
const whyKey = (x) => `${x.node}|${x.widget}`;
export const sourceLang = (tour) => tour?.lang || "en";
export const langLabel = (code) => BY_CODE[code]?.[1] || code;

/** Languages the tour can play in: its original first, then each one with at least one current step. */
export function languages(tour) {
  const have = new Set();
  for (const s of tour?.steps || []) for (const [code, x] of Object.entries(s.i18n || {})) if (x?.src === stepSrc(s)) have.add(code);
  have.delete(sourceLang(tour));
  return [sourceLang(tour), ...[...have].sort()];
}

/** Translate the saved tour into `code` with LC Vision's local translator (one model load for the whole tour) and keep
 * it in the tour, per step. Allowed on a locked tour: the original words don't change. Returns {done, warnings}. */
export async function translate(code) {
  const tr = extra().tour;
  if (!tr) throw new Error(t("No saved tour to translate."));
  const target = BY_CODE[code]?.[2];
  if (!target || code === sourceLang(tr)) throw new Error(t("Pick a language other than the tour's own (LC Settings > Notes > Note language)."));
  const items = [{ title: tr.title || "", text: "" }];
  const map = []; // what each item is: ["step", i] / ["why", i, key]
  tr.steps.forEach((s, i) => {
    items.push({ title: s.title || "", text: s.text || "" });
    map.push(["step", i]);
    for (const x of s.settings || []) if (x.why) {
      items.push({ text: x.why });
      map.push(["why", i, whyKey(x), x.why]);
    }
  });
  const r = await api.fetchApi("/lc_vision/translate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ items, target }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error || !Array.isArray(j.items)) throw new Error(j.error || r.statusText || t("The translation failed."));
  const rows = j.items;
  tr.i18n = { ...(tr.i18n || {}), [code]: { title: rows[0]?.title || tr.title } };
  const warnings = rows.filter((x) => x.warning).map((x) => x.warning);
  map.forEach((m, k) => {
    const row = rows[k + 1];
    if (!row) return;
    const s = tr.steps[m[1]];
    s.i18n = s.i18n || {};
    const cur = s.i18n[code] || {};
    if (m[0] === "step") s.i18n[code] = { ...cur, title: row.title || s.title, text: row.text || s.text, src: stepSrc(s), why: cur.why || {} };
    else (s.i18n[code] = { ...cur, why: { ...(cur.why || {}), [m[2]]: { text: row.text, src: hash(m[3]) } } });
  });
  touch();
  return { done: tr.steps.length, warnings };
}

/** Steps with a current translation into `code`, out of all steps (for "12 of 14 steps in 中文"). */
export const translatedCount = (tour, code) => (tour?.steps || []).filter((s) => s.i18n?.[code]?.src === stepSrc(s)).length;

/** The tour as a reader of `code` sees it: translated where current, the original elsewhere. Steps keep their order. */
export function localize(tour, code) {
  if (!tour || !code || code === sourceLang(tour)) return tour;
  const steps = tour.steps.map((s) => {
    const tr = s.i18n?.[code];
    if (!tr || tr.src !== stepSrc(s)) return s;
    const settings = (s.settings || []).map((x) => {
      const w = tr.why?.[whyKey(x)];
      return w && x.why && w.src === hash(x.why) ? { ...x, why: w.text } : x;
    });
    return { ...s, title: tr.title || s.title, text: tr.text || s.text, settings };
  });
  return { ...tour, title: tour.i18n?.[code]?.title || tour.title, steps };
}

function drawCard() {
  const { tour, i } = play;
  const s = tour.steps[i];
  const last = i === tour.steps.length - 1;
  const L = { back: t("‹ Back"), next: t("Next ›"), finish: t("Finish"), end: t("End the tour (Esc)"), show: t("Show this setting") };
  const langs = languages(play.base);
  const flip = langs.length > 1 ? `<button class="vt-x vt-lang" data-lang title="${esc(langs.map(langLabel).join(" / "))}">${esc(langLabel(play.lang))}</button>` : "";
  play.card.innerHTML = `
    <div class="vt-head"><span>${esc(tour.title)} · ${esc(t("step {i} of {n}", { i: i + 1, n: tour.steps.length }))}</span>${flip}<button class="vt-x" data-t="exit" title="${esc(L.end)}">✕</button></div>
    <div class="vt-title">${esc(s.title)}</div>
    <div class="vt-text">${esc(s.text)}</div>
    ${s.settings.length ? `<div class="vt-sets">${s.settings.map((x, k) => `<div class="vt-set" data-k="${k}" title="${L.show}"><span class="vt-num">${k + 1}</span><span><b>${esc(core.nodeLabel(byId(x.node)))} › ${esc(widgetLabel(x.node, x.widget))}</b>${x.why ? `: ${esc(x.why)}` : ""}</span></div>`).join("")}</div>` : ""}
    <div class="vt-foot">
      <button class="vt-btn" data-t="back" ${i ? "" : "disabled"}>${L.back}</button>
      <span class="vt-dots">${tour.steps.map((_, k) => `<i class="${k === i ? "on" : ""}" data-go="${k}" title="${esc(tour.steps[k].title)}"></i>`).join("")}</span>
      <button class="vt-btn pri" data-t="${last ? "exit" : "next"}">${last ? L.finish : L.next}</button>
    </div>`;
  const lb = play.card.querySelector("[data-lang]");
  if (lb) lb.onclick = () => {
    play.lang = langs[(langs.indexOf(play.lang) + 1) % langs.length];
    play.tour = localize(play.base, play.lang);
    drawCard();
  };
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
  toTop();
  if (!play) {
    const card = document.createElement("div");
    card.className = "vt-card";
    document.body.appendChild(card);
    play = { card };
    document.addEventListener("keydown", onKey, true);
    play.raf = requestAnimationFrame(place);
  }
  // the reader's language when the tour has it, else English (the card's language button switches)
  const want = i18n.lang();
  play.base = tour;
  play.lang = languages(tour).includes(want) ? want : sourceLang(tour);
  play.tour = localize(tour, play.lang);
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
.vt-lang{font-size:11px;border:1px solid var(--border-color,#555);border-radius:8px;padding:0 6px;margin:0 6px 0 auto}
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

/** Back to the workflow's top level when the canvas shows the inside of a subgraph (tours light up top-level parts). */
export function toTop() {
  const c = app.canvas;
  if (!c || !app.rootGraph || c.graph === app.rootGraph) return;
  try {
    c.setGraph(app.rootGraph);
  } catch (_) {}
}

// ------------------------------------------------------------------ suggested steps, no AI: the usual path of travel
// load image > size > model > LLM > prompt > generate > upscale / detail > post process > save
const STAGES = [
  { key: "load", rank: 0, title: /\b(load|input|source|reference|ref)\b|image in/i, node: /LoadImage|Load ?Image|ImageLoader|LoadVideo/i,
    text: "Load your picture here.", sets: /^(image|video|file)$/i },
  { key: "size", rank: 1, title: /\b(size|resolution|aspect|ratio|dimensions?|latent)\b/i, node: /EmptyLatent|EmptySD3|EmptyHunyuan|AspectRatio|Megapixel|LatentSize|ImageResize(?!.*Upscale)/i,
    text: "Pick the size and shape of the image.", sets: /^(width|height|megapixels?|aspect.*|ratio|resolution|preset|orientation|batch_size)$/i },
  { key: "model", rank: 2, title: /\b(models?|loras?|checkpoint|loaders?|optimi[sz]er)\b/i, node: /CheckpointLoader|UNETLoader|UnetLoader|LoraLoader|Lora ?Loader|LoraStack|LCLora|CLIPLoader|DualCLIP|Optimizer|ModelSampling/i,
    text: "The model and LoRAs live here.", sets: /^(ckpt_name|unet_name|model|lora.*|strength.*|preset)$/i },
  { key: "llm", rank: 3, title: /\b(llm|vision|vlm|caption|enhanc\w*|qwen|florence|gemini|ollama|gpt|translat\w*)\b/i, node: /Vision|LLM|Qwen.?VL|Florence|Ollama|Gemini|GPT|Caption|JoyCap|PromptEnhanc|Llama|Translat/i,
    text: "The vision model reads your picture or idea and writes the prompt for you.", sets: /^(enabled?|mode|instruction|style|task|preset)$/i },
  { key: "prompt", rank: 4, title: /\b(prompts?|text|conditioning|positive|negative)\b/i, node: /CLIPTextEncode|TextEncode|PromptBox|Prompt(?!Enhanc)|LCText|StringMultiline/i,
    text: "Type what you want to see.", sets: /^(text|prompt|positive|string|value)$/i },
  { key: "generate", rank: 5, title: /\b(generat\w*|sampl\w*|ksampler|render|first pass|main|base)\b/i, node: /KSampler|SamplerCustom|Sampler(?!Select)|Guider$/i,
    text: "This makes the image. Steps, CFG and seed live here.", sets: /^(seed|noise_seed|steps|cfg|denoise|sampler_name|scheduler)$/i },
  { key: "upscale", rank: 6, title: /\b(upscal\w*|super ?res\w*|enlarg\w*|hires|hi-res|tiled)\b/i, node: /Upscale|SUPIR|VOSR|SeedVR|TiledDiffusion|UltimateSD/i,
    text: "Makes the image bigger and sharper.", sets: /^(upscale_model|model_name|scale_by|scale|upscale_by|denoise|factor)$/i },
  { key: "detail", rank: 6, title: /\b(detail\w*|face ?fix|faces?|hands?|inpaint\w*|anypaint|refin\w*)\b/i, node: /Detailer|FaceDetail|Inpaint|SAM|Segment|BBox|Anypaint|ADetailer/i,
    text: "Redraws faces, hands and small details.", sets: /^(denoise|steps|guide_size|bbox_threshold|threshold|prompt)$/i },
  { key: "post", rank: 7, title: /\b(post|effects?|fx|colou?r|lut|grain|film|sharpen|finish\w*|grade|grading|lighting|look)\b/i, node: /LUT|Grain|Sharpen|Vignette|ColorMatch|ColorCorrect|Film|Bloom|Chromatic|ToneCurve|PostProcess|Lighting|PhoneLook|SkinBeauty/i,
    text: "Final touches: color, grain, sharpen, etc.", sets: /^(strength|amount|intensity|preset|lut_name|grain.*)$/i },
  { key: "save", rank: 8, title: /\b(save|output|export)\b/i, node: /SaveImage|Save ?Image|SaveVideo|ImageSave|SaveAnimated|LCSave/i,
    text: "Where your image is saved.", sets: /^(filename_prefix|output_path|path|format|quality)$/i },
];

const boundsOf = (g) => g._bounding || g.bounding || [g.pos[0], g.pos[1], g.size[0], g.size[1]];
const inside = (a, b) => { // group a sits inside group b
  const [ax, ay, aw, ah] = boundsOf(a), [bx, by, bw, bh] = boundsOf(b);
  return a !== b && ax >= bx && ay >= by && ax + aw <= bx + bw && ay + ah <= by + bh;
};
const nodesIn = (g) => nodes().filter((n) => !isNote(n) && inGroup(n, g));
// a subgraph node counts as the nodes inside it
const typesOf = (n) => [n.type, n.title, ...((n.subgraph?._nodes || n.subgraph?.nodes || []).flatMap((x) => [x.type, x.title]))].filter(Boolean).join(" ");

/** Which stage of the path a group is: its title first (the earliest word wins), then what its nodes are. */
function stageOf(g) {
  const title = String(g.title || "");
  const byTitle = STAGES.map((st) => ({ st, at: title.search(st.title) })).filter((x) => x.at >= 0).sort((a, b) => a.at - b.at);
  if (byTitle.length) return byTitle[0].st;
  const counts = STAGES.map((st) => ({ st, n: nodesIn(g).filter((n) => !PLUMBING.test(n.type) && st.node.test(typesOf(n))).length }));
  const best = counts.sort((a, b) => b.n - a.n)[0];
  return best && best.n ? best.st : null;
}

/** Up to 3 settings a beginner touches in this stage, from the nodes in its groups. */
function stageSettings(st, gs) {
  if (!st) return [];
  const out = [];
  for (const g of gs) for (const n of nodesIn(g)) {
    if (PLUMBING.test(n.type)) continue;
    for (const w of n.widgets || []) {
      if (out.length >= 3) return out;
      if (!w.name || w.type === "button" || w.hidden || w.options?.serialize === false || !st.sets.test(w.name)) continue;
      if (out.some((x) => x.widget === w.name)) continue; // one "denoise" per step is plenty
      out.push({ node: n.id, widget: w.name, why: "" });
    }
  }
  return out;
}

/** Suggested steps for a hand-made tour: the top-level groups in the usual path of travel, a starter line each.
 * A nested group only gets its own step when its parent is a catch-all holding several stages. */
export function suggest() {
  const all = groupsOf().filter((g) => !PLUMB_LABEL.test(g.title || "") && nodesIn(g).some((n) => !PLUMBING.test(n.type)));
  const top = all.filter((g) => !all.some((p) => inside(g, p)));
  let picked = [];
  for (const g of top) {
    const kids = all.filter((k) => inside(k, g) && !all.some((m) => m !== g && inside(k, m) && inside(m, g)));
    const kidStages = new Set(kids.map(stageOf).filter(Boolean).map((st) => st.key));
    if (kidStages.size >= 2 && !stageOf(g)) picked.push(...kids);
    else picked.push(g);
  }
  // reading order: rows top to bottom (tops within 300 px), left to right inside a row
  picked.sort((a, b) => a.pos[1] - b.pos[1]);
  const rows = [];
  for (const g of picked) {
    const row = rows.find((r) => Math.abs(r[0].pos[1] - g.pos[1]) < 300);
    if (row) row.push(g);
    else rows.push([g]);
  }
  picked = rows.flatMap((r) => r.sort((a, b) => a.pos[0] - b.pos[0]));
  // a group that fits no stage stays next to the group before it
  let last = -1;
  const items = picked.map((g, i) => {
    const st = stageOf(g);
    last = st ? st.rank : last;
    return { g, st, rank: st ? st.rank : last + 0.5, i };
  });
  items.sort((a, b) => a.rank - b.rank || a.i - b.i);
  // neighbours of the same stage share one step
  const steps = [];
  for (const it of items) {
    const prev = steps[steps.length - 1];
    if (prev && it.st && prev.st === it.st) {
      prev.gs.push(it.g);
      continue;
    }
    steps.push({ st: it.st, gs: [it.g] });
  }
  const gi = (g) => groupsOf().indexOf(g);
  const name = (g) => String(g.title || t("Step")).replace(/^#\s*/, "").trim();
  if (!steps.length) { // no groups: the columns parts() finds
    return parts().map((p) => ({ title: p.label, text: "", nodes: p.nodes.map((n) => n.id), groups: [], settings: [] }));
  }
  return steps.map(({ st, gs }) => ({
    title: gs.map(name).join(" + ").slice(0, 80),
    text: st ? t(st.text) : "", // the starter line in the author's language
    groups: gs.map((g) => ({ title: g.title, index: gi(g) })),
    nodes: [],
    settings: stageSettings(st, gs),
  }));
}
