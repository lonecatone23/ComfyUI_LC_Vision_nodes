// Vision Assistant: damaged workflows. A workflow stores every wire twice (in its link table and on the two nodes it
// joins). When those disagree, ComfyUI can silently drop inputs, refuse to queue, or crash on load. This finds the
// disagreements (in the workflow and inside every subgraph) and repairs the safe ones.
import { app } from "../../../scripts/app.js";

const linkMap = (g) => g.links instanceof Map ? g.links : null;
const allLinks = (g) => (linkMap(g) ? [...g.links.values()] : Object.values(g.links || {})).filter(Boolean);
const getLink = (g, id) => (id == null ? null : linkMap(g) ? g.links.get(id) ?? g.links.get(Number(id)) : g.links?.[id]);
const nodesOf = (g) => g._nodes || g.nodes || [];
const label = (n) => (n.title && n.title !== n.type ? n.title : n.type);

function graphs() {
  const out = [{ g: app.graph, where: "" }];
  const seen = new Set();
  const walk = (g, depth) => {
    for (const n of nodesOf(g)) {
      const sg = n.subgraph;
      if (sg && !seen.has(sg) && depth < 4) {
        seen.add(sg);
        out.push({ g: sg, where: ` inside "${label(n)}"`, host: n });
        walk(sg, depth + 1);
      }
    }
  };
  walk(app.graph, 0);
  return out;
}

/** Every problem found: [{kind, text, node, fix(): bool | null}] */
export function findDamage() {
  const issues = [];
  for (const { g, where, host } of graphs()) {
    if (!g) continue;
    const byId = new Map();
    for (const n of nodesOf(g)) {
      if (byId.has(String(n.id))) issues.push({ kind: "dup", text: `Two nodes share id ${n.id}${where} (${label(byId.get(String(n.id)))} and ${label(n)})`, node: host || n, fix: null });
      else byId.set(String(n.id), n);
      const bad = (v) => !Number.isFinite(v) || Math.abs(v) > 1e7;
      if (bad(n.pos?.[0]) || bad(n.pos?.[1]) || bad(n.size?.[0]) || bad(n.size?.[1])) {
        issues.push({ kind: "lost", text: `${label(n)}${where} has a broken position or size, so it can't be seen`, node: host || null,
          fix: () => { n.pos = [0, 0]; n.size = n.computeSize?.() || [200, 100]; return true; } });
      }
    }
    const node = (id) => byId.get(String(id));
    // the link table against the nodes
    for (const l of allLinks(g)) {
      const from = node(l.origin_id), to = node(l.target_id);
      const virtual = l.origin_id === -10 || l.target_id === -20 || l.origin_id < 0 || l.target_id < 0; // subgraph inputs / outputs
      if (virtual) continue;
      if (!from || !to) {
        issues.push({ kind: "dangling", text: `A wire${where} points at a node that no longer exists (link ${l.id})`, node: host || from || to || null,
          fix: () => {
            const o = from?.outputs?.[l.origin_slot];
            if (o?.links) o.links = o.links.filter((x) => x !== l.id);
            const i = to?.inputs?.[l.target_slot];
            if (i?.link === l.id) i.link = null;
            if (linkMap(g)) g.links.delete(l.id);
            else delete g.links[l.id];
            return true;
          } });
        continue;
      }
      const inp = to.inputs?.[l.target_slot];
      const out = from.outputs?.[l.origin_slot];
      if (!inp || !out) {
        issues.push({ kind: "slot", text: `A wire${where} from ${label(from)} to ${label(to)} uses a slot that doesn't exist (link ${l.id})`, node: host || to,
          fix: () => {
            if (out?.links) out.links = out.links.filter((x) => x !== l.id);
            if (inp?.link === l.id) inp.link = null;
            if (linkMap(g)) g.links.delete(l.id);
            else delete g.links[l.id];
            return true;
          } });
        continue;
      }
      if (inp.link !== l.id) {
        const other = getLink(g, inp.link);
        issues.push({ kind: "oneside", text: `${label(to)}${where}: input "${inp.name}" doesn't know about its wire from ${label(from)} (link ${l.id})`, node: host || to,
          fix: () => {
            if (inp.link == null || !other) inp.link = l.id; // the input lost its wire: give it back
            else { // the input has a different, valid wire: this one is stale
              out.links = (out.links || []).filter((x) => x !== l.id);
              if (linkMap(g)) g.links.delete(l.id);
              else delete g.links[l.id];
            }
            return true;
          } });
      }
      if (!(out.links || []).includes(l.id)) {
        issues.push({ kind: "oneside", text: `${label(from)}${where}: output "${out.name}" doesn't list its wire to ${label(to)} (link ${l.id})`, node: host || from,
          fix: () => { out.links = [...(out.links || []), l.id]; return true; } });
      }
    }
    // the nodes against the link table
    for (const n of nodesOf(g)) {
      (n.inputs || []).forEach((inp, slot) => {
        if (inp.link == null) return;
        const l = getLink(g, inp.link);
        if (!l || String(l.target_id) !== String(n.id) || l.target_slot !== slot) {
          if (l && l.target_id < 0) return;
          issues.push({ kind: "ghost", text: `${label(n)}${where}: input "${inp.name}" points at a wire that ${l ? "goes somewhere else" : "doesn't exist"}`, node: host || n,
            fix: () => { inp.link = null; return true; } });
        }
      });
      (n.outputs || []).forEach((out, slot) => {
        const stale = (out.links || []).filter((id) => {
          const l = getLink(g, id);
          return !l || (String(l.origin_id) !== String(n.id) && l.origin_id >= 0) || (l.origin_slot !== slot && l.origin_id >= 0);
        });
        if (stale.length) {
          issues.push({ kind: "ghost", text: `${label(n)}${where}: output "${out.name}" lists ${stale.length} wire${stale.length === 1 ? "" : "s"} that don't exist`, node: host || n,
            fix: () => { out.links = out.links.filter((id) => !stale.includes(id)); return true; } });
        }
      });
    }
  }
  return issues;
}

/** Repair everything that can be repaired safely. Returns {fixed, left}. */
export function repair() {
  let fixed = 0;
  for (let pass = 0; pass < 3; pass++) { // a fix can reveal the next problem: a few passes settle it
    const todo = findDamage().filter((x) => x.fix);
    if (!todo.length) break;
    for (const x of todo) {
      try {
        if (x.fix()) fixed++;
      } catch (_) {}
    }
  }
  app.graph.setDirtyCanvas?.(true, true);
  try {
    app.extensionManager?.workflow?.activeWorkflow?.changeTracker?.checkState?.(); // so Ctrl+Z can undo it
  } catch (_) {}
  return { fixed, left: findDamage().length };
}
