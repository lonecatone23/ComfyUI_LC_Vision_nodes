// Swap for LC nodes: nodes from other packs that have an LC twin doing the same job. The checkup lists them first;
// you tick the ones to swap. Values carry over by name (with the renames below), every wire is reconnected by socket
// name, and the new node takes the old one's place. A node is only offered when every wired socket has a home on
// the LC node. Idea from AusBoss's "Replace with AusBoss nodes" (ComfyUI-AusBoss, MIT); written from scratch.
import { app } from "../../../scripts/app.js";

// from: other pack's node type. to: LC node type. names: old socket/setting name -> LC name (both inputs and
// outputs; unlisted names stay the same). set(old, values): extra LC settings worked out from the old node.
export const SWAPS = [
  // -1 is "random every run" in both; rgthree's -2 / -3 (increment / decrement) have no LC twin, so they become random too
  { from: "Seed (rgthree)", to: "LCSeed", names: { seed: "base_seed", SEED: "seed" }, set: (old) => (Number(old.widgets?.find((w) => w.name === "seed")?.value) < 0 ? { base_seed: -1 } : {}) },
  { from: "CR Seed", to: "LCSeed", names: { seed: "base_seed" } },
  { from: "easy seed", to: "LCSeed", names: { seed: "base_seed" } },
  { from: "Display Any (rgthree)", to: "LCShowAny", names: { source: "any" } },
  { from: "easy showAnything", to: "LCShowAny", names: { anything: "any" } },
  { from: "ShowText|pysssss", to: "LCShowText", names: { STRING: "text" } },
  { from: "Image Comparer (rgthree)", to: "LCBatchImageComparer", names: {} },
  { from: "JoinStrings", to: "LCJoinStrings", names: { string1: "string_1", string2: "string_2", STRING: "string" }, set: () => ({ inputcount: 2 }) },
  { from: "JoinStringMulti", to: "LCJoinStrings", names: {}, drop: ["return_list"] },
  { from: "CR Text Concatenate", to: "LCJoinStrings", names: { text1: "string_1", text2: "string_2", separator: "delimiter", STRING: "string" }, set: () => ({ inputcount: 2 }) },
  {
    from: "Text Concatenate", to: "LCJoinStrings", drop: ["clean_whitespace"],
    names: Object.fromEntries([..."abcdefghijklmnopqrstuvwx"].map((c, i) => [`text_${c}`, `string_${i + 1}`]).concat([["STRING", "string"]])),
    set: (old) => ({ inputcount: Math.max(2, ...(old.inputs || []).filter((i) => i.link != null && /^text_[a-x]$/.test(i.name)).map((i) => i.name.charCodeAt(5) - 96)) }),
  },
  {
    from: "ImageBatchMulti", to: "LCBatchImage", drop: ["inputcount"],
    names: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`image_${i + 1}`, `image_${String(i + 1).padStart(2, "0")}`]).concat([["images", "image"]])),
  },
  { from: "StringConstantMultiline", to: "LCPositive", names: { string: "positive", STRING: "positive" }, drop: ["strip_newlines"] },
  { from: "CR Text", to: "LCPositive", names: { text: "positive" } },
  { from: "Text Multiline", to: "LCPositive", names: { text: "positive", STRING: "positive" }, drop: ["dynamic_prompts"] },
  { from: "CR Apply LoRA Stack", to: "LCApplyLoraStack", names: { MODEL: "model", CLIP: "clip" } },
  { from: "GetImageSizeAndCount", to: "LCGetImage", names: { count: "batch" } },
  // Pixaroma (MIT): some settings live in node properties, not widgets
  { from: "PixaromaSeed", to: "LCSeed", names: {}, missingOk: true, set: (old) => { const st = pixState(old, "seedState"); return { base_seed: (st.mode || "random") === "random" ? -1 : Number(st.seed) || 0 }; } },
  { from: "PixaromaShowText", to: "LCShowAny", names: { source: "any", text: "any" }, missingOk: true },
  { from: "PixaromaText", to: "LCPositive", names: { text: "positive" } },
  ...[2, 3, 4].map((n) => ({
    from: `PixaromaTextJoin${["", "", "Two", "Three", "Four"][n]}`, to: "LCJoinStrings",
    names: { ...Object.fromEntries(Array.from({ length: n }, (_, i) => [`text_${i + 1}`, `string_${i + 1}`])), text: "string" },
    set: (old) => ({ inputcount: n, delimiter: pixSep(pixState(old, "textJoinState")) }),
  })),
  // Note Pixaroma (rich HTML) -> LC Note (markdown). Works with or without Pixaroma installed: the HTML sits in note_json.
  { from: "PixaromaNote", to: "LCNote", frontend: true, missingOk: true, convert: pixNoteToLC },
  { from: "PixaromaCompare", to: "LCBatchImageComparer", names: { image1: "image_a", image2: "image_b" }, missingOk: true },
];

// Pixaroma keeps state as JSON in node.properties
function pixState(node, prop) {
  const v = node.properties?.[prop];
  if (v && typeof v === "object") return v;
  try {
    return JSON.parse(v || "{}") || {};
  } catch (_) {
    return {};
  }
}
const pixSep = (st) => (st.sep === "custom" ? String(st.customSep ?? "") : { space: " ", newline: "\n", none: "" }[st.sep] ?? ", ");

const registered = (t) => !!LiteGraph.registered_node_types?.[t];
export const titleOf = (t) => LiteGraph.registered_node_types?.[t]?.nodeData?.display_name || LiteGraph.registered_node_types?.[t]?.title || t;

function allGraphs() {
  const root = app.rootGraph || app.graph;
  const subs = root?.subgraphs ? [...root.subgraphs.values()] : [];
  return [root, ...subs].filter(Boolean);
}

// the LC node's sockets and settings, read from its definition (no node is created to find out)
function defOf(t) {
  const d = LiteGraph.registered_node_types?.[t]?.nodeData;
  if (!d) return null;
  const inputs = new Set([...Object.keys(d.input?.required || {}), ...Object.keys(d.input?.optional || {})]);
  const outputs = d.output_name || d.output || [];
  return { inputs, outputs, types: d.output || [] };
}

const sel = (sw, name) => sw.names?.[name] ?? name;

// A text box that feeds a negative prompt becomes LC Negative, not Prompt (LCPositive): follow its wires a few steps
// (text box -> CLIP Text Encode -> the sampler's negative). Only when a negative is found and no positive.
function feedsNegative(node) {
  const graph = node.graph || app.graph;
  let neg = false, pos = false;
  const seen = new Set();
  const walk = (n, depth) => {
    if (!n || depth > 4 || seen.has(n.id)) return;
    seen.add(n.id);
    for (const o of n.outputs || []) {
      for (const id of o.links || []) {
        const l = graph.links?.get?.(id) ?? graph.links?.[id];
        const t = l && graph.getNodeById(l.target_id);
        const name = String(t?.inputs?.[l.target_slot]?.name || "");
        if (/negative|^neg$/i.test(name)) neg = true;
        else if (/positive|^pos$/i.test(name)) pos = true;
        walk(t, depth + 1);
      }
    }
  };
  walk(node, 0);
  return neg && !pos;
}

/** The swap for this node: Prompt by default, LC Negative when the box feeds a negative prompt. */
function swapFor(node, sw) {
  if (sw.to !== "LCPositive" || !feedsNegative(node)) return sw;
  const names = Object.fromEntries(Object.entries(sw.names || {}).map(([k, v]) => [k, v === "positive" ? "negative" : v]));
  return { ...sw, to: "LCNegative", names };
}

// A title someone typed stays on the LC node; the old node's own default title doesn't.
function customTitle(old) {
  const defaults = new Set([old.type, titleOf(old.type), old.constructor?.title, LiteGraph.registered_node_types?.[old.type]?.title].filter(Boolean));
  return old.title && !defaults.has(old.title) ? old.title : null;
}

/** Can this node be swapped? Returns {ok, why, drops}. Every wired socket needs a home on the LC node. */
export function plan(node, sw) {
  if (sw.frontend) return registered(sw.to) ? { ok: true, drops: [] } : { ok: false, why: `${titleOf(sw.to)} isn't installed` };
  const def = defOf(sw.to);
  if (!def) return { ok: false, why: `${titleOf(sw.to)} isn't installed` };
  // a node whose pack is missing has no readable settings: only swap it when it holds none worth keeping
  if (!registered(node.type) && !sw.missingOk) return { ok: false, why: "its pack isn't installed, so its settings can't be read" };
  for (const inp of node.inputs || []) {
    if (inp.link == null) continue;
    const to = sel(sw, inp.name);
    if (!def.inputs.has(to)) return { ok: false, why: `its ${inp.name} input has no match` };
  }
  for (const out of node.outputs || []) {
    if (!out.links?.length) continue;
    const to = sel(sw, out.name);
    if (!def.outputs.includes(to)) return { ok: false, why: `its ${out.name} output has no match` };
  }
  const drops = (node.widgets || []).filter((w) => sw.drop?.includes(w.name)).map((w) => w.name);
  return { ok: true, drops };
}

/** Every node in the workflow (subgraphs too) that has an LC twin, grouped by type. */
export function find() {
  const groups = new Map();
  for (const g of allGraphs()) {
    for (const n of g._nodes || []) {
      const base = SWAPS.find((s) => s.from === n.type);
      if (!base) continue;
      const sw = swapFor(n, base);
      if (!registered(sw.to)) continue;
      const p = plan(n, sw);
      if (!groups.has(base.from)) groups.set(base.from, { sw: base, nodes: [], blocked: [], drops: new Set(), targets: new Set() });
      const grp = groups.get(base.from);
      if (p.ok) {
        grp.nodes.push(n);
        grp.targets.add(sw.to);
        p.drops.forEach((d) => grp.drops.add(d));
      } else grp.blocked.push({ node: n, why: p.why });
    }
  }
  return [...groups.values()];
}

function valid(w, v) {
  const opts = w.options?.values;
  if (Array.isArray(opts)) return opts.includes(v);
  return v !== undefined;
}

/** Replace one node with its LC twin. Returns the new node, or null. */
export function swapNode(old, base) {
  const sw = swapFor(old, base);
  const graph = old.graph || app.graph;
  const title = customTitle(old);
  const fresh = LiteGraph.createNode(sw.to);
  if (!fresh) return null;
  // what the old node holds, before it goes
  const values = {};
  // buttons hold no value, and pressing one (rgthree's and LC's "🎲 New Fixed Random") would change the settings
  for (const w of old.widgets || []) if (w.name && w.type !== "button" && !sw.drop?.includes(w.name)) values[sel(sw, w.name)] = w.value;
  Object.assign(values, sw.set?.(old) || {});
  const ins = (old.inputs || []).filter((i) => i.link != null).map((i) => {
    const l = graph.links?.get?.(i.link) ?? graph.links?.[i.link];
    return l && { to: sel(sw, i.name), from: graph.getNodeById(l.origin_id), slot: l.origin_slot };
  }).filter(Boolean);
  const outs = [];
  (old.outputs || []).forEach((o) => {
    for (const id of o.links || []) {
      const l = graph.links?.get?.(id) ?? graph.links?.[id];
      if (l) outs.push({ from: sel(sw, o.name), node: graph.getNodeById(l.target_id), slot: l.target_slot });
    }
  });
  const pos = [...old.pos], mode = old.mode, size = old.size ? [...old.size] : null;
  const converted = sw.convert ? sw.convert(old) : null; // read before the old node goes
  graph.remove(old);
  fresh.pos = pos;
  fresh.mode = mode;
  graph.add(fresh);
  if (title) fresh.title = title;
  if (converted) {
    converted.apply(fresh);
    if (size) fresh.setSize?.([Math.max(size[0], 300), Math.max(size[1], 200)]);
    return fresh;
  }
  // sizing settings first (inputcount makes the extra sockets), then the rest
  const order = Object.keys(values).sort((a, b) => (b === "inputcount") - (a === "inputcount"));
  for (const name of order) {
    const w = fresh.widgets?.find((x) => x.name === name);
    if (!w || w.type === "button" || !valid(w, values[name])) continue;
    w.value = values[name];
    try {
      w.callback?.(w.value, app.canvas, fresh);
    } catch (_) {}
  }
  for (const c of ins) {
    const slot = fresh.findInputSlot?.(c.to) ?? fresh.inputs?.findIndex((i) => i.name === c.to);
    if (c.from && slot >= 0) c.from.connect(c.slot, fresh, slot);
  }
  for (const c of outs) {
    const slot = fresh.findOutputSlot?.(c.from) ?? fresh.outputs?.findIndex((o) => o.name === c.from);
    if (c.node && slot >= 0) fresh.connect(slot, c.node, c.slot);
  }
  const min = fresh.computeSize?.() || fresh.size;
  if (size) fresh.setSize?.([Math.max(size[0], min[0]), Math.max(min[1], fresh.size[1])]);
  return fresh;
}

/** Swap every node of the ticked types. Returns how many were swapped. */
export function swapTypes(types) {
  let done = 0;
  for (const grp of find()) {
    if (!types.includes(grp.sw.from)) continue;
    for (const n of grp.nodes) if (swapNode(n, grp.sw)) done++;
  }
  (app.rootGraph || app.graph).setDirtyCanvas?.(true, true);
  try {
    app.extensionManager?.workflow?.activeWorkflow?.changeTracker?.checkState?.();
  } catch (_) {}
  return done;
}

// ------------------------------------------------------------------ Note Pixaroma -> LC Note
const PIX_ICONS = {
  GGUF: "`GGUF`", CLIP: "`CLIP`", LORA: "`LoRA`", VAE: "`VAE`", file: "📄", data: "📄", "folder-v1": "📂", "folder-v2": "📂",
  "arrow-up": "⬆️", "arrow-down": "⬇️", "arrow-left": "⬅️", "arrow-right": "➡️", "ai-brain": "🧠", box: "📦", chip: "💾",
  checkmark: "✅", gear: "⚙️", plus: "➕", puzzle: "🧩", question: "❓", "warning-v1": "⚠️", "warning-v2": "⚠️",
  github: "", huggingface: "🤗", pixaroma: "", "nodes-installed": "🧩",
};
const pixIcon = (slug) => PIX_ICONS[slug] ?? (/^(model|checkpoint)/.test(slug) ? "🧠" : /^node/.test(slug) ? "🧩" : /^workflow/.test(slug) ? "🔀" : "");

/** Pixaroma's note HTML as markdown. Colours and styling go; words, structure, links and folders stay. */
export function pixHtmlToMarkdown(html) {
  const doc = new DOMParser().parseFromString(`<div>${html || ""}</div>`, "text/html");
  const clean = (t) => t.replace(/\u00a0/g, " ");
  const inline = (n) => {
    if (n.nodeType === 3) return clean(n.textContent).replace(/\s+/g, " "); // HTML whitespace collapses, as in a browser
    if (n.nodeType !== 1) return "";
    const tag = n.tagName.toLowerCase(), cls = n.classList;
    const kids = () => [...n.childNodes].map(inline).join("");
    if (cls.contains("pix-note-ic")) return pixIcon(n.dataset.ic || "");
    if (cls.contains("pix-note-btnsize")) return "";
    if (tag === "br") return "\n";
    if (tag === "b" || tag === "strong") { const k = kids().trim(); return k ? `**${k}**` : ""; }
    if (tag === "i" || tag === "em") { const k = kids().trim(); return k ? `*${k}*` : ""; }
    if (tag === "s" || tag === "strike") { const k = kids().trim(); return k ? `~~${k}~~` : ""; }
    if (tag === "code") return "`" + n.textContent + "`";
    if (tag === "a") {
      const href = /^(https?:|mailto:)/i.test(n.getAttribute("href") || "") ? n.getAttribute("href") : "";
      const size = n.querySelector(".pix-note-btnsize")?.textContent.trim();
      const label = kids().trim() + (size ? ` · ${size}` : "");
      if (!href) return label;
      if (cls.contains("pix-note-dl")) return `\n@[download: ${label.replace(/[[\]|]/g, " ")}](${href})\n`; // LC Note's download button
      if (cls.contains("pix-note-yt") || cls.contains("pix-note-discord") || cls.contains("pix-note-vp") || cls.contains("pix-note-rm"))
        return `\n@[card: ${label}](${href})\n`; // a link card on a line of its own
      return `[${label}](${href})`;
    }
    if (cls.contains("pix-note-folderhint")) return `\n📂 \`${n.textContent.replace(/^\s*Place in:\s*/i, "").trim()}\`\n`;
    return kids();
  };
  const out = [];
  const block = (n, depth = 0) => {
    if (n.nodeType === 3) { const t = clean(n.textContent).trim(); if (t) out.push(t); return; }
    if (n.nodeType !== 1) return;
    const tag = n.tagName.toLowerCase(), cls = n.classList;
    const text = () => inline(n).replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    if (/^h[1-3]$/.test(tag)) { const t = text(); if (t) out.push(`${"#".repeat(Number(tag[1]))} ${t}`); return; }
    if (tag === "hr") { out.push("---"); return; }
    if (tag === "pre") { out.push("```\n" + n.textContent.replace(/\n$/, "") + "\n```"); return; }
    if (tag === "blockquote") { const t = text(); if (t) out.push(t.split("\n").map((l) => `> ${l}`).join("\n")); return; }
    if (tag === "ul" || tag === "ol") {
      let i = 1;
      const lines = [];
      for (const li of n.children) {
        if (li.tagName.toLowerCase() !== "li") continue;
        const own = [...li.childNodes].filter((c) => !(c.nodeType === 1 && /^(ul|ol)$/i.test(c.tagName))).map(inline).join("").trim();
        lines.push(`${"  ".repeat(depth)}${tag === "ol" ? `${i++}.` : "-"} ${own}`);
        for (const sub of li.children) if (/^(ul|ol)$/i.test(sub.tagName)) { const before = out.length; block(sub, depth + 1); lines.push(...out.splice(before)); }
      }
      out.push(lines.join("\n"));
      return;
    }
    if (tag === "table") {
      const rows = [...n.querySelectorAll("tr")].map((tr) => [...tr.children].map((c) => inline(c).replace(/\|/g, String.fromCharCode(92) + "|").replace(/\n/g, " ").trim()));
      if (!rows.length) return;
      const w = Math.max(...rows.map((r) => r.length));
      const pad = (r) => [...r, ...Array(w - r.length).fill("")];
      out.push([`| ${pad(rows[0]).join(" | ")} |`, `|${" --- |".repeat(w)}`, ...rows.slice(1).map((r) => `| ${pad(r).join(" | ")} |`)].join("\n"));
      return;
    }
    if (cls.contains("pix-note-folderhint")) { out.push(text()); return; }
    // a div holding blocks: walk into it; otherwise it's a paragraph
    if ((tag === "div" || tag === "span") && [...n.children].some((c) => /^(p|div|h[1-3]|ul|ol|pre|hr|table|blockquote)$/i.test(c.tagName))) {
      for (const c of n.childNodes) block(c, depth);
      return;
    }
    const t = text();
    if (t) out.push(t);
  };
  for (const c of doc.body.firstChild.childNodes) block(c);
  return out.join("\n\n").replace(/\n{3,}/g, "\n\n")
    // a download button followed by its folder line becomes one button with "Place in" under it
    .replace(/@\[download: ([^\]]*)\]\(([^)]+)\)\s*\n+📂 `([^`]+)`/g, (_, label, href, folder) => `@[download: ${label} | ${folder}](${href})`)
    .trim();
}

function pixNoteToLC(old) {
  const raw = old.widgets?.find((w) => w.name === "note_json")?.value ?? old.widgets_values?.[0] ?? "";
  let cfg = {};
  try {
    cfg = typeof raw === "string" ? JSON.parse(raw || "{}") : raw || {};
  } catch (_) {
    cfg = { content: String(raw) };
  }
  const md = pixHtmlToMarkdown(cfg.content || "");
  const title = old.title && old.title !== "Note Pixaroma" && old.title !== old.constructor?.title ? old.title : "";
  return {
    apply(fresh) {
      const d = fresh.properties?.lc_note;
      if (d?.texts) {
        d.texts[d.source] = { ...(d.texts[d.source] || {}), text: md };
      }
      if (fresh._lcText) fresh._lcText.value = md;
      if (title) fresh.title = title;
    },
  };
}
