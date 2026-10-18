/**
 * LC Vision Shot List: the form on the node. A place, the cast (name, man / woman, look) and one card per shot
 * (framing, who it is on, camera move, action, who speaks and the line, what happens after). The rows live in the
 * hidden `shot_list` STRING widget as JSON; Python turns them into the Showrunner's story. Every row is real HTML in
 * one addDOMWidget (same pattern as LC LoRA Loader), so it works on the classic canvas and in Nodes 2.0.
 */
import { app } from "../../scripts/app.js";

const NODE = "LCVisionShotList";
const MIN_W = 560;
const MAX_AUTO = 760; // the form grows to this, then scrolls
const MIN_PANEL = 160; // you can make the node this small; the panel scrolls
const FRAMINGS = ["wide shot", "side view", "two-shot", "medium shot", "close-up", "extreme close-up", "over the shoulder", "from behind", "custom"];
const GROUP = new Set(["wide shot", "side view", "two-shot"]);
const MOVES = ["still", "slow push-in", "slow pull back", "pan", "tracking", "orbit", "handheld"];
const WHO = ["man", "woman", "boy", "girl", "person"];
const LONG_LINE = 22; // about 10 s of speech: the longest segment extend_segments makes

const CSS = `
.lcsl{font:12px Arial,sans-serif;color:#ddd;box-sizing:border-box;padding:6px 8px;display:flex;flex-direction:column;gap:6px}
.lcsl *{box-sizing:border-box}
.lcsl-h{font-weight:700;font-size:12px;color:#eb4;margin-top:4px;display:flex;align-items:center;gap:6px}
.lcsl-h span{flex:1}
.lcsl input,.lcsl select,.lcsl textarea{background:#1e1e1e;color:#ddd;border:1px solid #444;border-radius:4px;padding:3px 5px;font:12px Arial,sans-serif;min-width:0}
.lcsl textarea{resize:vertical;width:100%;font-family:Arial,sans-serif}
.lcsl-row{display:flex;gap:4px;align-items:center}
.lcsl-card{border:1px solid #3a3a3a;border-radius:6px;padding:5px;display:flex;flex-direction:column;gap:4px;background:#262626}
.lcsl-n{font-weight:700;color:#eb4;white-space:nowrap}
.lcsl-b{background:#2f2f2f;color:#ccc;border:1px solid #444;border-radius:4px;cursor:pointer;padding:2px 7px;font:12px Arial,sans-serif}
.lcsl-b:hover{background:#3a3a3a}
.lcsl-b:disabled{opacity:.3;cursor:default}
.lcsl-add{width:100%;padding:4px}
.lcsl-wc{font-size:11px;color:#888;white-space:nowrap;min-width:52px;text-align:right}
.lcsl-wc.long{color:#e77;font-weight:700}
.lcsl-tip{font-size:11px;color:#999}
.lcsl-chip{display:inline-flex;align-items:center;gap:3px;border:1px solid #444;border-radius:10px;padding:1px 7px;cursor:pointer;font-size:11px;color:#bbb;background:#1e1e1e;user-select:none}
.lcsl-chip.on{border-color:#eb4;color:#eb4;background:#3a3220}
.lcsl-refs{display:flex;gap:4px;align-items:center;flex-wrap:wrap}
`;

function ensureStyle() {
  if (document.getElementById("lcsl-style")) return;
  const s = document.createElement("style");
  s.id = "lcsl-style";
  s.textContent = CSS;
  document.head.appendChild(s);
}

const widget = (node, name) => node.widgets?.find((w) => w.name === name);
const words = (t) => (String(t || "").match(/[A-Za-z0-9']+/g) || []).length;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function getData(node) {
  try {
    const d = JSON.parse(widget(node, "shot_list")?.value || "{}");
    return { place: d.place || "", setup: d.setup || "", cast: Array.isArray(d.cast) ? d.cast : [], shots: Array.isArray(d.shots) ? d.shots : [] };
  } catch (_) {
    return { place: "", setup: "", cast: [], shots: [] };
  }
}

function setData(node, data, rerender) {
  const w = widget(node, "shot_list");
  if (w) w.value = JSON.stringify(data);
  if (rerender) render(node);
  fit(node);
  try {
    app.extensionManager?.workflow?.activeWorkflow?.changeTracker?.checkState?.();
  } catch (_) {}
}

function hideJson(node) {
  const w = widget(node, "shot_list");
  if (!w || w._lcHidden) return;
  w._lcHidden = true;
  w.type = "hidden";
  w.computeSize = () => [0, -4];
  try {
    w.hidden = true;
  } catch (_) {}
  if (w.options) w.options.hidden = true;
}

function height(node) {
  const h = node.__lcsl?.inner.offsetHeight || 0;
  // off screen the form is hidden and measures 0: keep the last real height
  if (h > 0) node.__lcslH = Math.ceil(h) + 8;
  return node.__lcslH || 400;
}

function fit(node) {
  if (!node.__lcsl) return;
  requestAnimationFrame(() => {
    if (!node.__lcsl.inner.offsetHeight) return; // hidden: nothing to measure
    // when the content grows (a new row, a longer text), the node grows with it up to MAX_AUTO; past that, or when
    // you make the node smaller, the panel scrolls. A size you set is kept
    const contentH = height(node);
    const grew = contentH > (node.__lcPrevH || 0) + 1;
    node.__lcPrevH = contentH;
    const want = node.computeSize()[1] - Math.min(contentH, MIN_PANEL) + Math.min(contentH, MAX_AUTO);
    if (grew && node.size[1] < want - 0.5) node.setSize([Math.max(node.size[0], MIN_W), want]);
    node.setDirtyCanvas?.(true, true);
  });
}

function ensureFace(node) {
  if (node.__lcsl) return node.__lcsl;
  ensureStyle();
  const wrap = document.createElement("div");
  wrap.style.cssText = "overflow-y:auto;overflow-x:hidden;height:100%;box-sizing:border-box";
  const inner = document.createElement("div");
  inner.className = "lcsl";
  wrap.appendChild(inner);
  // typing in the form must not trigger ComfyUI's shortcuts (Delete, Ctrl+Z on the canvas, etc.)
  wrap.addEventListener("keydown", (e) => e.stopPropagation());
  // names on a Reference Assembler may have changed: refresh the pickers when the pointer comes back
  wrap.addEventListener("mouseenter", () => {
    const key = JSON.stringify(refNames(node));
    if (key !== node.__lcslRefKey) {
      node.__lcslRefKey = key;
      if (!wrap.contains(document.activeElement)) render(node);
    }
  });
  const dom = node.addDOMWidget("lc_shot_list_face", "LC_SHOT_LIST_FACE", wrap, { getMinHeight: () => Math.min(height(node), MIN_PANEL), serialize: false });
  dom.serializeValue = () => undefined;
  node.__lcsl = { wrap, inner };
  // the form grows as people type (textareas, new rows): keep the node tall enough to show all of it
  try {
    new ResizeObserver(() => fit(node)).observe(inner);
  } catch (_) {}
  return node.__lcsl;
}

function opts(list, value, labels = {}) {
  return list.map((v) => `<option value="${esc(v)}"${v === value ? " selected" : ""}>${esc(labels[v] ?? v)}</option>`).join("");
}

/** {cast, settings, props} named on the LC H3 Reference Assemblers in this graph. */
function refNames(node) {
  const out = { cast: new Set(), settings: new Set(), props: new Set() };
  const graphs = [node.graph, app.graph, app.rootGraph].filter(Boolean);
  for (const g of new Set(graphs)) {
    for (const n of g._nodes || []) {
      if (n.type !== "LCH3ReferenceAssembler") continue;
      try {
        for (const it of JSON.parse(n.widgets?.find((w) => w.name === "references")?.value || "{}").items || []) {
          const nm = String(it.name || "").trim();
          if (!nm) continue;
          if (it.on === false) continue;
          if (String(it.role || "").startsWith("cast") || ["face", "full body", "outfit", "voice", "line"].includes(it.role)) out.cast.add(nm);
          else if (it.role === "setting" || it.role === "layout") out.settings.add(nm); // a named layout = a place anchor
          else if (it.role === "prop") out.props.add(nm);
        }
      } catch (_) {}
    }
  }
  return { cast: [...out.cast], settings: [...out.settings], props: [...out.props] };
}

// soft warnings for a shot set to keep rolling (same checks as the Python side)
function rollWarnings(shots, k, names) {
  const cur = shots[k], prev = shots[k - 1];
  if (!k || cur?.join !== "roll" || !prev) return [];
  const out = [];
  const w0 = String(prev.where || "").trim(), w1 = String(cur.where || "").trim();
  if (w0 && w1 && w0.toLowerCase() !== w1.toLowerCase())
    out.push(`⚠️ Keeps rolling from ${w0} to ${w1}. Possible mismatch: fine if the camera follows them there (through a door), otherwise use a cut.`);
  const people = (s) => {
    const text = ["action", "speaker", "after"].map((x) => s[x] || "").join(" ");
    const set = new Set(names.filter((n) => new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(text)));
    if (names.includes(s.subject)) set.add(s.subject);
    return set;
  };
  const a = people(prev), b = people(cur);
  if (a.size && b.size && ![...a].some((n) => b.has(n)))
    out.push("⚠️ Keeps rolling, but nobody from the shot before is in it. Possible mismatch: use a cut unless the camera moves from one to the other.");
  let run = 1;
  while (k - run >= 1 && shots[k - run]?.join === "roll") run++;
  if (run === 4) out.push("💡 The 4th shot in a row that keeps rolling. Long takes drift: a cut every few shots keeps faces and the room steady.");
  return out;
}

function render(node) {
  const face = ensureFace(node);
  const d = getData(node);
  const names = d.cast.map((c) => String(c.name || "").trim()).filter(Boolean);
  const R = refNames(node);
  const hasRefs = R.settings.length || R.props.length;
  const missing = R.cast.filter((n) => !names.includes(n));
  const subjectOpts = (s) => opts(["everyone", ...names], names.includes(s.subject) ? s.subject : "everyone", { everyone: names.length > 1 ? "everyone" : "—" });
  face.inner.innerHTML = `
    <div class="lcsl-h"><span>📍 Place</span><button class="lcsl-b" data-clear data-tour="🧹 Clear" title="Empty the whole shot list for a new project (the Reference Assembler keeps its pictures)" style="flex:0;white-space:nowrap">🧹 Clear</button></div>
    <textarea rows="2" data-k="place" data-tour="📍 Place" placeholder="Where it happens and what is there: the room, the props, the light">${esc(d.place)}</textarea>
    <div class="lcsl-h" data-tour="🎭 Cast"><span>🎭 Cast</span></div>
    ${d.cast.map((c, i) => `<div class="lcsl-row">
        <input data-c="${i}" data-f="name" value="${esc(c.name)}" placeholder="Name" style="width:90px">
        <select data-c="${i}" data-f="who" title="Man, woman, etc. The nodes use it to tell people apart">${opts(WHO, c.who || "man")}</select>
        <input data-c="${i}" data-f="look" value="${esc(c.look)}" placeholder="in his forties with short dark hair and a navy sweater" style="flex:1">
        <button class="lcsl-b" data-del-c="${i}" title="Remove this person">×</button></div>`).join("")}
    <button class="lcsl-b lcsl-add" data-add="cast" data-tour="➕ Add person">➕ Add person</button>
    ${missing.length ? `<div class="lcsl-row lcsl-tip">🖼️ Reference pictures but not in the cast: ${missing.map((n) => `<button class="lcsl-b" data-add-ref="${esc(n)}" title="Add ${esc(n)} to the cast">➕ ${esc(n)}</button>`).join(" ")}</div>` : ""}
    <input data-k="setup" data-tour="what they are doing together" value="${esc(d.setup)}" placeholder="What they are doing together, e.g. sit across from each other" title="Finishes the cast sentence">
    <div class="lcsl-h"><span>🎬 Shots</span><span class="lcsl-tip" style="flex:0;white-space:nowrap;font-weight:400">one short line per shot</span></div>
    ${d.shots.map((s, i) => {
      const group = GROUP.has(s.framing || "wide shot");
      const wc = words(s.line);
      const tt = (what) => (i === (what === "✂ cut / 🎞 keep rolling" ? 1 : 0) ? ` data-tour="shot · ${what}"` : ""); // named once
      return `<div class="lcsl-card" data-tour="shot ${i + 1}">
        <div class="lcsl-row">
          <span class="lcsl-n">${i + 1}</span>
          <select data-s="${i}" data-f="framing"${tt("framing")} title="How the shot is framed">${opts(FRAMINGS, s.framing || "wide shot")}</select>
          <select data-s="${i}" data-f="subject"${tt("who")} title="Who the shot is on" ${group && names.length > 1 && (s.subject || "everyone") === "everyone" ? "" : ""}>${subjectOpts(s)}</select>
          <select data-s="${i}" data-f="move"${tt("camera move")} title="Camera move">${opts(MOVES, s.move || "still")}</select>
          ${i ? `<select data-s="${i}" data-f="join"${tt("✂ cut / 🎞 keep rolling")} title="How this shot starts. cut: a new shot. keep rolling: no cut, the camera carries straight on from the shot before and moves to this framing (one take)">${opts(["cut", "roll"], s.join === "roll" ? "roll" : "cut", { cut: "✂ cut", roll: "🎞 keep rolling" })}</select>` : ""}
          <span style="flex:1"></span>
          <button class="lcsl-b" data-mv="${i}|-1" title="Move up" ${i ? "" : "disabled"}>↑</button>
          <button class="lcsl-b" data-mv="${i}|1" title="Move down" ${i < d.shots.length - 1 ? "" : "disabled"}>↓</button>
          <button class="lcsl-b" data-del-s="${i}" title="Remove this shot">×</button>
        </div>
        <textarea rows="2" data-s="${i}" data-f="action"${tt("what happens")} placeholder="What happens (before the line)">${esc(s.action)}</textarea>
        <div class="lcsl-row">
          <select data-s="${i}" data-f="speaker"${tt("who says the line")} title="Who says the line" style="width:96px">${opts(["", ...names], s.speaker || "", { "": "no line" })}</select>
          <input data-s="${i}" data-f="line"${tt("the line")} value="${esc(s.line)}" placeholder="The line, word for word" style="flex:1">
          <span class="lcsl-wc${wc > LONG_LINE ? " long" : ""}" data-wc="${i}">${wc ? `${wc} words` : ""}</span>
        </div>
        <input data-s="${i}" data-f="after"${tt("after the line")} value="${esc(s.after)}" placeholder="What happens after the line (optional)">
        ${rollWarnings(d.shots, i, names).map((w) => `<div class="lcsl-tip" style="color:${w.startsWith("💡") ? "#9fd3ff" : "#ffd860"}">${esc(w)}</div>`).join("")}
        ${hasRefs ? `<div class="lcsl-refs">
          ${R.settings.length ? `<span class="lcsl-tip">📍</span><select data-s="${i}" data-f="where"${tt("📍 where")} title="Where this shot is (a setting from the Reference Assembler). Said in the story when it changes.">${opts(["", ...R.settings], s.where || "", { "": i ? "same place" : "setting…" })}</select>` : ""}
          ${R.props.map((pr) => `<span class="lcsl-chip${(s.props || []).includes(pr) ? " on" : ""}" data-prop="${i}|${esc(pr)}" title="In this shot: the Segment sends this prop's picture">${esc(pr)}</span>`).join("")}
        </div>` : ""}
      </div>`;
    }).join("")}
    <button class="lcsl-b lcsl-add" data-add="shot" data-tour="➕ Add shot">➕ Add shot</button>`;

  const q = (sel) => face.wrap.querySelectorAll(sel);
  const save = (re) => setData(node, d, re);
  q("[data-k]").forEach((el) => (el.oninput = () => {
    d[el.dataset.k] = el.value;
    save(false);
  }));
  q("[data-c]").forEach((el) => {
    const i = Number(el.dataset.c);
    el.oninput = () => {
      d.cast[i][el.dataset.f] = el.value;
      save(false);
    };
    // a new or renamed person shows up in the shots' dropdowns
    if (el.dataset.f === "name") el.onchange = () => save(true);
  });
  q("[data-s]").forEach((el) => {
    const i = Number(el.dataset.s);
    const f = el.dataset.f;
    const set = () => {
      d.shots[i][f] = el.value;
      if (f === "line") {
        const wc = words(el.value);
        const tag = face.wrap.querySelector(`[data-wc="${i}"]`);
        if (tag) {
          tag.textContent = wc ? `${wc} words` : "";
          tag.classList.toggle("long", wc > LONG_LINE);
          tag.title = wc > LONG_LINE ? "About 22 words fits the longest segment (10 s). Shorten it or split it over two shots." : "";
        }
        // a line with nobody picked: the one person, or the person the shot is on
        if (el.value && !d.shots[i].speaker) {
          const pick = names.length === 1 ? names[0] : names.includes(d.shots[i].subject) ? d.shots[i].subject : "";
          if (pick) {
            d.shots[i].speaker = pick;
            const sp = face.wrap.querySelector(`[data-s="${i}"][data-f="speaker"]`);
            if (sp) sp.value = pick;
          }
        }
      }
      // a close-up of someone: they are the one who speaks, unless you picked otherwise
      if (f === "subject" && names.includes(el.value) && d.shots[i].line && !d.shots[i].speaker) d.shots[i].speaker = el.value;
      save(el.tagName === "SELECT" && f !== "move");
    };
    el.oninput = el.tagName === "SELECT" ? null : set;
    el.onchange = el.tagName === "SELECT" ? set : null;
  });
  q("[data-del-c]").forEach((b) => (b.onclick = () => {
    d.cast.splice(Number(b.dataset.delC), 1);
    save(true);
  }));
  q("[data-del-s]").forEach((b) => (b.onclick = () => {
    d.shots.splice(Number(b.dataset.delS), 1);
    save(true);
  }));
  q("[data-mv]").forEach((b) => (b.onclick = () => {
    const [i, dir] = b.dataset.mv.split("|").map(Number);
    const [s] = d.shots.splice(i, 1);
    d.shots.splice(i + dir, 0, s);
    save(true);
  }));
  q("[data-prop]").forEach((c) => (c.onclick = () => {
    const [i, ...rest] = c.dataset.prop.split("|");
    const pr = rest.join("|");
    const sh = d.shots[Number(i)];
    sh.props = Array.isArray(sh.props) ? sh.props : [];
    sh.props = sh.props.includes(pr) ? sh.props.filter((x) => x !== pr) : [...sh.props, pr];
    save(true);
  }));
  q("[data-add-ref]").forEach((b) => (b.onclick = () => {
    d.cast.push({ name: b.dataset.addRef, who: "woman", look: "" });
    save(true);
  }));
  q("[data-clear]").forEach((b) => (b.onclick = () => {
    if (b.dataset.sure !== "1") {
      b.dataset.sure = "1";
      b.textContent = "Clear it all?";
      setTimeout(() => { if (b.isConnected) { b.dataset.sure = ""; b.textContent = "🧹 Clear"; } }, 3000);
      return;
    }
    setData(node, { place: "", setup: "", cast: [], shots: [] }, true);
  }));
  q("[data-add]").forEach((b) => (b.onclick = () => {
    if (b.dataset.add === "cast") d.cast.push({ name: "", who: d.cast.length % 2 ? "woman" : "man", look: "" });
    else {
      const prev = d.shots[d.shots.length - 1];
      d.shots.push({ framing: "close-up", subject: names[0] || "everyone", move: "still", action: "", speaker: "", line: "", after: "", ...(prev ? {} : { framing: "wide shot", subject: "everyone" }) });
    }
    save(true);
    const last = b.dataset.add === "cast" ? face.wrap.querySelector(`[data-c="${d.cast.length - 1}"][data-f="name"]`)
      : face.wrap.querySelector(`[data-s="${d.shots.length - 1}"][data-f="action"]`);
    last?.focus();
  }));
  fit(node);
}

app.registerExtension({
  name: "LC.Vision.ShotList",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE) return;
    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);
      hideJson(this);
      render(this);
      if (!this.size || this.size[0] < MIN_W) this.setSize([MIN_W, this.computeSize()[1]]);
      return r;
    };
    // never override configure() and never touch node.pos: the default restore path (position, size and the
    // hidden shot_list value) runs untouched
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onConfigure?.apply(this, arguments);
      hideJson(this);
      render(this);
      return r;
    };
    const getExtra = nodeType.prototype.getExtraMenuOptions;
    nodeType.prototype.getExtraMenuOptions = function () {
      getExtra?.apply(this, arguments);
      const node = this;
      arguments[1]?.push({ content: "Clear the shot list", callback: () => setData(node, { place: "", setup: "", cast: [], shots: [] }, true) });
    };
  },
});
