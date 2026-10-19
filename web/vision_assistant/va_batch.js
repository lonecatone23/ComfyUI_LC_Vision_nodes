// Vision Assistant, Batch snapshot: a look at the run before it starts. When Run is pressed it checks the run count,
// batch sizes, seed modes, output size and upscale factors, and only stops to ask when something looks like a mistake
// (100 images at an ultra upscale, 200 runs on a fixed seed). It also says which of those settings changed since the
// workflow was opened, so an accidental edit stands out from a deliberate one.
import { app } from "../../../scripts/app.js";

const SETTING = "LCVision.BatchSnapshot.Enabled";
const MANY_IMAGES = 16; // more than this in one go gets a question
const BIG_PIXELS = 4.2e6; // about 2048 x 2048
const HIGH_UPSCALE = 3.0;
const MANY_STEPS = 60;
const BIG_BATCH = 4; // a big upscale or big pictures only get a question from this many images up

const nodes = () => (app.graph?._nodes || []).filter((n) => n.mode !== 2 && n.mode !== 4); // muted / bypassed nodes don't run
const label = (n) => (n.title && n.title !== n.type ? n.title : (n.constructor?.title || n.type));
// numbers, and number-like text such as "2x" or "1.5x" (combo upscale sizes)
const num = (v) => {
  if (typeof v === "number" && isFinite(v)) return v;
  const m = typeof v === "string" ? v.trim().match(/^(\d+(?:\.\d+)?)\s*x?$/i) : null;
  return m ? parseFloat(m[1]) : null;
};

/** A widget's real value: when it is wired to another node (a combo selector, a primitive), read that node. */
function valueOf(n, w) {
  const inp = (n.inputs || []).find((i) => i.name === w.name && i.link != null);
  if (inp) {
    const link = app.graph.links?.[inp.link] ?? app.graph.links?.get?.(inp.link);
    const src = link && app.graph.getNodeById(link.origin_id);
    const sw = src && ((src.widgets || []).find((x) => x.name === "value") || (src.widgets || [])[0]);
    if (sw && num(sw.value) !== null) return num(sw.value);
  }
  return num(w.value);
}

function widget(n, re) {
  const w = (n.widgets || []).find((x) => re.test(x.name || "") && valueOf(n, x) !== null);
  return w ? { name: w.name, value: valueOf(n, w) } : null;
}

/** The settings that decide how big a run is, read from the open workflow. */
export function read(runs) {
  const out = { runs: Math.max(1, runs || 1), batch: 1, batchNodes: [], fixedSeeds: [], size: null, upscale: null, steps: null };
  for (const n of nodes()) {
    const b = widget(n, /^(batch_size|batch)$/i);
    if (b && b.value > 1) {
      out.batchNodes.push({ node: n, name: b.name, value: b.value });
      out.batch = Math.max(out.batch, b.value);
    }
    const ctl = (n.widgets || []).find((w) => /^control_(after|before)_generate$/.test(w.name || ""));
    // only image seeds matter here (samplers, noise, seed nodes): a fixed LLM seed just repeats the prompt rewrite
    if (ctl && ctl.value === "fixed" && /sampler|noise|seed/i.test(n.type) && !/vision|caption|prompt|enhanc|llm|chat/i.test(n.type)) out.fixedSeeds.push({ node: n });
    const w = widget(n, /^width$/i);
    const h = widget(n, /^height$/i);
    const longSide = widget(n, /^max_resolution$/i); // LC Aspect Ratio Simplifier: the long side, the ratio from a preset
    if (w && h && /latent|empty|size|resolution|aspect/i.test(n.type + " " + label(n))) {
      const px = w.value * h.value;
      if (!out.size || px > out.size.px) out.size = { node: n, w: w.value, h: h.value, px, name: w.name };
    } else if (longSide) {
      const px = longSide.value * longSide.value * 0.75; // a 4:3-ish frame: close enough to warn
      if (!out.size || px > out.size.px) out.size = { node: n, w: longSide.value, h: Math.round(longSide.value * 0.75), px, name: longSide.name };
    }
    const up = widget(n, /^(scale_by|upscale_by|upscale|scale|factor|upscale_factor)$/i);
    if (up && /upscal|scale/i.test(n.type + " " + label(n)) && up.value > 1) {
      if (!out.upscale || up.value > out.upscale.value) out.upscale = { node: n, name: up.name, value: up.value };
    }
    const st = widget(n, /^steps$/i);
    if (st && (!out.steps || st.value > out.steps.value)) out.steps = { node: n, value: st.value };
  }
  out.images = out.runs * out.batch;
  return out;
}

/** Things that look like a mistake, worst first: [{lvl, text}] (lvl 3 = stop and ask, 1 = mention). */
export function findings(info, changedSince) {
  const out = [];
  const was = (n, name) => {
    const c = changedSince?.find((x) => String(x.key.id) === String(n.id) && x.name === name);
    return c ? ` (changed from ${c.from} since you opened the workflow)` : "";
  };
  if (info.images > MANY_IMAGES) {
    const parts = [`${info.runs} run${info.runs === 1 ? "" : "s"}`];
    if (info.batch > 1) parts.push(`batch ${info.batch}`);
    out.push({ lvl: 3, text: `This makes ${info.images} images (${parts.join(" × ")}).`
      + info.batchNodes.map((b) => ` ${label(b.node)}: ${b.name} ${b.value}${was(b.node, b.name)}.`).join("") });
  }
  if (info.runs > 1 && info.fixedSeeds.length) {
    out.push({ lvl: 3, text: `${info.runs} runs, but the seed is fixed on ${info.fixedSeeds.map((s) => label(s.node)).join(", ")}: `
      + "every run makes the same picture. Set it to increment or randomize." + info.fixedSeeds.map((s) => was(s.node, "control_after_generate")).join("") });
  }
  const outPx = info.size ? info.size.px * (info.upscale ? info.upscale.value ** 2 : 1) : null;
  if (info.upscale && info.upscale.value >= HIGH_UPSCALE && info.images >= BIG_BATCH) {
    out.push({ lvl: 3, text: `${label(info.upscale.node)} upscales ${info.upscale.value}x${was(info.upscale.node, info.upscale.name)}, on ${info.images} images`
      + (outPx ? ` (each about ${Math.round(Math.sqrt(outPx * info.size.w / info.size.h))} x ${Math.round(Math.sqrt(outPx * info.size.h / info.size.w))}).` : ".") });
  } else if (outPx && outPx > BIG_PIXELS && info.images >= BIG_BATCH) {
    out.push({ lvl: 3, text: `${info.images} images at about ${(outPx / 1e6).toFixed(1)} megapixels each${was(info.size.node, info.size.name)}.` });
  }
  if (info.steps && info.steps.value > MANY_STEPS) {
    out.push({ lvl: 1, text: `${label(info.steps.node)} is set to ${info.steps.value} steps${was(info.steps.node, "steps")}.` });
  }
  return out.sort((a, b) => b.lvl - a.lvl);
}

/** One line for the Snapshots tab: what the next Run would make. */
export function summaryLine(runs) {
  const i = read(runs);
  const bits = [`${i.images} image${i.images === 1 ? "" : "s"}`];
  if (i.size) bits.push(`${i.size.w} x ${i.size.h}`);
  if (i.upscale) bits.push(`upscale ${i.upscale.value}x`);
  if (i.fixedSeeds.length) bits.push("seed fixed");
  return bits.join(" · ");
}

function queuedRuns() {
  try {
    const s = window.comfyAPI?.queueSettingsStore?.useQueueSettingsStore?.() || null;
    if (s?.batchCount) return s.batchCount;
  } catch (_) {}
  return 1;
}

async function ask(list, info) {
  const msg = list.map((f) => `• ${f.text}`).join("\n") + "\n\nRun anyway?";
  const dlg = app.extensionManager?.dialog;
  if (dlg?.confirm) return (await dlg.confirm({ title: `Batch snapshot: ${info.images} image${info.images === 1 ? "" : "s"}`, message: msg })) === true;
  return window.confirm(msg);
}

/** Wraps Run once. getChanges() returns what changed since the workflow was opened (from the snapshot baseline). */
export function guard(getChanges) {
  if (app._lcBatchGuard) return;
  app._lcBatchGuard = true;
  const orig = app.queuePrompt;
  app.queuePrompt = async function (number, batchCount, ...rest) {
    try {
      if (app.extensionManager?.setting?.get?.(SETTING) !== false) {
        const info = read(batchCount || queuedRuns());
        const list = findings(info, getChanges?.() || []).filter((f) => f.lvl >= 3);
        if (list.length && !(await ask(findings(info, getChanges?.() || []), info))) {
          try {
            app.extensionManager.toast.add({ severity: "info", summary: "Batch snapshot", detail: "Run cancelled. Nothing was queued.", life: 3500 });
          } catch (_) {}
          return false;
        }
      }
    } catch (e) {
      console.warn("[Batch snapshot] check skipped:", e); // a check that breaks must never block a run
    }
    return orig.call(this, number, batchCount, ...rest);
  };
}

export { SETTING };
