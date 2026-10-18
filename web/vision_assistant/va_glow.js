// Vision Assistant glow: points at nodes or a group. The view zooms to fit them and they pulse with a soft outline
// for a few seconds (or until cleared, for the guided tour). Settings can get numbered markers on their rows.
// Drawn on the canvas (classic) and as a CSS class on the node element (Nodes 2.0).
import { app } from "../../../scripts/app.js";

const GLOW_MS = 6000;
const COLOR = "#ffb84a";
let glow = null; // {nodes: [node], groups: [group], until, marks: [{node, widget, n}]}

function widgetY(node, w) {
  // classic LiteGraph remembers where it last drew each widget, relative to the node's top
  if (typeof w.last_y === "number") return w.last_y;
  if (typeof w.y === "number") return w.y;
  const i = node.widgets.indexOf(w);
  return (node.widgets_start_y || 6) + i * ((LiteGraph.NODE_WIDGET_HEIGHT || 20) + 4);
}

function hook() {
  const c = app.canvas;
  if (!c || c.__vaGlow) return;
  c.__vaGlow = true;
  const prev = c.onDrawForeground;
  c.onDrawForeground = function (ctx, area) {
    prev?.call(this, ctx, area);
    if (!glow) return;
    const left = glow.until - performance.now();
    if (left <= 0) return clearGlow();
    const now = performance.now();
    const pulse = 0.55 + 0.45 * Math.sin(now / 180);
    const fade = Math.min(1, left / 800);
    const sc = Math.max(0.3, this.ds?.scale || 1);
    ctx.save();
    ctx.strokeStyle = COLOR;
    ctx.shadowColor = COLOR;
    ctx.globalAlpha = (glow.calm ? 0.75 + 0.25 * Math.sin(now / 400) : pulse) * fade;
    ctx.lineWidth = 4 / sc;
    ctx.shadowBlur = 24;
    const th = LiteGraph.NODE_TITLE_HEIGHT || 30;
    for (const n of glow.nodes) {
      const pad = 8;
      ctx.beginPath();
      ctx.roundRect?.(n.pos[0] - pad, n.pos[1] - th - pad, n.size[0] + pad * 2, n.size[1] + th + pad * 2, 12);
      ctx.stroke();
    }
    for (const g of glow.groups) {
      const [x, y, w, h] = g._bounding || [g.pos[0], g.pos[1], g.size[0], g.size[1]];
      ctx.beginPath();
      ctx.roundRect?.(x - 6, y - 6, w + 12, h + 12, 14);
      ctx.stroke();
    }
    // numbered markers on the settings that matter, matching the numbers on the tour card
    ctx.globalAlpha = fade;
    ctx.shadowBlur = 0;
    const wh = LiteGraph.NODE_WIDGET_HEIGHT || 20;
    for (const m of glow.marks || []) {
      const n = m.node;
      if (n.flags?.collapsed) continue;
      let box = null; // [x, y, w, h] in graph space
      if (String(m.widget).startsWith("part:")) {
        markPart(m); // drawn in HTML: the panel covers the canvas
        continue;
      } else {
        const w = n.widgets?.find((x) => x.name === m.widget);
        if (!w) continue;
        box = [n.pos[0] + 6, n.pos[1] + widgetY(n, w) - 1, n.size[0] - 12, wh + 2];
      }
      ctx.lineWidth = 2 / sc;
      ctx.beginPath();
      ctx.roundRect?.(box[0], box[1], box[2], box[3], 6);
      ctx.stroke();
      const r = 9 / Math.min(1, sc) * 0.9;
      // a field: the number left of the node; a part of a panel (a card in a grid): on its top-left corner
      const part = String(m.widget).startsWith("part:");
      const cx = part ? box[0] + r * 0.6 : Math.min(n.pos[0], box[0]) - r - 6;
      const cy = part ? box[1] + r * 0.6 : box[1] + Math.min(box[3], wh + 2) / 2;
      ctx.fillStyle = COLOR;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#1a1a1a";
      ctx.font = `bold ${Math.round(r * 1.2)}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(m.n), cx, cy + 0.5);
    }
    ctx.restore();
  };
}

const domEl = (n) => document.querySelector(`[data-node-id="${n.id}"]`);

/** A part of a node's own panel, by its data-tour label (Proof Sheet cards, Assembler cards, Shot List boxes). */
export function partEl(n, label) {
  for (const w of n?.widgets || []) {
    const el = w.element?.querySelector?.(`[data-tour="${CSS.escape(label)}"]`);
    if (el) return el;
  }
  return null;
}

/** Bounding box of nodes and groups in graph space: [x, y, w, h] */
export function boxOf(nodes = [], groups = []) {
  const th = LiteGraph.NODE_TITLE_HEIGHT || 30;
  const boxes = [...nodes.map((n) => [n.pos[0], n.pos[1] - th, n.size[0], n.size[1] + th]),
    ...groups.map((g) => g._bounding || [g.pos[0], g.pos[1], g.size[0], g.size[1]])];
  if (!boxes.length) return null;
  const x0 = Math.min(...boxes.map((b) => b[0])), y0 = Math.min(...boxes.map((b) => b[1]));
  const x1 = Math.max(...boxes.map((b) => b[0] + b[2])), y1 = Math.max(...boxes.map((b) => b[1] + b[3]));
  return [x0, y0, x1 - x0, y1 - y0];
}

/** Zoom to a box. room = screen pixels to keep free on the right (for the tour card). */
function fit(box, room = 0) {
  const c = app.canvas;
  if (!c?.ds || !box) return;
  const [x0, y0, w, h] = box;
  const el = c.canvas;
  // the open sidebar panel and the floating top bar sit on top of the canvas: centre in what is actually visible
  const r = el.getBoundingClientRect();
  const panel = document.querySelector(".side-bar-panel, .sidebar-content-container")?.getBoundingClientRect();
  const left = panel && panel.width ? Math.max(0, panel.right - r.left) : 0;
  const top = 60;
  const W = (el.clientWidth || el.width) - room - left, H = (el.clientHeight || el.height) - top;
  const scale = Math.max(0.2, Math.min(1.2, Math.min(W / (w + 160), H / (h + 160))));
  c.ds.scale = scale;
  c.ds.offset[0] = (left + W / 2) / scale - (x0 + w / 2);
  c.ds.offset[1] = (top + H / 2) / scale - (y0 + h / 2);
  c.setDirty(true, true);
}

// ------------------------------------------------------------------ markers on panel parts (HTML, above the canvas)
const badges = new Map(); // mark number -> badge element
function markPart(m) {
  if (!document.getElementById("va-part-css")) {
    const st = document.createElement("style");
    st.id = "va-part-css";
    st.textContent = `.va-part-mark{outline:2px solid ${COLOR}!important;outline-offset:1px;border-radius:4px}
      .va-part-badge{position:fixed;z-index:9999;width:20px;height:20px;border-radius:50%;background:${COLOR};color:#1a1a1a;
        font:bold 12px sans-serif;display:flex;align-items:center;justify-content:center;pointer-events:none;box-shadow:0 1px 4px #0008}`;
    document.head.appendChild(st);
  }
  const el = partEl(m.node, m.widget.slice(5));
  let b = badges.get(m.n);
  const rc = el?.getBoundingClientRect();
  if (!rc || !rc.width) {
    if (b) b.style.display = "none";
    return;
  }
  el.classList.add("va-part-mark"); // a panel that re-renders drops it: put back every frame
  if (!b) {
    b = document.createElement("div");
    b.className = "va-part-badge";
    b.textContent = String(m.n);
    document.body.appendChild(b);
    badges.set(m.n, b);
  }
  b.style.display = "flex";
  b.style.left = `${Math.round(rc.left - 10)}px`;
  b.style.top = `${Math.round(rc.top - 10)}px`;
}

function clearParts() {
  for (const b of badges.values()) b.remove();
  badges.clear();
  document.querySelectorAll(".va-part-mark").forEach((el) => el.classList.remove("va-part-mark"));
}

export function clearGlow() {
  clearParts();
  if (glow) glow.nodes.forEach((n) => domEl(n)?.classList.remove("va-glow"));
  glow = null;
  app.canvas?.setDirty(true, true);
}

/**
 * Make nodes and/or groups glow and bring them into view.
 * opts.persist: stay lit until clearGlow() (the tour). opts.marks: [{node, widget, n}]. opts.room: px kept free on the right.
 */
export function highlight(nodes = [], groups = [], opts = {}) {
  hook();
  if (glow) glow.nodes.forEach((n) => domEl(n)?.classList.remove("va-glow"));
  nodes = nodes.filter(Boolean);
  groups = groups.filter(Boolean);
  if (!nodes.length && !groups.length) return;
  clearParts();
  glow = { nodes, groups, until: opts.persist ? Infinity : performance.now() + GLOW_MS, marks: opts.marks || [], calm: !!opts.persist };
  // badges on panel parts follow the panel every frame (it scrolls and re-renders without the canvas redrawing)
  const g0 = glow;
  if (g0.marks.some((m) => String(m.widget).startsWith("part:"))) {
    const tick = () => {
      if (glow !== g0) return;
      for (const m of g0.marks) if (String(m.widget).startsWith("part:") && m.node) markPart(m);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
  // a marked part scrolled out of sight inside its panel: bring it into view
  setTimeout(() => {
    const m = (glow?.marks || []).find((x) => String(x.widget).startsWith("part:")); // the first one: two would fight
    if (m) partEl(m.node, m.widget.slice(5))?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, 400);
  fit(boxOf(nodes, groups), opts.room || 0);
  nodes.forEach((n) => domEl(n)?.classList.add("va-glow"));
  const mine = glow;
  const tick = () => {
    app.canvas.setDirty(true, true); // the canvas only repaints when asked, so ask every frame while it glows
    if (glow === mine) requestAnimationFrame(tick);
  };
  tick();
}

const st = document.createElement("style");
st.textContent = `@keyframes va-glow{0%,100%{box-shadow:0 0 0 2px ${COLOR}88,0 0 14px ${COLOR}55}50%{box-shadow:0 0 0 3px ${COLOR},0 0 28px ${COLOR}aa}}
.va-glow{animation:va-glow .9s ease-in-out infinite;border-radius:10px}`;
document.head.appendChild(st);
