// Vision Assistant checkup: plain rules over the open workflow and this machine. No AI involved; the chat explains and
// acts on these. Each check returns cards: {level, title, text, actions:[{label, tip, run | href}], nodeId}.
// level: 3 = problem, 1 = worth changing, 0 = info.
import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { REPLACEMENTS } from "./va_replacements.js";
import * as swap from "./va_swap.js";
import { highlight } from "./va_glow.js";

// ------------------------------------------------------------------ gated models (license first: BFL's FLUX, Meta's SAM 3 and Llama)
const GATES = new Map();
/** Is this Hugging Face repo gated, and does this computer's login have access? Asked once per repo per checkup run. */
export async function hfGate(repo, refresh = false) {
  if (!repo) return null;
  if (!refresh && GATES.has(repo)) return GATES.get(repo);
  const p = api.fetchApi(`/lc_vision/hf_gate?repo=${encodeURIComponent(repo)}${refresh ? "&refresh=1" : ""}`)
    .then((r) => (r.status === 200 ? r.json() : null)).catch(() => null);
  GATES.set(repo, p);
  return p;
}

/** The steps for a gated repo this computer can't download yet: accept (or request), then log in. */
export function gateSteps(g) {
  const lic = g.license ? ` (${g.license})` : "";
  const ask = g.mode === "manual"
    ? `${g.repo} is gated by its owner${lic}. They approve each request by hand: open the page, sign in, fill in the request and wait for the approval email. That can take a while.`
    : `${g.repo} is gated${lic}: open the page, sign in to Hugging Face and click "Agree and access repository". Access is instant.`;
  const login = g.has_token
    ? " This computer is already logged in to Hugging Face, so it downloads as soon as you have access."
    : ` Then log ComfyUI in to Hugging Face: make a Read token, run ${g.login_cmd} in your ComfyUI folder and paste it. Never share your token or put it in a workflow.`;
  return ask + login;
}

export function gateActions(g) {
  return [
    { label: g.mode === "manual" ? "Request access" : "Accept the license", tip: `Opens ${g.repo} on Hugging Face`, href: g.page_url },
    ...(!g.has_token ? [{ label: "Make a token", tip: "Hugging Face > Settings > Access Tokens (Read is enough)", href: g.token_url }] : []),
    ...(g.license_url ? [{ label: "Read the license", href: g.license_url }] : []),
  ];
}

/** Turn a "Missing" card into a gated one when its repo needs the license, or say access is already there. */
function applyGate(card, g) {
  if (!g || !g.gated) return;
  if (g.access === true) {
    card.text += " ✅ It's gated, and this computer already has access, so it downloads like any other file.";
    return;
  }
  card.level = 3;
  card.title = `🔒 ${card.title} (license first)`;
  card.text = card.text.replace(/ You can get it here:$/, "") + " " + gateSteps(g);
  card.actions = gateActions(g);
}
import { findDamage, repair } from "./va_corrupt.js";

let KNOW = null;
let SYS = null; // {gpu, vram, gen, comfy}
let PROFILE = undefined; // LC123 system report (null = none yet, undefined = not asked)
let lastError = null;

export async function knowledge() {
  if (!KNOW) {
    try {
      KNOW = await (await fetch(new URL("./va_knowledge.json", import.meta.url), { cache: "no-cache" })).json(); // a pack update brings new models
    } catch (_) {
      KNOW = { families: [] };
    }
  }
  return KNOW;
}

export const hasLC123 = () => !!LiteGraph.registered_node_types?.LCOptimizer;
const nodes = () => app.graph?._nodes || [];
// Nodes inside subgraphs are checked too. host = the subgraph node on the canvas that holds them.
const HOST = new WeakMap();
function allNodes() {
  const out = [];
  const walk = (list, host, depth) => {
    for (const n of list) {
      if (host) HOST.set(n, host);
      out.push(n);
      const inner = n.subgraph?._nodes || n.subgraph?.nodes;
      if (inner && depth < 4) walk(inner, host || n, depth + 1);
    }
  };
  walk(nodes(), null, 0);
  return out;
}
const hostOf = (n) => HOST.get(n) || null;
const where = (n) => hostOf(n)?.id ?? n.id; // what "Show node" jumps to
const baseLabel = (n) => (n.title && n.title !== n.type ? n.title : (n.constructor?.title || n.type));
const label = (n) => (hostOf(n) ? `${baseLabel(n)} (inside "${baseLabel(hostOf(n))}")` : baseLabel(n));
const typeTitle = (t) => LiteGraph.registered_node_types?.[t]?.title || t;
const base = (f) => String(f || "").split(/[\\/]/).pop();
const active = (n) => n.mode !== 2 && n.mode !== 4;

// ------------------------------------------------------------------ machine
function gpuGen(name) {
  const s = String(name || "");
  if (/RTX\s*50|Blackwell|B200|GB20/i.test(s)) return "blackwell";
  if (/RTX\s*40|Ada|L40|RTX\s*\d000 Ada/i.test(s)) return "ada";
  if (/RTX\s*30|A\d{3,4}\b|Ampere/i.test(s)) return "ampere";
  if (/RTX\s*20|GTX\s*16|Turing/i.test(s)) return "turing";
  if (/GTX|Pascal/i.test(s)) return "pascal";
  if (/Radeon|AMD/i.test(s)) return "amd";
  if (/Apple|mps/i.test(s)) return "apple";
  return "other";
}

export async function system(refresh = false) {
  if (SYS && !refresh) return SYS;
  try {
    const s = await (await api.fetchApi("/system_stats")).json();
    const d = (s.devices || []).find((x) => x.type !== "cpu") || (s.devices || [])[0] || {};
    const name = String(d.name || "").replace(/^cuda:\d+\s*/, "").replace(/\s*:\s*cudaMallocAsync$/, "");
    SYS = { gpu: name || "unknown GPU", vram: (d.vram_total || 0) / 1024 ** 3, ram: (s.system?.ram_total || 0) / 1024 ** 3, gen: gpuGen(name), comfy: s.system?.comfyui_version };
  } catch (_) {
    SYS = { gpu: "unknown GPU", vram: 0, gen: "other" };
  }
  return SYS;
}

export async function report(refresh = false) {
  if (PROFILE !== undefined && !refresh) return PROFILE;
  if (!hasLC123()) return (PROFILE = null);
  try {
    const r = await api.fetchApi("/lc123/syscheck/profile");
    PROFILE = r.status === 200 ? await r.json() : null;
  } catch (_) {
    PROFILE = null;
  }
  return PROFILE;
}

export async function runReport() {
  const r = await api.fetchApi("/lc123/syscheck/run");
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  PROFILE = j;
  return j;
}

// ------------------------------------------------------------------ what model is this workflow using
const FAMILY_HINTS = [
  [/krea.?2|krealism|animosity_krea/i, "krea2"], [/anima/i, "anima"], [/klein/i, "flux2_klein_9b"],
  [/qwen.?image.?2\.?1|qwen21/i, "qwen_image_21"], [/z.?image|zit/i, "z_image_turbo"], [/ltx.?2\.?5/i, "ltx25"],
  [/ltx.?2\.?3/i, "ltx23"], [/minimax|_h3_/i, "minimax_h3"], [/ideogram/i, "ideogram4"],
  [/illustrious|ilxl|noob/i, "illustrious"], [/pony/i, "pony"], [/sdxl|_xl/i, "sdxl"],
];

export function formatOf(file) {
  const f = String(file || "").toLowerCase();
  if (/nvfp4/.test(f)) return "nvfp4";
  if (/mxfp8/.test(f)) return "mxfp8";
  if (/w4a8/.test(f)) return "w4a8";
  if (/int8|convrot/.test(f)) return "int8_convrot";
  if (/fp8|e4m3/.test(f)) return "fp8_scaled";
  const q = f.match(/(q\d(?:_k(?:_[sm])?|_\d)?)\.gguf$/i);
  if (q) return `gguf_${q[1].toLowerCase()}`;
  if (/\.gguf$/.test(f)) return "gguf";
  if (/bf16/.test(f)) return "bf16";
  if (/fp16/.test(f)) return "fp16";
  if (/fp32/.test(f)) return "fp32";
  return "";
}
const FMT_NAME = (f) => ({ int8_convrot: "int8 (convrot)", fp8_scaled: "fp8", bf16: "bf16", fp16: "fp16", fp32: "fp32", nvfp4: "nvfp4", mxfp8: "mxfp8", w4a8: "w4a8" }[f]
  || (f.startsWith("gguf_") ? `GGUF ${f.slice(5).toUpperCase()}` : f || "unknown"));

function familyByFile(K, file) {
  const b = base(file).toLowerCase();
  for (const fam of K.families) {
    for (const role of ["diffusion", "text_encoder"]) {
      if ((fam[role]?.variants || []).some((v) => v.file.toLowerCase() === b)) return fam;
    }
  }
  const hint = FAMILY_HINTS.find(([rx]) => rx.test(b));
  return hint ? K.families.find((f) => f.id === hint[1]) : null;
}

/** The diffusion model loaders in the workflow: [{node, widget, file, fam}] */
export async function modelLoaders() {
  const K = await knowledge();
  const out = [];
  for (const n of allNodes()) {
    if (!active(n)) continue;
    const pick = { UNETLoader: "unet_name", UnetLoaderGGUF: "unet_name", CheckpointLoaderSimple: "ckpt_name" }[n.type];
    if (pick) {
      const w = n.widgets?.find((x) => x.name === pick);
      const vals = w?.options?.values;
      const there = !Array.isArray(vals) || !vals.length || vals.includes(w?.value);
      if (w?.value) out.push({ node: n, widget: w, file: w.value, fam: familyByFile(K, w.value), there });
    }
    if (n.type === "LCOptimizer") {
      const bm = n.widgets?.find((x) => x.name === "base_model")?.value;
      const fam = K.families.find((f) => f.name === bm) || null;
      if (fam) out.push({ node: n, widget: null, file: null, fam });
    }
  }
  return out;
}

// ------------------------------------------------------------------ the checks
export async function checkOptimization() {
  const cards = [];
  if (!hasLC123()) {
    cards.push({
      level: 1, title: "Your ComfyUI may not be optimized",
      text: "Install LC123 for a full system report (GPU, attention, drives) and an exact model pick for this machine.",
      actions: [{ label: "Get LC123", tip: "Opens the LC123 page. Install it from the Manager: search LC123.", href: "https://github.com/lonecatone23/ComfyUI_LC123_nodes" }],
    });
    return cards;
  }
  const p = await report();
  if (!p) {
    cards.push({
      level: 1, title: "Your ComfyUI may not be optimized",
      text: "Shall I run a report? LC123 checks your GPU, attention, drives and packs and tells you what to change. About a minute, nothing is installed.",
      actions: [{ label: "Run report", tip: "Runs LC123's system check. Not while something is generating.", run: "report" }],
    });
    return cards;
  }
  const probs = (p.findings || []).filter((f) => f.level === 3);
  const tips = (p.findings || []).filter((f) => f.level === 1);
  const age = p.when ? Math.round((Date.now() - new Date(p.when.replace(" ", "T")).getTime()) / 86400000) : null;
  if (probs.length || tips.length) {
    cards.push({
      level: probs.length ? 3 : 1,
      title: `System report: ${probs.length} problem${probs.length === 1 ? "" : "s"}, ${tips.length} tip${tips.length === 1 ? "" : "s"}`,
      text: [...probs, ...tips].slice(0, 6).map((f) => `${f.level === 3 ? "⚠️" : "💡"} ${f.title}: ${f.text}`).join("\n"),
      actions: [{ label: "Run again", tip: "Runs LC123's system check again", run: "report" }],
    });
  } else if (age !== null && age > 30) {
    cards.push({ level: 0, title: `Your system report is ${age} days old`, text: "Drivers and packs change. Run it again to be sure.", actions: [{ label: "Run report", run: "report" }] });
  }
  return cards;
}

const PREFER = {
  blackwell: ["int8_convrot", "mxfp8", "fp8_scaled", "nvfp4"],
  ada: ["fp8_scaled", "int8_convrot"],
  ampere: ["int8_convrot", "gguf_q8_0"],
  turing: ["gguf_q8_0", "gguf_q4_k_m"],
  pascal: ["gguf_q8_0", "gguf_q4_k_m"],
};

const QUANT_LABEL = { int8_convrot: "int8 (convrot)", fp8_scaled: "fp8 (scaled)", mxfp8: "mxfp8 (50 series)", nvfp4: "nvfp4 (50 series)",
  gguf_q8_0: "GGUF Q8_0", gguf_q6_k: "GGUF Q6_K", gguf_q5_k_m: "GGUF Q5_K_M", gguf_q4_k_m: "GGUF Q4_K_M" };

function preferFor(sys, prof) {
  const shop = prof?.shopping?.by_goal?.Optimal;
  if (Array.isArray(shop) && shop.length) return shop.map((s) => String(s.what).toLowerCase().replace(/^gguf /, "gguf_").replace(/[^a-z0-9_]/g, "_"));
  return PREFER[sys.gen] || ["gguf_q8_0", "gguf_q4_k_m"];
}

// Size of a format relative to bf16, for files the knowledge doesn't list
const SIZE = (f) => (f === "fp32" ? 2 : /^(bf16|fp16)$/.test(f) ? 1 : /q2|q3/.test(f) ? 0.25 : /q4|nvfp4|w4/.test(f) ? 0.3 : /q5|q6/.test(f) ? 0.4 : f ? 0.53 : 1);
// Formats that need a newer card: [test, oldest generation that runs it well, what happens otherwise]
const NEEDS = [
  [/^(nvfp4|mxfp8)$/, ["blackwell"], "only runs on a 50 series card"],
  [/^fp8_scaled$/, ["blackwell", "ada", "ampere"], "isn't supported well on this card and runs slowly"],
];

// Only speaks up when the loaded file won't work, or doesn't suit this machine. A working model is never questioned.
export async function checkModelFormat() {
  const cards = [];
  const sys = await system();
  if (!sys.vram) return cards;
  const prof = await report();
  const prefer = preferFor(sys, prof);
  // Bigger than the card is normal: ComfyUI streams the weights from RAM (H3 and LTX files are bigger than most cards
  // and run fine). What really crawls is a file that doesn't fit in RAM either, so Windows pages it to disk.
  const roomInRam = sys.ram ? sys.ram - 8 : 0; // leave room for the text encoder, VAE and Windows
  const pages = (gb) => !!(gb && roomInRam && gb > roomInRam);
  const q = !!LiteGraph.registered_node_types?.LCModelQuantize;
  for (const { node, file, fam, there } of await modelLoaders()) {
    if (!fam || !file || there === false) continue;
    const vs = fam.diffusion?.variants || [];
    const curV = vs.find((v) => v.file.toLowerCase() === base(file).toLowerCase());
    const cur = curV?.format || formatOf(file);
    const full = (vs.find((v) => /^(bf16|fp16)$/.test(v.format)) || {}).gb;
    const gb = curV?.gb || (full ? Math.round(full * SIZE(cur) * 10) / 10 : 0);
    const bad = NEEDS.find(([rx, gens]) => rx.test(cur) && !gens.includes(sys.gen));
    const wasteful = cur === "fp32";
    const tooBig = pages(gb);
    if (!bad && !wasteful && !tooBig) continue;
    // the same model in a format that suits this card: a stock sibling when it is a stock file, else a quant of this file
    const ok = (g) => (tooBig ? !pages(g) : true); // a too-big file needs a copy that fits in RAM
    const pickFmt = prefer.find((f) => QUANT_LABEL[f] && !NEEDS.some(([rx, gens]) => rx.test(f) && !gens.includes(sys.gen)) && (!full || ok(full * SIZE(f)))) || "gguf_q4_k_m";
    // a known file of the same model that runs here: best format first (the report's order), then the smaller file
    const rank = (f) => { const i = prefer.findIndex((p) => f === p || f.startsWith(p)); return i < 0 ? 99 : i; };
    const runs = (v) => v.file.toLowerCase() !== base(file).toLowerCase() && ok(v.gb) && !NEEDS.some(([rx, gens]) => rx.test(v.format) && !gens.includes(sys.gen))
      && (bad ? v.format !== cur : true) && (wasteful ? v.format !== "fp32" : true);
    const sib = curV && vs.filter(runs).sort((x, y) => rank(x.format) - rank(y.format) || (x.gb || 0) - (y.gb || 0))[0];
    const why = bad ? `It's ${FMT_NAME(cur)}, which ${bad[2]}.`
      : wasteful ? `It's fp32: twice the size of bf16 with no better pictures.`
      : `It's about ${gb} GB, more than your ${Math.round(sys.ram)} GB of RAM can hold next to everything else, so Windows pages it to disk and it runs very slowly.`;
    const have = sib && onDisk(node, sib.file);
    cards.push({
      level: bad || tooBig ? 3 : 1,
      title: bad ? `${base(file)} won't run well on your card` : wasteful ? `${base(file)} is bigger than it needs to be` : `${base(file)} is too big for your RAM`,
      text: `${label(node)} loads ${base(file)}. ${why} `
        + (sib ? `The same model as ${FMT_NAME(sib.format)} (${sib.file}${sib.gb ? `, ${sib.gb} GB` : ""}) ${tooBig ? "fits in your RAM" : "suits your card"}.`
          : `A ${FMT_NAME(pickFmt)} copy of the same file ${tooBig ? "fits in your RAM" : "suits your card"}${full ? ` (about ${Math.round(full * SIZE(pickFmt))} GB)` : ""}. LC Model Quantize makes it${q ? "" : " (LC ModelBuilder pack)"}${/^(bf16|fp16|fp32)$/.test(cur) ? "" : " from the bf16 file"}.`),
      nodeId: where(node),
      actions: sib ? (have ? [{ label: "Use it", tip: "You already have it: switch the loader to this file", run: { set: [node, "unet_name", have] } }]
          : sib.repo ? [{ label: "Get it", tip: `Opens ${sib.repo} on Hugging Face`, href: `https://huggingface.co/${sib.repo}/tree/main` }] : [])
        : q ? [{ label: "Add LC Model Quantize", tip: `Adds LC Model Quantize set to ${QUANT_LABEL[pickFmt]}. Queue it once, then pick the new file in the loader.`, run: { quant: [where(node), /^(bf16|fp16|fp32)$/.test(cur) ? base(file) : "", QUANT_LABEL[pickFmt]] } }]
        : [{ label: "Get LC ModelBuilder", tip: "Install it from the Manager: search LC ModelBuilder", href: "https://github.com/lonecatone23/ComfyUI_LC_ModelBuilder_nodes" }],
    });
  }
  return cards;
}

/** Add LC Model Quantize next to a loader, pointed at the file and format. */
export function addQuantize(id, file, format) {
  const m = addNear(id, "LCModelQuantize");
  if (!m) return null;
  const src = m.widgets?.find((w) => w.name === "source");
  const hit = file && (src?.options?.values || []).find((v) => base(v).toLowerCase() === file.toLowerCase());
  if (hit) src.value = hit;
  const fw = m.widgets?.find((w) => w.name === "format");
  if (fw && (fw.options?.values || []).includes(format)) fw.value = format;
  app.graph.setDirtyCanvas(true, true);
  return m;
}

function onDisk(node, file) {
  const w = node.widgets?.find((x) => ["unet_name", "ckpt_name", "clip_name"].includes(x.name));
  const vals = w?.options?.values || [];
  return vals.find((v) => base(v).toLowerCase() === file.toLowerCase()) || null;
}

function feedsOnlyPrompts(n) {
  const g = n.graph || app.graph;
  const ids = (n.outputs || []).flatMap((o) => o.links || []);
  if (!ids.length) return true;
  return ids.every((id) => {
    const l = g.links?.[id] || g.links?.get?.(id);
    const t = l && g.getNodeById?.(l.target_id);
    return !t || /TextEncode|Prompt|Positive|Negative|Lora|Conditioning|Reroute|SetNode/i.test(t.type);
  });
}

export async function checkClipType() {
  const cards = [];
  const K = await knowledge();
  const fams = [...new Set((await modelLoaders()).map((l) => l.fam).filter((f) => f?.text_encoder?.clip_type))];
  if (fams.length !== 1) return cards; // none, or several models in one workflow: can't tell which loader feeds which
  const fam = fams[0];
  const want = fam.text_encoder.clip_type;
  const mine = (v) => (fam.text_encoder.variants || []).some((x) => x.file.toLowerCase() === base(v).toLowerCase());
  const otherFam = (v) => K.families.find((f) => f !== fam && (f.text_encoder?.variants || []).some((x) => x.file.toLowerCase() === base(v).toLowerCase()));
  for (const n of allNodes()) {
    if (!active(n) || !/^CLIPLoader(GGUF)?$/.test(n.type)) continue;
    const tw = n.widgets?.find((w) => w.name === "type");
    const cw = n.widgets?.find((w) => w.name === "clip_name");
    if (!tw) continue;
    const typeWrong = tw.value !== want && (tw.options?.values || []).includes(want);
    // a CLIP feeding something special (a projector, an adapter) may be a different encoder on purpose
    const ordinary = feedsOnlyPrompts(n);
    const wrongFor = ordinary && cw?.value && !mine(cw.value) ? otherFam(cw.value) : null;
    if (!typeWrong && !wrongFor) continue;
    const files = (cw?.options?.values || []).filter(mine);
    const what = [typeWrong && `is set to "${tw.value}", but ${fam.name} needs "${want}"`, wrongFor && `${typeWrong ? "and " : ""}loads ${base(cw.value)}, which is the ${wrongFor.name} text encoder`].filter(Boolean).join(" ");
    cards.push({
      level: 3, title: wrongFor ? "Wrong text encoder" : "Wrong text encoder type",
      text: `${label(n)} ${what}. With the wrong one the prompt is read wrong or the run fails.`
        + (files.length ? ` Text encoders you have for it: ${files.map(base).join(", ")}. Shall I replace it for you?` : wrongFor ? ` You don't have one for ${fam.name} yet.` : ""),
      nodeId: where(n),
      actions: [
        ...files.filter((f) => f !== cw?.value).slice(0, 2).map((f) => ({ label: `Use ${base(f)}`, tip: `Switches the file${typeWrong ? ` and sets the type to ${want}` : ""}`, run: { set: [n, "clip_name", f], also: [n, "type", want] } })),
        ...(typeWrong && !wrongFor ? [{ label: `Set to ${want}`, tip: "Changes the type for you", run: { set: [n, "type", want] } }] : []),
        ...(!files.length && wrongFor && fam.text_encoder.variants?.[0]?.repo ? [{ label: "Get it", tip: `Opens ${fam.text_encoder.variants[0].repo} on Hugging Face`, href: `https://huggingface.co/${fam.text_encoder.variants[0].repo}/tree/main` }] : []),
      ],
    });
  }
  return cards;
}

const FOLDER = { UNETLoader: "diffusion_models", UnetLoaderGGUF: "diffusion_models", CheckpointLoaderSimple: "checkpoints", CLIPLoader: "text_encoders",
  CLIPLoaderGGUF: "text_encoders", DualCLIPLoader: "text_encoders", VAELoader: "vae", LoraLoader: "loras", LoraLoaderModelOnly: "loras",
  UpscaleModelLoader: "upscale_models", ControlNetLoader: "controlnet", LoadImage: "input" };

export async function checkMissingFiles() {
  const K = await knowledge();
  const cards = [];
  const inputs = []; // pictures, videos and sounds from someone else's computer: one card for all of them
  const placeholders = []; // "placeholder.safetensors": the author wants you to pick your own
  for (const n of allNodes()) {
    if (!active(n)) continue;
    for (const w of n.widgets || []) {
      const vals = w.options?.values;
      if (w.type !== "combo" || !Array.isArray(vals) || !vals.length || !w.value || vals.includes(w.value)) continue;
      if (typeof w.value !== "string" || !/\.\w{2,12}$/.test(w.value)) continue;
      const file = base(w.value);
      const near = vals.filter((v) => typeof v === "string" && base(v).toLowerCase() === file.toLowerCase());
      if (near.length) {
        cards.push({
          level: 3, title: `${file} is in a subfolder`,
          text: `${label(n)} looks for ${w.value}, and you have it as ${near[0]}. Nothing has to move: the node just needs the full name. One click sets it.`,
          nodeId: where(n),
          actions: near.slice(0, 2).map((v) => ({ label: near.length > 1 ? `Use ${v}` : "Fix the path", tip: `Sets ${w.name} to ${v}`, run: { set: [n, w.name, v] } })),
        });
        continue;
      }
      let repo = null;
      const sameModel = new Set(); // other formats of the same model (bf16 asked, fp8 on disk), from the knowledge
      for (const fam of K.families) for (const role of ["diffusion", "text_encoder", "vae"]) {
        const vs = fam[role]?.variants || [];
        const v = vs.find((x) => x.file.toLowerCase() === file.toLowerCase());
        if (v?.repo) repo = v.repo;
        if (v) vs.forEach((x) => sameModel.add(x.file.toLowerCase()));
      }
      // the same model under another name: a known other format, or the same name once format tags and punctuation go
      // (qwen_3_4b.safetensors asked, qwen3-4B.safetensors or qwen_3_4b_fp8_mixed.safetensors here)
      const key = (f) => base(f).toLowerCase().replace(/\.\w+$/, "")
        .replace(/[-_. ](bf16|fp16|fp32|fp8|fp8_?(e4m3fn|e5m2|scaled|mixed)?|fp4_?mixed|nvfp4|mxfp8|int8_?convrot|int8|q\d_\w+|q\d)$/g, "").replace(/[^a-z0-9]/g, "");
      const have = vals.filter((v) => typeof v === "string" && /\.\w{2,12}$/.test(v) && (sameModel.has(base(v).toLowerCase()) || key(v) === key(file)));
      const folder = FOLDER[n.type] || (n.type.match(/Lora/i) ? "loras" : null);
      const isInput = folder === "input" || /image|video|audio|upload|^file$/i.test(w.name) || /^Load(Image|Video|Audio)|VHS_Load/i.test(n.type);
      if (isInput) {
        inputs.push(n);
        continue;
      }
      if (/^(placeholder|example|your[_ -]?(model|lora)|none|select|change[_ -]?me)(\.|_|$)/i.test(file)) {
        placeholders.push([n, w]);
        continue;
      }
      const stem = file.replace(/\.\w+$/, "");
      if (have.length) {
        cards.push({
          level: 3, title: `Missing: ${file} (you have the same model)`,
          text: `${label(n)} asks for ${file}, and you already have the same model as ${base(have[0])}${have.length > 1 ? ` (or ${base(have[1])})` : ""}. One click switches to it.`,
          nodeId: where(n),
          _repo: repo,
          actions: [...have.slice(0, 2).map((v) => ({ label: `Use ${base(v)}`, tip: `Sets ${w.name} to ${v}`, run: { set: [n, w.name, v] } })),
            ...(repo ? [{ label: "Get it", tip: `Opens ${repo} on Hugging Face`, href: `https://huggingface.co/${repo}/tree/main` }] : [])],
        });
        continue;
      }
      cards.push({
        level: 3, title: `Missing: ${file}`,
        text: `${label(n)} needs ${file}${folder ? ` in models/${folder}` : ""}.` + (repo ? " You can get it here:" : " I don't know where it comes from, so here's a search:"),
        nodeId: where(n),
        _repo: repo,
        actions: repo ? [{ label: "Get it", tip: `Opens ${repo} on Hugging Face`, href: `https://huggingface.co/${repo}/tree/main` }]
          : [{ label: "Search Hugging Face", href: `https://huggingface.co/models?search=${encodeURIComponent(stem)}` },
             { label: "Search CivitAI", href: `https://civitai.com/search/models?query=${encodeURIComponent(stem)}` }],
      });
    }
  }
  if (placeholders.length) cards.push({
    level: 1, title: `Pick your own file (${placeholders.length} ${placeholders.length === 1 ? "setting" : "settings"})`,
    text: `${placeholders.slice(0, 4).map(([n, w]) => `${label(n)} (${w.name})`).join(", ")}${placeholders.length > 4 ? ` and ${placeholders.length - 4} more` : ""} hold a placeholder name. That isn't a download: the author left it for you to pick your own LoRA or model, or to bypass the node.`,
    nodeId: where(placeholders[0][0]), nodeIds: [...new Set(placeholders.map(([n]) => where(n)))], actions: [],
  });
  const ins = [...new Set(inputs)];
  if (ins.length) cards.push({
    level: 1, title: `Load your own ${ins.length === 1 ? "file" : "files"} (${ins.length} ${ins.length === 1 ? "node" : "nodes"})`,
    text: `${ins.slice(0, 4).map(label).join(", ")}${ins.length > 4 ? ` and ${ins.length - 4} more` : ""} still point at the author's pictures or videos, which aren't on this computer. Click each one and pick your own, or drag a file onto it.`,
    nodeId: where(ins[0]), nodeIds: [...new Set(ins.map(where))], actions: [],
  });
  const repos = [...new Set(cards.map((c) => c._repo).filter(Boolean))];
  const gates = Object.fromEntries(await Promise.all(repos.map(async (r) => [r, await hfGate(r)])));
  for (const c of cards) if (c._repo) applyGate(c, gates[c._repo]);
  return cards;
}

/** LC Model Optimizer about to download a gated file (★ Recommended picked a file that isn't here, or a ⬇ download): it
 * would stop at the download. Asks the optimizer which file it picks, then warns with the steps unless this computer
 * already has access. */
export async function checkGatedDownloads() {
  const K = await knowledge();
  const cards = [];
  for (const n of allNodes()) {
    if (!active(n) || !/^LCOptimizer/.test(n.type)) continue;
    const val = (name) => String(n.widgets?.find((x) => x.name === name)?.value || "");
    const bm = val("base_model");
    const fam = K.families.find((f) => f.name === bm);
    if (!fam) continue;
    const kind = n.type === "LCOptimizerVideo" ? "video" : "image";
    for (const [role, wname, comp] of [["model", "model_file", "diffusion"], ["clip", "text_encoder", "text_encoder"]]) {
      const v = val(wname);
      let file = null;
      if (/^⬇/.test(v)) file = v.replace(/^⬇\s*Download:\s*/, "");
      else if (v === "★ Recommended") {
        try {
          const r = await (await api.fetchApi(`/lc123/optimizer_node/choices?kind=${kind}&base=${encodeURIComponent(bm)}&role=${role}&goal=${encodeURIComponent(val("goal") || "Optimal")}`)).json();
          if (r?.recommended && !r.recommended.on_disk) file = r.recommended.file;
        } catch { /* LC123 not answering: say nothing */ }
      }
      if (!file) continue;
      const variant = (fam[comp]?.variants || []).find((x) => x.file.toLowerCase() === base(file).toLowerCase());
      if (!variant?.repo) continue;
      const g = await hfGate(variant.repo);
      if (!g?.gated || g.access === true) continue;
      cards.push({
        level: 3, title: `🔒 ${bm} needs its license accepted`,
        text: `${label(n)} downloads ${variant.file} on the first run, and it's gated. ` + gateSteps(g)
          + " Or download the file yourself (the workflow notes often link it) and drop it in the folder shown.",
        nodeId: where(n), actions: gateActions(g),
      });
    }
  }
  return cards;
}

// Packs people know by a name prefix, for workflows that don't record where a node came from
const PACK_HINTS = [
  [/\(rgthree\)$/, "rgthree-comfy", "https://github.com/rgthree/rgthree-comfy"],
  [/\|pysssss$/, "ComfyUI-Custom-Scripts (pysssss)", "https://github.com/pythongosssss/ComfyUI-Custom-Scripts"],
  [/^easy /, "ComfyUI-Easy-Use", "https://github.com/yolain/ComfyUI-Easy-Use"],
  [/^CR /, "Comfyroll Studio", "https://github.com/Suzie1/ComfyUI_Comfyroll_CustomNodes"],
  [/^(SetNode|GetNode)$|KJ$/, "KJNodes", "https://github.com/kijai/ComfyUI-KJNodes"],
  [/^Searge/, "SeargeSDXL", "https://github.com/SeargeDP/SeargeSDXL"],
  [/^ReActor/, "ReActor", "https://github.com/Gourieff/ComfyUI-ReActor"],
  [/^VHS_/, "Video Helper Suite", "https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite"],
  [/\(LoraManager\)$/, "LoRA Manager", "https://github.com/willmiao/ComfyUI-Lora-Manager"],
  [/^BatchPromptSchedule|^PromptSchedule/, "FizzNodes", "https://github.com/FizzleDorf/ComfyUI_FizzNodes"],
  [/^(Text box|Text Multiline|Image Save|Text Concatenate)$/, "WAS Node Suite", "https://github.com/WASasquatch/was-node-suite-comfyui"],
];

const ghOwner = (href) => (String(href || "").match(/github\.com\/([^/]+)/) || [])[1] || "";

function packOf(n) {
  const p = n.properties || {};
  if (p.cnr_id && p.cnr_id !== "comfy-core") {
    // a pack we know by its GitHub page gets that link (it names the author); others get the Registry page
    const known = PACK_HINTS.find(([, , href]) => href.split("/").pop().toLowerCase() === p.cnr_id.toLowerCase());
    return { key: p.cnr_id, name: known ? known[1] : p.cnr_id, href: known ? known[2] : `https://registry.comfy.org/nodes/${p.cnr_id}` };
  }
  if (p.aux_id) return { key: p.aux_id, name: p.aux_id.split("/").pop(), href: `https://github.com/${p.aux_id}` };
  const hit = PACK_HINTS.find(([rx]) => rx.test(n.type));
  if (hit) return { key: hit[1], name: hit[1], href: hit[2] };
  return { key: `?${n.type}`, name: "", href: "" };
}

/** Missing nodes, one card per pack (named and linked when the workflow says where they came from). */
export function checkBrokenNodes() {
  const packs = new Map();
  for (const n of allNodes()) {
    if (LiteGraph.registered_node_types?.[n.type] || /^[0-9a-f-]{36}$/i.test(n.type)) continue;
    const pk = packOf(n);
    if (!packs.has(pk.key)) packs.set(pk.key, { ...pk, types: new Map() });
    const t = packs.get(pk.key).types;
    if (!t.has(n.type)) t.set(n.type, []);
    t.get(n.type).push(n);
  }
  const cards = [];
  for (const pk of packs.values()) {
    const all = [...pk.types.values()].flat();
    const types = [...pk.types.keys()];
    const swaps = types.map((t) => {
      const r = REPLACEMENTS[t] || {};
      const nat = (r.native || []).filter((x) => LiteGraph.registered_node_types?.[x]);
      const lc = (r.lc || []).filter((x) => LiteGraph.registered_node_types?.[x]);
      return { t, nat, lc, node: pk.types.get(t)[0] };
    }).filter((s) => s.nat.length || s.lc.length);
    const what = all.length === 1 ? "1 node" : `${all.length} nodes`;
    const list = types.length <= 4 ? types.join(", ") : `${types.slice(0, 4).join(", ")} and ${types.length - 4} more`;
    const swapText = swaps.slice(0, 3).map((s) => `${s.t} → ${[...s.nat.map((x) => `ComfyUI's ${typeTitle(x)}`), ...s.lc.map((x) => `Lonecat's ${typeTitle(x)}`)].slice(0, 2).join(" or ")}`).join("; ");
    cards.push({
      level: 3,
      title: pk.name ? `Missing pack: ${pk.name} (${what})` : `Missing node: ${types[0]}`,
      text: `${pk.name ? `${what} from ${pk.name}${ghOwner(pk.href) ? ` (by ${ghOwner(pk.href)})` : ""} ${all.length === 1 ? "isn't" : "aren't"} installed: ${list}.` : `${what} of this type ${all.length === 1 ? "isn't" : "aren't"} installed.`}`
        + (swapText ? ` Replacements you already have: ${swapText}.` : "")
        + ` Install it from the Manager (Install Missing Custom Nodes)${pk.href ? " or from its page" : ""}.`,
      nodeId: where(all[0]),
      nodeIds: [...new Set(all.map(where))],
      actions: [
        ...(pk.href ? [{ label: "Pack page", tip: pk.href, href: pk.href }] : []),
        ...swaps.filter((s) => !hostOf(s.node)).slice(0, 2).map((s) => {
          const to = s.nat[0] || s.lc[0];
          return { label: `Add ${typeTitle(to)}`, tip: `Adds it next to the broken ${s.t}. Wire it up, then delete the old one.`, run: { add: [s.node.id, to] } };
        }),
      ],
    });
  }
  return cards;
}

// ------------------------------------------------------------------ swap for LC nodes (first card in the checkup)
export function checkSwaps() {
  const groups = swap.find().filter((g) => g.nodes.length);
  if (!groups.length) return [];
  const count = groups.reduce((k, g) => k + g.nodes.length, 0);
  const nodes = groups.flatMap((g) => g.nodes);
  return [{
    level: 1,
    title: `Swap for LC nodes: ${count} node${count === 1 ? "" : "s"}`,
    text: "These nodes from other packs have an LC node that does the same job. Tick the ones to swap: settings and wires carry over, and the LC node takes its place. Undo is on the Snapshots tab.",
    swap: groups.map((g) => ({ from: g.sw.from, to: [...g.targets].map(swap.titleOf).join(" / "), count: g.nodes.length, drops: [...g.drops], blocked: g.blocked.length, why: g.blocked[0]?.why || "" })),
    nodeId: where(nodes[0]),
    nodeIds: [...new Set(nodes.map(where))],
    actions: [{ label: "Swap ticked", tip: "Replaces every ticked node with its LC twin, keeping settings and wires", run: { swap: true } }],
  }];
}

export function swapTypes(types) {
  return swap.swapTypes(types);
}

/** Every note that isn't an LC Note yet (core Note, Markdown Note, any other note node). */
export function checkNotes() {
  const groups = swap.findNotes().filter((g) => g.nodes.length);
  if (!groups.length) return [];
  const count = groups.reduce((k, g) => k + g.nodes.length, 0);
  const nodes = groups.flatMap((g) => g.nodes);
  return [{
    level: 1,
    title: `Convert ${count} note${count === 1 ? "" : "s"} to LC Notes`,
    text: "LC Notes do more than show text: they translate into your language, fix spelling, and every web address becomes a real link you can click (links on their own line become link cards). Tick the notes to convert: the text, title, colours and place carry over, line breaks too. Undo is on the Snapshots tab.",
    swap: groups.map((g) => ({ from: swap.titleOf(g.sw.from), key: g.sw.from, to: "LC Note 📝", count: g.nodes.length, drops: [], blocked: 0, why: "" })),
    nodeId: where(nodes[0]),
    nodeIds: [...new Set(nodes.map(where))],
    actions: [{ label: "Convert ticked", tip: "Turns every ticked note into an LC Note, keeping its text, title, colours and place", run: { swap: true, notes: true } }],
  }];
}

// ------------------------------------------------------------------ errors in plain words
const ERRORS = [
  [/out of memory|OutOfMemory|allocation on device/i, "Out of graphics memory (VRAM).",
    "Use a smaller format of the same model (fp8, int8, GGUF), a lower resolution or batch size, or close other programs using the GPU."],
  [/shapes cannot be multiplied/i, "Two parts of the workflow don't fit together.",
    "Usually the text encoder, its type or a LoRA is made for a different model. Check the text encoder card above, and that every file is made for this model."],
  [/size mismatch|Error\(s\) in loading state_dict|unexpected key/i, "A file was made for a different model.",
    "A model, LoRA or VAE belongs to another model family. Swap it for one made for this model."],
  [/Value not in list/i, "A picked file isn't on this computer.", "See the missing file cards above."],
  [/No such file|FileNotFoundError|does not exist/i, "A file isn't where the workflow expects it.", "See the missing file cards above."],
  [/Expected all tensors to be on the same device|device-side assert/i, "A node mixed up the CPU and the GPU.",
    "Restart ComfyUI. If it happens again, update the pack that node comes from."],
  [/Required input is missing/i, "A required input isn't connected.", "The node is outlined in red. Wire that input."],
  [/ModuleNotFoundError|No module named/i, "A Python package is missing.", "A pack needs a package that isn't installed. Reinstall the pack from the Manager."],
];

/** {title: the error as ComfyUI said it, text: what it means and what to do} */
export function translate(message) {
  const m = String(message || "").trim();
  const first = m.split("\n")[0].slice(0, 220);
  const hit = ERRORS.find(([rx]) => rx.test(m));
  return { title: first || "The run stopped", text: hit ? `${hit[1]} ${hit[2]}` : "" };
}

export function checkErrors() {
  const cards = [];
  if (lastError) {
    const t = translate(lastError.exception_message);
    cards.push({ level: 3, title: `${lastError.node_type || "A node"} stopped the run`, text: `"${t.title}"${t.text ? `\n${t.text}` : ""}`, nodeId: lastError.node_id, actions: [{ label: "Dismiss", run: "dismiss" }] });
  }
  const ne = app.lastNodeErrors || {};
  for (const [id, info] of Object.entries(ne)) {
    const msg = (info.errors || []).map((e) => `${e.message}${e.details ? `: ${e.details}` : ""}`).join("; ");
    const t = translate(msg);
    cards.push({ level: 3, title: `${info.class_type || "A node"} can't run`, text: `"${t.title}"${t.text ? `\n${t.text}` : ""}`, nodeId: id });
  }
  return cards;
}

export function dismissError() {
  lastError = null;
}

api.addEventListener("execution_error", (e) => {
  lastError = e.detail || null;
});
api.addEventListener("execution_start", () => {
  lastError = null;
});

/** A damaged workflow: its wires disagree with themselves (rgthree calls these corrupt workflows). */
export function checkCorruption() {
  const found = findDamage();
  if (!found.length) return [];
  const fixable = found.filter((x) => x.fix).length;
  const kinds = new Set(found.map((x) => x.kind));
  return [{
    level: 3,
    title: `This workflow is damaged (${found.length} problem${found.length === 1 ? "" : "s"} in its wiring)`,
    text: `Its saved wires don't match up, which can drop inputs, stop it from queuing or crash it on load: `
      + found.slice(0, 4).map((x) => x.text).join("; ") + (found.length > 4 ? `; and ${found.length - 4} more` : "") + "."
      + (fixable ? ` ${fixable === found.length ? "All of it" : `${fixable} of them`} can be repaired safely (Ctrl+Z undoes it). Save the workflow afterwards.` : "")
      + (kinds.has("dup") ? " Two nodes sharing an id can't be repaired automatically: delete one and add it again." : ""),
    nodeId: found.find((x) => x.node)?.node?.id,
    actions: fixable ? [{ label: "Repair wiring", tip: "Removes wires that point at nothing and restores missing back-references", run: { repair: true } }] : [],
  }];
}

// ------------------------------------------------------------------ steps / cfg / shift / guidance vs the model
// From the official model cards and ComfyUI templates (H:\Claude\Model settings research.md). Only a clear miss is
// flagged: a base model run with turbo settings never finishes denoising (a smeary, see-through "dirty glass" picture).
const isBase = (t) => /(^|[^a-z])base([^a-z]|$)/.test(t);
const PROFILES = [
  { name: "Z-Image Base", match: (t) => /z.?image|zit/.test(t) && isBase(t), steps: [25, 50], cfg: [3, 5], fix: [28, 4], auraShift: 3,
    speed: "the official Z-Image-Fun-Lora-Distill (2, 4 or 8 steps, cfg 1, strength 0.7 to 0.9)" },
  { name: "Z-Image Turbo", match: (t) => /z.?image|zit/.test(t), steps: [8, 12], cfg: [1, 2], fix: [8, 1], auraShift: 3 },
  { name: "FLUX.1 Krea dev", match: (t) => /flux.?1.?krea|krea.?dev/.test(t), steps: [20, 50], cfg: [1, 1.5], fix: [20, 1], guidance: [4.5, 1.5, 6] },
  { name: "Krea 2 Raw", match: (t) => /krea.?2/.test(t) && /raw/.test(t), steps: [28, 52], cfg: [3.5, 4.5], fix: [28, 4],
    speed: "Krea 2 Turbo instead (Krea says Raw is for training LoRAs, not for making pictures; there is no turbo LoRA for it)" },
  { name: "Krea 2 Turbo", match: (t) => /krea.?2|krealism/.test(t), steps: [8, 12], cfg: [1, 2], fix: [8, 1] },
  { name: "FLUX.2 Klein Base", match: (t) => /klein/.test(t) && isBase(t), steps: [20, 50], cfg: [4, 5], fix: [20, 4], speed: "the distilled Klein (4 steps, cfg 1)" },
  { name: "FLUX.2 Klein (distilled)", match: (t) => /klein/.test(t), steps: [4, 8], cfg: [1, 1.5], fix: [4, 1] },
  { name: "Qwen-Image Turbo", match: (t) => /qwen.?image/.test(t) && /turbo|lightning/.test(t), steps: [8, 10], cfg: [1, 1.5], fix: [8, 1] },
  { name: "Qwen-Image", match: (t) => /qwen.?image/.test(t), steps: [25, 50], fix: [40], speed: "Qwen-Image 2.1 Turbo or a Lightning LoRA (4 to 8 steps, cfg 1)" },
  { name: "FLUX.1 dev", match: (t) => /flux.?1|flux.?dev/.test(t) && !/schnell|klein|flux.?2/.test(t), steps: [20, 50], cfg: [1, 1.5], fix: [20, 1], guidance: [3.5, 1.5, 6] },
  { name: "Chroma", match: (t) => /chroma/.test(t) && !/flash/.test(t), steps: [26, 40], cfg: [3, 4], fix: [26, 3.5], auraShift: 1 },
  { name: "Pony", match: (t) => /pony/.test(t), steps: [20, 30], fix: [25], pony: true, sdxl: true, speed: "an SDXL speed LoRA (Lightning, DMD2 or Hyper, 4 to 8 steps, cfg 1)" },
  { name: "Illustrious / NoobAI", match: (t) => /illustrious|ilxl|noob/.test(t), steps: [20, 35], cfg: [4, 7.5], fix: [28, 6], sdxl: true, speed: "an SDXL speed LoRA (Lightning, DMD2 or Hyper, 4 to 8 steps, cfg 1)" },
  { name: "SDXL", match: (t) => /sdxl|(^|[^a-z])xl([^a-z]|$)/.test(t), steps: [20, 40], cfg: [4, 8], fix: [28, 7], sdxl: true, speed: "an SDXL speed LoRA (Lightning, DMD2 or Hyper, 4 to 8 steps, cfg 1)" },
  { name: "Anima Turbo", match: (t) => /anima(?!sity|tion|ted|l)/.test(t) && /turbo/.test(t), steps: [8, 12], cfg: [1, 2], fix: [10, 1] },
  { name: "Anima", match: (t) => /anima(?!sity|tion|ted|l)/.test(t), steps: [30, 50], cfg: [4, 5], fix: [30, 4], speed: "the Anima Turbo model (8 to 12 steps, cfg 1)" },
  { name: "MiniMax H3", match: (t) => /minimax|(^|[^a-z])h3([^a-z]|$)/.test(t), steps: [12, 50], fix: [20], video: true,
    speed: "the turbo LoRA (FL2V 8-step or Ref2V 4-step, at strength 1.0)" },
  { name: "LTX-2.5", match: (t) => /ltx.?2\.?5/.test(t), steps: [8, 12], cfg: [1, 1.5], fix: [8, 1], video: true },
  { name: "LTX-2.3", match: (t) => /ltx.?2\.?3/.test(t), steps: [20, 40], cfg: [2.5, 4], fix: [30, 3], video: true, speed: "the distilled LoRA (8 steps, cfg 1)" },
];
const SPEED_RX = /turbo|lightning|hyper|dmd|lcm|distill|(^|[^a-z])acc([^a-z]|$)|flash|schnell|\d+\s*[-_ ]?\s*steps?/;

function linked(n, name) {
  return !!n.inputs?.some((i) => (i.widget?.name === name || i.name === name) && i.link != null);
}

/** The run's steps and cfg: {node, name, value} from the node that sets them (a linked widget is not the source). */
function runSettings() {
  const STEPS = { LCSamplerConfigure: "total_steps", LCSamplerConfigurePipe: "total_steps", LCSamplerConfigurePipeOut: "total_steps",
    LCSamplerConfigureSimple: "total_steps", LCSamplerConfigureSimplePipeOut: "total_steps", LCSigmas: "steps", KSampler: "steps", KSamplerAdvanced: "steps", BasicScheduler: "steps" };
  const CFG = { LCSamplerConfigure: "cfg_1", LCSamplerConfigurePipe: "cfg_1", LCSamplerConfigurePipeOut: "cfg_1",
    LCSamplerConfigureSimple: "cfg", LCSamplerConfigureSimplePipeOut: "cfg", KSampler: "cfg", KSamplerAdvanced: "cfg", CFGGuider: "cfg" };
  // the central config node (LC Sampler Configure) wins over a stray sampler, in the order the maps list the types
  const find = (map, prefer) => {
    const order = Object.keys(map);
    const hits = allNodes().filter((n) => active(n) && map[n.type] && !linked(n, map[n.type])
      && typeof n.widgets?.find((x) => x.name === map[n.type])?.value === "number")
      .sort((a, b) => (b === prefer) - (a === prefer) || order.indexOf(a.type) - order.indexOf(b.type));
    const n = hits[0];
    return n ? { node: n, name: map[n.type], value: n.widgets.find((x) => x.name === map[n.type]).value } : null;
  };
  const steps = find(STEPS);
  return { steps, cfg: find(CFG, steps?.node) }; // cfg from the same node as the steps when it has one
}

/** Active LoRAs that cut the step count (turbo, lightning, distill, N-step): [{name, steps, strength, node, optimizer}] */
function speedLoras() {
  const out = [];
  const add = (node, name, strength, optimizer = false) => {
    const b = base(name).toLowerCase();
    if (!b || /^none$|recommended/.test(b) || !SPEED_RX.test(b)) return;
    const m = b.match(/(\d+)\s*[-_ ]?\s*steps?/);
    out.push({ name: base(name), steps: m ? +m[1] : null, strength: num(strength), node, optimizer });
  };
  for (const n of allNodes()) {
    if (!active(n)) continue;
    if (n.type === "LCLoraLoader" || n.type === "LCLoraLoaderStack") {
      try {
        for (const r of JSON.parse(n.widgets?.find((w) => w.name === "lora_rows")?.value || "[]")) if (r.on) add(n, r.lora, r.strength);
      } catch (_) {}
    } else if (/LoraLoader/.test(n.type)) {
      add(n, valueOf(n, "lora_name"), valueOf(n, "strength_model") ?? valueOf(n, "strength"));
    } else if (/^LCOptimizer/.test(n.type)) {
      add(n, n.widgets?.find((w) => w.name === "lora")?.value, 0.5, true); // the Optimizer applies its LoRA at 0.5
    }
  }
  return out;
}

/** What the run uses and what that model wants: {run, p, loras, fast, steps, cfg, fix} (p null = unknown model). */
async function modelPlan() {
  const run = await runModel();
  if (run.multi) return { run, p: null };
  const fileT = base(run.file).toLowerCase();
  const famT = String(run.fam?.name || "").toLowerCase();
  const p = (fileT && !/recommended/.test(fileT) && PROFILES.find((r) => r.match(fileT))) || PROFILES.find((r) => r.match(famT)) || null;
  if (!p) return { run, p };
  const loras = speedLoras();
  // a base model made fast by a speed LoRA, or a turbo merge of it (10Eros TURBO, a "...-8step" file)
  const fast = !!p.speed && (loras.length > 0 || SPEED_RX.test(fileT));
  if (!fast) return { run, p, loras, fast, steps: p.steps, cfg: p.cfg, fix: p.fix };
  const n = loras.find((l) => l.steps)?.steps || (fileT.match(/(\d+)\s*[-_ ]?\s*steps?/) || [])[1];
  const k = n ? +n : null;
  const hyperCfg = loras.some((l) => /cfg/i.test(l.name)); // Hyper-SD 8/12-step CFG LoRA keeps a normal cfg
  return { run, p, loras, fast, steps: k ? [k, k + 4] : [4, 12], cfg: p.video ? null : hyperCfg ? p.cfg : [1, 1.5], fix: [k || 8, 1] };
}

export async function checkStepsModel() {
  const mp = await modelPlan();
  const { run, p } = mp;
  if (!p) return [];
  const cards = [];
  const { steps, cfg } = runSettings();
  const name = base(run.file) && !/recommended/i.test(run.file) ? base(run.file) : run.fam?.name || p.name;
  const famT = String(run.fam?.name || "").toLowerCase();
  const famNote = run.fam && base(run.file) && !p.match(famT) ? ` (the Optimizer's base model says ${run.fam.name}, but the file is ${p.name})` : "";
  const setBoth = (s, c) => (steps && cfg && c !== undefined && cfg.node === steps.node
    ? [{ label: `Set ${s} steps, cfg ${c}`, tip: `Changes ${label(steps.node)}`, run: { set: [steps.node, steps.name, s], also: [cfg.node, cfg.name, c] } }]
    : steps ? [{ label: `Set ${s} steps`, tip: `Changes ${label(steps.node)}`, run: { set: [steps.node, steps.name, s] } }] : []);

  // 1. turbo LoRA missing: a base model at turbo step counts
  if (p.speed && !mp.fast && steps && steps.value <= Math.max(12, p.steps[0] * 0.5)) {
    cards.push({ level: 3, title: "Turbo LoRA missing (or too few steps)", nodeId: where(steps.node),
      text: `${name} is ${p.name}${famNote}, which needs ${p.steps[0]} to ${p.steps[1]} steps on its own${p.cfg ? ` at cfg ${p.cfg[0]} to ${p.cfg[1]}` : ""}. ${steps.value} steps only works with ${p.speed}. Add it, or raise the steps. Without it the picture comes out half finished: smeary and grainy, like a photo through dirty glass.`,
      actions: setBoth(p.fix[0], p.fix[1]) });
    return cards;
  }
  // 2. steps / cfg outside what the model (or its speed LoRA) wants
  const lowSteps = !!steps && steps.value < mp.steps[0] * 0.7;
  const highSteps = !!steps && steps.value > mp.steps[1] * 1.8;
  const lowCfg = !!(mp.cfg && cfg) && cfg.value < mp.cfg[0] - 0.75;
  const highCfg = !!(mp.cfg && cfg) && cfg.value > mp.cfg[1] + 1.5;
  if (lowSteps || highSteps || lowCfg || highCfg) {
    const lora = mp.fast && mp.loras.length ? ` with ${mp.loras[0].name}` : "";
    const want = `${mp.steps[0]} to ${mp.steps[1]} steps${mp.cfg ? `, cfg ${mp.cfg[0]} to ${mp.cfg[1]}` : ""}`;
    const now = [steps ? `${steps.value} steps` : null, cfg ? `cfg ${cfg.value}` : null].filter(Boolean).join(", ");
    cards.push({ level: lowSteps || lowCfg ? 3 : 1, title: "Steps and model don't match", nodeId: where((steps || cfg)?.node || run.node),
      text: `${name} is ${p.name}${lora}${famNote}, which wants ${want}. This run is set to ${now}.\n${lowSteps || lowCfg
        ? "Too few steps or too low a cfg leaves it half finished: smeary and grainy, like a photo through dirty glass."
        : highCfg ? (mp.cfg[1] <= 2 ? "Too much cfg on a distilled (turbo) model burns the colours and adds harsh contrast." : "Too much cfg burns the colours and adds harsh contrast.") : "That many steps only burns time and can overcook the picture."}`,
      actions: setBoth(mp.fix[0], mp.fix[1]) });
  }
  // 3. a speed LoRA too weak to do its job
  for (const l of mp.loras || []) {
    const want = /minimax|h3/i.test(p.name) ? 1 : /z-image/i.test(p.name) ? 0.7 : 0.6;
    if (l.strength !== undefined && l.strength < want - 0.05) {
      cards.push({ level: 1, title: `${l.name} is at strength ${l.strength}`, nodeId: where(l.node),
        text: l.optimizer
          ? `The Model Optimizer applies its LoRA at 0.5, but this one is made to run at ${want === 1 ? "1.0" : `${want} or more`}. Load it in an LC LoRA Loader at full strength instead.`
          : `A speed LoRA this weak only half does its job, so the low step count leaves the picture unfinished. It's made to run at ${want === 1 ? "1.0" : `${want} or more`}.`,
        actions: [] });
    }
  }
  return cards;
}

// ------------------------------------------------------------------ common problems: blurry, black, controlnet, detailers
/** A widget's real value: follows a link back to where it is set (LC Control Panel row, LC Slider, a primitive, or a
 * node whose output has the same name, like LC Sampler Configure). undefined when it can't be read. */
function valueOf(n, name) {
  const inp = n.inputs?.find((i) => (i.widget?.name === name || i.name === name) && i.link != null);
  if (!inp) return n.widgets?.find((w) => w.name === name)?.value;
  const link = app.graph.links?.[inp.link] || app.graph.links?.get?.(inp.link);
  const src = link && nodeById(link.origin_id);
  if (!src) return undefined;
  if (src.type === "LCControlPanel") {
    try {
      return JSON.parse(src.widgets?.find((w) => w.name === "rows")?.value || "[]")[link.origin_slot]?.value;
    } catch (_) {
      return undefined;
    }
  }
  const outName = src.outputs?.[link.origin_slot]?.name;
  const same = src.widgets?.find((w) => w.name === outName || w.name === name);
  if (same && typeof same.value !== "object") return same.value;
  const first = src.widgets?.find((w) => ["value", "Xf", "Xi", "number", "float", "int"].includes(w.name)) || (/Primitive/.test(src.type) ? src.widgets?.[0] : null);
  return first?.value;
}

const num = (v) => (typeof v === "number" && isFinite(v) ? v : undefined);
const DETAILERS = /^(LCSmartInpaint|LCSmartInpaintPipe|FaceDetailer|FaceDetailerPipe|DetailerForEach|DetailerForEachDebug)$/;
const CONTROLNETS = /^(ControlNetApply|ControlNetApplyAdvanced|ControlNetApplySD3|ControlNetInpaintingAliMamaApply|QwenImageDiffsynthControlnet|ZImageFunControlnet|ApplyControlNet.*)$/;

function vaeKind(file) {
  const f = base(file).toLowerCase();
  if (!f) return "";
  if (/flux2|flux\.2|klein/.test(f)) return "Flux 2";
  if (/qwen_image_2\.1|qwen21/.test(f)) return "Qwen-Image 2.1";
  if (/qwen_image_vae|qwen.?image.?vae|wan_?2\.1_vae/.test(f)) return "Qwen-Image";
  if (/sdxl|sd_xl|xl_vae|xlvae/.test(f)) return "SDXL";
  if (/sd15|vae-ft-mse|kl-f8|sd_1\.5/.test(f)) return "SD 1.5";
  if (/^ae\.|flux|ultraflux|z.?image|lumina/.test(f)) return "Flux 1";
  return "";
}

/** The family the run uses: {fam, file, node} */
async function runModel() {
  const K = await knowledge();
  for (const n of allNodes()) {
    if (!active(n) || (n.type !== "LCOptimizer" && n.type !== "LCOptimizerVideo")) continue;
    const bm = n.widgets?.find((w) => w.name === "base_model")?.value;
    const file = String(n.widgets?.find((w) => w.name === "model_file")?.value || "");
    const fam = (file && !/recommended/i.test(file) && familyByFile(K, file)) || K.families.find((f) => f.name === bm) || null;
    return { fam, file, node: n, vae: String(n.widgets?.find((w) => w.name === "vae")?.value || "") };
  }
  const ls = (await modelLoaders()).filter((m) => m.file);
  const multi = new Set(ls.map((m) => m.fam?.id || base(m.file))).size > 1;
  return ls[0] ? { fam: multi ? null : ls[0].fam, file: multi ? "" : ls[0].file, node: ls[0].node, vae: "", multi }
    : { fam: null, file: "", node: null, vae: "", multi: false };
}

const img2img = () => allNodes().some((n) => active(n) && /^VAEEncode/.test(n.type) && n.outputs?.some((o) => o.links?.length));

function denoiseSetting() {
  const MAP = { LCSamplerConfigure: "denoise", LCSamplerConfigurePipe: "denoise", LCSamplerConfigurePipeOut: "denoise",
    LCSamplerConfigureSimple: "denoise", LCSamplerConfigureSimplePipeOut: "denoise", KSampler: "denoise", BasicScheduler: "denoise", LCSigmas: "denoise" };
  for (const n of allNodes()) {
    if (!active(n) || !MAP[n.type] || linked(n, MAP[n.type])) continue;
    const v = num(n.widgets?.find((w) => w.name === MAP[n.type])?.value);
    if (v !== undefined) return { node: n, name: MAP[n.type], value: v };
  }
  return null;
}

export async function checkCommon() {
  const cards = [];
  const run = await runModel();
  // wrong VAE for the model: black or garbage pictures
  const want = vaeKind((run.fam?.vae?.variants || [])[0]?.file || "");
  const vaes = [...allNodes().filter((n) => active(n) && n.type === "VAELoader").map((n) => ({ n, file: n.widgets?.find((w) => w.name === "vae_name")?.value })),
    ...(run.vae && !/recommended|checkpoint/i.test(run.vae) ? [{ n: run.node, file: run.vae }] : [])];
  for (const v of vaes) {
    const have = vaeKind(v.file);
    if (want && have && have !== want && !/audio|video|minimax|ltx/i.test(v.file)) {
      cards.push({ level: 3, title: "The VAE doesn't fit the model", nodeId: where(v.n),
        text: `${base(v.file)} is a ${have} VAE, but ${run.fam.name} needs a ${want} VAE (${(run.fam.vae.variants[0] || {}).file}). A wrong VAE gives black, grey or scrambled pictures.`,
        actions: [] });
    }
  }
  // denoise vs where the picture starts
  const d = denoiseSetting();
  if (d && !img2img() && d.value < 0.9) {
    cards.push({ level: 3, title: "Denoise is low for a picture made from scratch", nodeId: where(d.node),
      text: `${label(d.node)} has denoise ${d.value}, but nothing feeds it a picture (no image to image). Below 1 the sampler stops before the noise is gone: a blurry, noisy or washed out result. Use 1.0 for text to image.`,
      actions: [{ label: "Set denoise 1.0", tip: `Changes ${label(d.node)}`, run: { set: [d.node, d.name, 1.0] } }] });
  }
  const mp = await modelPlan();
  // clip skip: 0 / -1 is normal, -2 for Pony and many anime SDXL models; further throws away most of the prompt
  for (const n of allNodes()) {
    if (!active(n) || n.type !== "CLIPSetLastLayer") continue;
    const v = num(valueOf(n, "stop_at_clip_layer"));
    if (v !== undefined && v < -2) {
      cards.push({ level: 1, title: `Clip skip ${v} is out of range`, nodeId: where(n),
        text: `Use -1 (normal) or -2 (Pony and many anime SDXL models). At ${v} the text encoder throws away most of what it understood, so the picture drifts from the prompt.`,
        actions: [{ label: "Set -2", tip: `Changes ${label(n)}`, run: { set: [n, "stop_at_clip_layer", -2] } }] });
    }
  }
  if (mp.p?.pony) {
    const cs = allNodes().filter((n) => active(n) && n.type === "CLIPSetLastLayer");
    const v = cs.length ? num(valueOf(cs[0], "stop_at_clip_layer")) : -1;
    if (v === -1) {
      cards.push({ level: 1, title: "Pony wants clip skip 2", nodeId: where(cs[0] || mp.run.node),
        text: "The Pony V6 model card says to use clip skip 2 (CLIP Set Last Layer at -2), otherwise you get low quality blobs.",
        actions: cs.length ? [{ label: "Set -2", tip: `Changes ${label(cs[0])}`, run: { set: [cs[0], "stop_at_clip_layer", -2] } }] : [] });
    }
  }
  // AuraFlow shift: 1 = no shift; the official templates use 3 (Z-Image), 3.1 (Qwen 2512), 1 (Chroma) or none
  for (const n of allNodes()) {
    if (!active(n) || n.type !== "ModelSamplingAuraFlow") continue;
    const v = num(valueOf(n, "shift"));
    if (v === undefined) continue;
    const off = mp.p?.auraShift;
    if (v < 1 || v > 10 || (off && v > off * 2.5)) {
      cards.push({ level: 1, title: `AuraFlow shift ${v} is out of whack`, nodeId: where(n),
        text: `${off ? `${mp.p.name}'s official setting is ${off}. ` : ""}Shift moves the steps between composition (higher) and detail (lower). ${v < 1 ? "Under 1 the picture never settles: mushy shapes." : "This high it spends almost every step on rough shapes, so fine detail comes out soft and smeary."} 1 to ${off ? Math.max(4, off + 1) : 6} is the usual range.`,
        actions: off ? [{ label: `Set ${off}`, tip: `Changes ${label(n)}`, run: { set: [n, "shift", off] } }] : [] });
    }
  }
  // MiniMax H3 on a distilled 8-step build: a low video shift draws a grid (Comfy docs)
  for (const n of allNodes()) {
    if (!active(n) || !/ModelSamplingMiniMaxH3/.test(n.type)) continue;
    const v = num(valueOf(n, "shift_video"));
    if (mp.fast && v !== undefined && v < 5) {
      cards.push({ level: 1, title: `Video shift ${v} on a turbo H3`, nodeId: where(n),
        text: "The ComfyUI docs warn that shift_video 3 gives grid artifacts on distilled 8-step builds. H3's built-in value is 12 (FastH3 uses 10).", actions: [] });
    }
  }
  // Flux guidance: only FLUX.1 dev / Krea dev use it (3.5 / 4.5 on the model cards)
  if (mp.p?.guidance) {
    const [want, lo, hi] = mp.p.guidance;
    for (const n of allNodes()) {
      if (!active(n) || n.type !== "FluxGuidance") continue;
      const v = num(valueOf(n, "guidance"));
      if (v !== undefined && (v < lo || v > hi)) {
        cards.push({ level: 1, title: `Flux guidance ${v} is out of bounds`, nodeId: where(n),
          text: `${mp.p.name}'s model card uses ${want}. ${v < lo ? "This low it barely follows the prompt: washed out and vague." : "This high it overcooks: plastic skin, harsh contrast and burnt colours."} ${lo} to ${hi} is the sensible range.`,
          actions: [{ label: `Set ${want}`, tip: `Changes ${label(n)}`, run: { set: [n, "guidance", want] } }] });
      }
    }
  }
  // steps and cfg nobody should use, for models without a profile (one model family only)
  const fileText = base(run.file).toLowerCase();
  if (!run.multi && !mp.p) {
    const { steps, cfg } = runSettings();
    const fast = /turbo|lightning|hyper|lcm|distill|schnell|4.?step|8.?step/i.test(`${fileText} ${run.fam?.name || ""}`);
    if (steps && steps.value < (fast ? 2 : 6)) {
      cards.push({ level: 1, title: `Only ${steps.value} steps`, nodeId: where(steps.node),
        text: "Too few steps for this model leaves the picture unfinished: blurry or noisy. Most models want 20 to 30 (turbo and lightning models 4 to 10).", actions: [] });
    }
    if (cfg && cfg.value > 12) {
      cards.push({ level: 1, title: `cfg ${cfg.value} is very high`, nodeId: where(cfg.node),
        text: "A cfg that high burns colours and adds harsh contrast. Most models want 3 to 8 (turbo and flow models 1 to 2).", actions: [] });
    }
  }
  // detailers that can't find or change anything
  for (const n of allNodes()) {
    if (!active(n) || !DETAILERS.test(n.type)) continue;
    const prompt = String(valueOf(n, "prompt") ?? valueOf(n, "detect_prompt") ?? "x").trim();
    const thr = num(valueOf(n, "threshold") ?? valueOf(n, "bbox_threshold"));
    const den = num(valueOf(n, "denoise"));
    const blend = num(valueOf(n, "blend"));
    const why = [];
    if (!prompt) why.push("its prompt (what to look for) is empty, so it finds nothing");
    if (thr !== undefined && thr > 0.75) why.push(`threshold ${thr} is strict: it only accepts a near-perfect match, so it often finds nothing (0.5 to start)`);
    if (den !== undefined && den < 0.12) why.push(`denoise ${den} is so low the redraw changes almost nothing (faces 0.3, hands 0.4 to 0.5)`);
    if (den !== undefined && den > 0.7) why.push(`denoise ${den} redraws from scratch: a different face or extra fingers (keep it under 0.6)`);
    if (blend !== undefined && blend < 0.25) why.push(`blend ${blend} pastes back almost none of the fix`);
    if (why.length) cards.push({ level: 1, title: `${label(n)} settings look off`, nodeId: where(n), text: why.map((w) => `- ${w}`).join("\n"), actions: [] });
  }
  // controlnet that can't do anything
  for (const n of allNodes()) {
    if (!active(n) || !CONTROLNETS.test(n.type)) continue;
    const st = num(valueOf(n, "strength"));
    const a = num(valueOf(n, "start_percent")), b = num(valueOf(n, "end_percent"));
    if (st !== undefined && st <= 0.01) {
      cards.push({ level: 1, title: `${label(n)} has strength ${st}`, nodeId: where(n), text: "At 0 the ControlNet does nothing. 0.8 to 1.0 is a normal start.",
        actions: [{ label: "Set strength 0.8", tip: `Changes ${label(n)}`, run: { set: [n, "strength", 0.8] } }] });
    }
    if (a !== undefined && b !== undefined && b <= a) {
      cards.push({ level: 1, title: `${label(n)} never switches on`, nodeId: where(n), text: `start_percent ${a} is not before end_percent ${b}, so it is active for no steps. Try 0 to 1 (or end around 0.8).`, actions: [] });
    }
    const imgIn = n.inputs?.find((i) => /image|hint|control_image/i.test(i.name));
    if (imgIn && imgIn.link == null) {
      cards.push({ level: 1, title: `${label(n)} has no picture to follow`, nodeId: where(n), text: "Its image input isn't connected, so there is nothing to guide the shape.", actions: [] });
    }
  }
  return cards;
}

/** Plain facts behind a complaint ("my image is blurry"), for the chat: the settings that cause it, with a verdict. */
export async function symptomReport(question) {
  const q = String(question || "").toLowerCase();
  const asks = {
    blurry: /blur|soft|smear|mushy|out of focus|fuzzy|not sharp|low.?detail|dirty glass|grain|noisy|noise/.test(q),
    black: /black|blank|grey|gray|empty image|nothing (shows|comes)|all one colou?r|scrambled|garbage|nan/.test(q),
    controlnet: /control.?net|pose|depth|canny|doesn.?t follow|ignores (my|the) (image|picture|pose)/.test(q),
    detailer: /detailer|face fix|hands? fix|inpaint|didn.?t (fix|change)|not (getting|finding|detecting)/.test(q),
  };
  if (!Object.values(asks).some(Boolean)) return [];
  const run = await runModel();
  const { steps, cfg } = runSettings();
  const d = denoiseSetting();
  const mp = await modelPlan();
  const rule = mp.p ? { name: mp.p.name + (mp.fast && mp.loras?.length ? ` with ${mp.loras[0].name}` : ""), steps: mp.steps, cfg: mp.cfg } : null;
  const out = [`SYMPTOM CHECK (the settings that cause what the user describes; answer from these first, name the ones marked SUSPECT, and don't blame switched-off optional parts unless they are listed here):`];
  const fact = (txt, bad) => out.push(`- ${bad ? "SUSPECT: " : "ok: "}${txt}`);
  const modelName = base(run.file) || run.fam?.name || "unknown";
  if (asks.blurry || asks.black) {
    fact(`model ${modelName}${rule ? ` (${rule.name}, wants ${rule.steps[0]}-${rule.steps[1]} steps${rule.cfg ? `, cfg ${rule.cfg[0]}-${rule.cfg[1]}` : ""})` : ""}`, false);
    if (steps) fact(`steps ${steps.value} (set on ${label(steps.node)})`, rule ? steps.value < rule.steps[0] * 0.7 : steps.value < 6);
    if (cfg) fact(`cfg ${cfg.value}`, rule?.cfg ? cfg.value < rule.cfg[0] - 0.75 || cfg.value > rule.cfg[1] + 1.5 : cfg.value > 12);
    if (d) fact(`denoise ${d.value}, ${img2img() ? "image to image is ON" : "text to image (no input picture)"}`, !img2img() && d.value < 0.9);
  }
  if (asks.black) {
    const want = vaeKind((run.fam?.vae?.variants || [])[0]?.file || "");
    const vaes = allNodes().filter((n) => active(n) && n.type === "VAELoader").map((n) => n.widgets?.find((w) => w.name === "vae_name")?.value);
    if (run.vae) vaes.push(run.vae);
    for (const v of vaes) fact(`VAE ${base(v)}${want ? ` (the model needs a ${want} VAE)` : ""}`, !!(want && vaeKind(v) && vaeKind(v) !== want));
    if (!vaes.length) fact("no separate VAE loader (it comes from the checkpoint or Anything Everywhere)", false);
  }
  if (asks.controlnet) {
    const cn = allNodes().filter((n) => CONTROLNETS.test(n.type));
    if (!cn.length) fact("no ControlNet node in this workflow", true);
    for (const n of cn) {
      const st = num(valueOf(n, "strength"));
      fact(`${label(n)} is ${active(n) ? "ON" : "OFF (bypassed: turn it on with its switch)"}${st !== undefined ? `, strength ${st}` : ""}`, !active(n) || (st !== undefined && st <= 0.01));
    }
  }
  if (asks.detailer) {
    const ds = allNodes().filter((n) => DETAILERS.test(n.type));
    if (!ds.length) fact("no detailer node in this workflow", true);
    for (const n of ds) {
      const bits = ["prompt", "threshold", "denoise", "blend"].map((k) => [k, valueOf(n, k)]).filter(([, v]) => v !== undefined).map(([k, v]) => `${k} ${typeof v === "string" ? JSON.stringify(v.trim()) : v}`);
      const den = num(valueOf(n, "denoise")), thr = num(valueOf(n, "threshold"));
      fact(`${label(n)} is ${active(n) ? "ON" : "OFF (bypassed)"}: ${bits.join(", ")}`, !active(n) || (den !== undefined && (den < 0.12 || den > 0.7)) || (thr !== undefined && thr > 0.75) || String(valueOf(n, "prompt") ?? "x").trim() === "");
    }
  }
  return out;
}

export async function checkAll() {
  const out = [];
  GATES.clear(); // accepted a license since the last check? ask again
  for (const f of [checkSwaps, checkNotes, checkErrors, checkCorruption, checkBrokenNodes, checkMissingFiles, checkGatedDownloads, checkClipType, checkStepsModel, checkCommon, checkModelFormat, checkOptimization]) {
    try {
      out.push(...(await f()));
    } catch (e) {
      console.warn("[Vision Assistant] check failed", f.name, e);
    }
  }
  return out;
}

// ------------------------------------------------------------------ card actions
export function nodeById(id) {
  return nodes().find((n) => String(n.id) === String(id));
}

export function showNode(id) {
  const n = nodeById(id);
  if (!n) return;
  try {
    highlight([n]);
  } catch (_) {
    app.canvas.centerOnNode?.(n);
  }
}

export function setWidget(id, name, value) {
  const n = typeof id === "object" ? id : nodeById(id);
  const w = n?.widgets?.find((x) => x.name === name);
  if (!w) return false;
  w.value = value;
  try {
    w.callback?.(value, app.canvas, n);
  } catch (_) {}
  app.graph.setDirtyCanvas(true, true);
  return true;
}

export function addNear(id, type) {
  const n = nodeById(id);
  const m = LiteGraph.createNode(type);
  if (!n || !m) return null;
  app.graph.add(m);
  m.pos = [n.pos[0] + (n.size?.[0] || 200) + 40, n.pos[1]];
  app.graph.setDirtyCanvas(true, true);
  return m;
}

/** Glow every node a card is about. */
export function showNodes(ids) {
  highlight(ids.map(nodeById).filter(Boolean));
}

/** The fixes on a card that change the workflow (not links): what the chat may offer to do. */
export const fixesOf = (c) => (c.actions || []).filter((a) => a.run && typeof a.run === "object");

/** Carry out one card fix. Returns true when it worked. */
export function runFix(a) {
  const r = a.run || {};
  if (r.set) return setWidget(...r.set) && (!r.also || setWidget(...r.also));
  if (r.add) return !!addNear(...r.add);
  if (r.quant) return !!addQuantize(...r.quant);
  if (r.repair) return repair().fixed > 0;
  return false;
}
