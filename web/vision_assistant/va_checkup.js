// Vision Assistant checkup: plain rules over the open workflow and this machine. No AI involved; the chat explains and
// acts on these. Each check returns cards: {level, title, text, actions:[{label, tip, run | href}], nodeId}.
// level: 3 = problem, 1 = worth changing, 0 = info.
import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { REPLACEMENTS } from "./va_replacements.js";
import { highlight } from "./va_glow.js";
import { findDamage, repair } from "./va_corrupt.js";

let KNOW = null;
let SYS = null; // {gpu, vram, gen, comfy}
let PROFILE = undefined; // LC123 system report (null = none yet, undefined = not asked)
let lastError = null;

export async function knowledge() {
  if (!KNOW) {
    try {
      KNOW = await (await fetch(new URL("./va_knowledge.json", import.meta.url))).json();
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
    SYS = { gpu: name || "unknown GPU", vram: (d.vram_total || 0) / 1024 ** 3, gen: gpuGen(name), comfy: s.system?.comfyui_version };
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
  const fits = (gb) => gb && gb <= sys.vram * 0.9;
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
    const tooBig = gb && !fits(gb);
    if (!bad && !wasteful && !tooBig) continue;
    // the same model in a format that suits this card: a stock sibling when it is a stock file, else a quant of this file
    const pickFmt = prefer.find((f) => QUANT_LABEL[f] && !NEEDS.some(([rx, gens]) => rx.test(f) && !gens.includes(sys.gen)) && (!full || fits(full * SIZE(f)))) || "gguf_q4_k_m";
    const sib = curV && vs.find((v) => (v.format === pickFmt || v.format.startsWith(pickFmt)) && fits(v.gb));
    const why = bad ? `It's ${FMT_NAME(cur)}, which ${bad[2]}.`
      : wasteful ? `It's fp32: twice the size of bf16 with no better pictures.`
      : `It's about ${gb} GB and your ${sys.gpu} has ${Math.round(sys.vram)} GB, so ComfyUI has to swap it in and out and it runs much slower.`;
    const have = sib && onDisk(node, sib.file);
    cards.push({
      level: bad || gb > sys.vram * 1.5 ? 3 : 1,
      title: bad ? `${base(file)} won't run well on your card` : wasteful ? `${base(file)} is bigger than it needs to be` : `${base(file)} is too big for your card`,
      text: `${label(node)} loads ${base(file)}. ${why} `
        + (sib ? `The same model as ${FMT_NAME(sib.format)} (${sib.file}${sib.gb ? `, ${sib.gb} GB` : ""}) suits your card.`
          : `A ${FMT_NAME(pickFmt)} copy of the same file suits your card${full ? ` (about ${Math.round(full * SIZE(pickFmt))} GB)` : ""}. LC Model Quantize makes it${q ? "" : " (LC ModelBuilder pack)"}${/^(bf16|fp16|fp32)$/.test(cur) ? "" : " from the bf16 file"}.`),
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
      for (const fam of K.families) for (const role of ["diffusion", "text_encoder", "vae"]) {
        const v = (fam[role]?.variants || []).find((x) => x.file.toLowerCase() === file.toLowerCase());
        if (v?.repo) repo = v.repo;
      }
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
      cards.push({
        level: 3, title: `Missing: ${file}`,
        text: `${label(n)} needs ${file}${folder ? ` in models/${folder}` : ""}.` + (repo ? " You can get it here:" : " I don't know where it comes from, so here's a search:"),
        nodeId: where(n),
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

export async function checkAll() {
  const out = [];
  for (const f of [checkErrors, checkCorruption, checkBrokenNodes, checkMissingFiles, checkClipType, checkModelFormat, checkOptimization]) {
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
