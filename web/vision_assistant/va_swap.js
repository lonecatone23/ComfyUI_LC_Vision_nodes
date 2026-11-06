// Swap for LC nodes: nodes from other packs that have an LC twin doing the same job. The checkup lists them first;
// you tick the ones to swap. Values carry over by name (with the renames below), every wire is reconnected by socket
// name, and the new node takes the old one's place. A node is only offered when every wired socket has a home on
// the LC node. Idea from AusBoss's "Replace with AusBoss nodes" (ComfyUI-AusBoss, MIT); written from scratch.
import { app } from "../../../scripts/app.js";
import { WIDGET_ORDER } from "./va_swap_widgets.js";

// the LC Vision Loader a QwenVL swap adds in front of the LC node: same GGUF model when LC sees it
const VISION_LOADER = {
  type: "LCVisionLoader", input: "vision_model",
  set: (old) => {
    const want = String(old.widgets?.find((w) => w.name === "model_name")?.value || "").replace(/^\[local\]\s*/i, "").replace(/\.gguf$/i, "");
    const opts = LiteGraph.registered_node_types?.LCVisionLoader?.nodeData?.input?.required?.model_name?.[0] || [];
    return opts.includes(want) ? { model_name: want } : {};
  },
};

// from: other pack's node type. to: LC node type. names: old socket/setting name -> LC name (both inputs and
// outputs; unlisted names stay the same). set(old, values): extra LC settings worked out from the old node.
// Every entry also needs its setting names in va_swap_widgets.js, or it can't be swapped when its pack is missing.
export const SWAPS = [
  // -1 is "random every run" in both; rgthree's -2 / -3 (increment / decrement) have no LC twin, so they become random too
  { from: "Seed (rgthree)", to: "LCSeed", names: { seed: "base_seed", SEED: "seed" }, set: (old) => (Number(old.widgets?.find((w) => w.name === "seed")?.value) < 0 ? { base_seed: -1 } : {}) },
  // CR Seed and easy seed name both the widget and the output "seed": copy the widget in set() so the output keeps its name
  { from: "CR Seed", to: "LCSeed", names: {}, drop: ["seed"], set: (old) => ({ base_seed: Number(old.widgets?.find((w) => w.name === "seed")?.value) || 0 }) },
  // the second step count (rgthree's refiner_step) becomes LC's detailer_steps; denoise stays at its default 1
  {
    from: "KSampler Config (rgthree)", to: "LCSamplerConfigureSimple",
    names: { steps_total: "total_steps", refiner_step: "detailer_steps", STEPS: "total_steps", REFINER_STEP: "detailer_steps", CFG: "cfg",
             SAMPLER: "sampler_name", SCHEDULER: "scheduler" },
  },
  { from: "easy seed", to: "LCSeed", names: {}, drop: ["seed"], set: (old) => ({ base_seed: Number(old.widgets?.find((w) => w.name === "seed")?.value) || 0 }) },
  { from: "Display Any (rgthree)", to: "LCShowAny", names: { source: "any" } },
  { from: "easy showAnything", to: "LCShowAny", names: { anything: "any" } },
  { from: "ShowText|pysssss", to: "LCShowText", names: { STRING: "text" } },
  // same modes, volume and sound list (LC ships pysssss's notify.mp3); a custom sound file LC doesn't have keeps LC's default
  { from: "PlaySound|pysssss", to: "LCNotify", names: { "*": "any" } },
  // one strength per LC row: only offered when the model and clip strengths match (or nothing is wired to clip)
  {
    from: "LoraLoader|pysssss", to: "LCLoraLoader", names: { MODEL: "model", CLIP: "clip" }, drop: ["lora_name", "strength_model", "strength_clip", "prompt"],
    when: (old) => {
      const val = (n) => Number(old.widgets?.find((w) => w.name === n)?.value ?? 1);
      return old.inputs?.find((i) => i.name === "clip")?.link == null || val("strength_model") === val("strength_clip");
    },
    whyNot: "its model and clip strengths differ, and an LC LoRA row has one strength",
    set: (old) => {
      const val = (n) => old.widgets?.find((w) => w.name === n)?.value;
      const lora = val("lora_name");
      return { lora_rows: JSON.stringify(typeof lora === "string" && lora && lora !== "None" ? [{ on: true, lora, strength: Number(val("strength_model") ?? 1) }] : []) };
    },
    after: (fresh) => fresh.onConfigure?.({}),
  },
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
  // Note Pixaroma -> LC Note lives in NOTE_SWAPS (its own checkup card, with every other note type)
  { from: "PixaromaCompare", to: "LCBatchImageComparer", names: { image1: "image_a", image2: "image_b" }, missingOk: true },
  // mxToolkit: the slider's real settings live in node properties (value, min, max, step, decimals); Xi / Xf / isfloatX
  // are its hidden storage and have no LC twin
  {
    from: "mxSlider", to: "LCSlider", names: { X: "*" }, missingOk: true,
    set: (old) => {
      const p = old.properties || {};
      const num = (v, fb) => (Number.isFinite(Number(v)) ? Number(v) : fb);
      return { value: num(p.value, 20), min: num(p.min, 0), max: num(p.max, 100), step: num(p.step, 1) > 0 ? num(p.step, 1) : 1, decimals: Math.max(0, Math.min(4, Math.floor(num(p.decimals, 0)))) };
    },
  },
  { from: "mxSeed", to: "LCSeed", names: { X: "seed" }, missingOk: true, set: (old) => ({ base_seed: Number(old.widgets?.find((w) => w.name === "X")?.value ?? old.widgets_values?.[0]) || 0 }) },
  // the 2D slider becomes LC Size Pad: X is the width, Y the height (Custom keeps the exact numbers)
  {
    from: "mxSlider2D", to: "LCSizePad", names: { X: "width", Y: "height" }, missingOk: true,
    set: (old) => {
      const p = old.properties || {};
      const w = Math.round(Number(p.valueX) || 1024), h = Math.round(Number(p.valueY) || 1024);
      return { model: "Custom", aspect: "free", width: w, height: h, megapixels: Math.round((w * h) / 1e4) / 100 };
    },
  },
  // rgthree LoRA loaders: every LoRA row (on / file / strength) becomes an LC LoRA Loader row
  {
    from: "Power Lora Loader (rgthree)", to: "LCLoraLoader", names: { MODEL: "model", CLIP: "clip" },
    set: (old) => ({ lora_rows: JSON.stringify((old.widgets || []).map((w) => w.value)
      .filter((v) => v && typeof v === "object" && typeof v.lora === "string" && v.lora && v.lora !== "None")
      .map((v) => ({ on: v.on !== false, lora: v.lora, strength: Number(v.strength ?? 1) }))) }),
    after: (fresh) => fresh.onConfigure?.({}),
  },
  {
    from: "Lora Loader Stack (rgthree)", to: "LCLoraLoader", names: { MODEL: "model", CLIP: "clip" },
    drop: ["lora_01", "strength_01", "lora_02", "strength_02", "lora_03", "strength_03", "lora_04", "strength_04"],
    set: (old) => {
      const val = (n) => old.widgets?.find((w) => w.name === n)?.value;
      const rows = [1, 2, 3, 4].map((i) => ({ lora: val(`lora_0${i}`), strength: Number(val(`strength_0${i}`) ?? 1) }))
        .filter((r) => typeof r.lora === "string" && r.lora && r.lora !== "None").map((r) => ({ on: true, ...r }));
      return { lora_rows: JSON.stringify(rows) };
    },
    after: (fresh) => fresh.onConfigure?.({}),
  },
  // 1038lab's RMBG: blur -> feather, offset -> grow; RMBG-2.0 stays RMBG-2.0, anything else gets LC's default BiRefNet
  ...["RMBG", "BiRefNetRMBG"].map((from) => ({
    from, to: "LCRemBG", names: { IMAGE: "cutout", MASK: "mask", mask_offset: "grow", mask_blur: "feather" },
    drop: ["model", "sensitivity", "process_res", "invert_output", "refine_foreground", "unload_model", "background", "background_color"],
    set: (old) => {
      const m = String(old.widgets?.find((w) => w.name === "model")?.value || "");
      const opts = LiteGraph.registered_node_types?.LCRemBG?.nodeData?.input?.required?.model?.[0] || [];
      const rmbg = /rmbg[-_ ]?2/i.test(m) && opts.find((o) => /RMBG-2\.0/.test(o));
      return rmbg ? { model: rmbg } : {};
    },
  })),
  // AILab / huchukato QwenVL: the model loads in the node there, LC Vision splits it into LC Vision Loader + the task node
  ...["AILab_QwenVL_GGUF_PromptEnhancer", "AILab_QwenVL_PromptEnhancer", "QwenVL_Unified_PromptEnhancer"].map((from) => ({
    from, to: "LCVisionPromptEnhancer", names: { ENHANCED_OUTPUT: "text" }, companion: VISION_LOADER,
    drop: ["model_name", "quantization", "attention_mode", "use_torch_compile", "device", "preset_system_prompt", "enhancement_style",
           "camera_tag", "style_tag", "english_output", "keep_model_loaded", "keep_last_prompt", "passthrough", "duration"],
    set: (old) => {
      const val = (n) => old.widgets?.find((w) => w.name === n)?.value;
      const presets = LiteGraph.registered_node_types?.LCVisionPromptEnhancer?.nodeData?.input?.required?.preset?.[0] || [];
      const want = String(val("preset_system_prompt") ?? val("enhancement_style") ?? "").replace(/^[^A-Za-z]+/, "").trim();
      const style = { "[ANIME]": "Anime", "[PHOTOREALISTIC]": "Realistic", "[CARTOON]": "Cartoon", "[SEMIREALANIME]": "Anime" }[val("style_tag")] || "None";
      return { ...(presets.includes(want) ? { preset: want } : {}), style_tag: style };
    },
  })),
  ...["AILab_QwenVL", "AILab_QwenVL_Advanced", "AILab_QwenVL_GGUF", "AILab_QwenVL_GGUF_Advanced", "QwenVL_Unified", "QwenVL_Unified_Advanced"].map((from) => ({
    from, to: "LCVisionCaption", companion: VISION_LOADER,
    names: { RESPONSE: "text", image: "reference_image_1", image2: "reference_image_2", image3: "reference_image_3", video: "reference_video" },
    drop: ["model_name", "quantization", "attention_mode", "use_torch_compile", "device", "preset_prompt", "camera_tag", "keep_model_loaded",
           "keep_last_prompt", "passthrough", "duration", "frame_count", "num_beams", "ctx", "n_batch", "gpu_layers", "image_max_tokens",
           "top_k", "pool_size"],
    // their preset is a canned task; an empty prompt there means "use the preset", so give LC a plain description request
    set: (old) => ({ prompt: String(old.widgets?.find((w) => w.name === "prompt")?.value || "").trim() || "Describe this image in detail." }),
  })),

  // Mira (mirabarukaso, MIT). Its seed widget and output are both "seed": copy the widget in set() so the output keeps its name
  { from: "SeedGeneratorMira", to: "LCSeed", names: {}, drop: ["seed"], set: (old) => ({ base_seed: Number(old.widgets?.find((w) => w.name === "seed")?.value) || 0 }) },
  { from: "TextBoxMira", to: "LCPositive", names: { text: "positive" } },
  // Mira joins with no separator
  { from: "TextCombinerTwo", to: "LCJoinStrings", names: { text1: "string_1", text2: "string_2", text: "string" }, set: () => ({ inputcount: 2, delimiter: "" }) },
  {
    from: "TextCombinerSix", to: "LCJoinStrings",
    names: { ...Object.fromEntries([1, 2, 3, 4, 5, 6].map((i) => [`text${i}`, `string_${i}`])), text: "string" },
    set: () => ({ inputcount: 6, delimiter: "" }),
  },
  // its "result" STRING output has no home, so it is only offered when that output is unwired
  { from: "LogicNot", to: "LCBooleanFlip", names: { bool: "boolean", not_bool: "boolean" } },
  { from: "SingleBooleanTrigger", to: "LCBooleanValue", names: { bool: "BOOLEAN" }, drop: ["bool"], set: (old) => ({ value: !!old.widgets?.find((w) => w.name === "bool")?.value }) },
  {
    from: "OneFloat", to: "LCSlider", names: { float_1: "*" }, drop: ["float_1"],
    set: (old) => {
      const v = Number(old.widgets?.find((w) => w.name === "float_1")?.value ?? 1);
      return { value: v, min: Math.min(0, Math.floor(v)), max: Math.max(1, Math.ceil(Math.abs(v) * 2)), step: 0.01, decimals: 2 };
    },
  },
  { from: "StepsAndCfg", to: "LCSamplerConfigureSimple", names: { steps: "total_steps", STEPS: "total_steps", CFG: "cfg" } },
  // Mira canvas -> LC Size Pad Custom; Landscape swaps W/H. Advanced's Batch / HiRes outputs have no home (offered only when unwired)
  ...["CanvasCreatorBasic", "CanvasCreatorSimple", "CanvasCreatorAdvanced"].map((from) => ({
    from, to: "LCSizePad", names: { Width: "width", Height: "height" }, drop: ["Width", "Height", "Landscape", "Batch", "HiResMultiplier"],
    set: (old) => {
      const val = (n) => old.widgets?.find((w) => w.name === n)?.value;
      let w = Math.max(16, Math.round(Number(val("Width")) || 576)), h = Math.max(16, Math.round(Number(val("Height")) || 1024));
      if (val("Landscape") === true) [w, h] = [h, w];
      return { model: "Custom", aspect: "free", width: w, height: h, megapixels: Math.round((w * h) / 1e4) / 100 };
    },
  })),
  // torchvision grayscale = Rec.601 (Mira's own node only does frame 0 and outputs 1 channel, so this also fixes it)
  { from: "ImageGrayscale", to: "LCImageDesaturate", names: { src_image: "image" }, set: () => ({ factor: 1, method: "luminance (Rec.601)" }) },
  // both rotate HSV hue: Mira's level is in turns (-0.5..0.5), LC hue -1..1 = ±180°
  {
    from: "ImageHUE", to: "LCImageAdjust", names: { src_image: "image" }, drop: ["level"],
    set: (old) => ({ hue: 2 * (Number(old.widgets?.find((w) => w.name === "level")?.value) || 0), saturation: 0, brightness: 0, contrast: 0, sharpness: 0 }),
  },

  // PDuse (7BEII, MIT)
  { from: "PD_ShowText", to: "LCShowText", names: { STRING: "text" } },
  { from: "PDStringInput", to: "LCPositive", names: { value: "positive", string: "positive" } },
  { from: "PDStringConcate", to: "LCJoinStrings", names: { string1: "string_1", string2: "string_2", joined_string: "string" }, set: () => ({ inputcount: 2 }) },
  { from: "PD_JoinStringMultiLine", to: "LCJoinStrings", names: { combined_string: "string" }, set: () => ({ inputcount: 2, delimiter: "\\n" }) },
  { from: "PD_GetImageSize", to: "LCGetImage", names: {} },
  // its name / strength STRING outputs have no home, so a node using them stays put
  {
    from: "PD_lora_loader", to: "LCLoraLoaderSingle", names: { MODEL: "model" }, drop: ["lora_name", "strength_model"],
    set: (old) => {
      const val = (n) => old.widgets?.find((w) => w.name === n)?.value;
      const lora = val("lora_name");
      return { lora_rows: JSON.stringify(typeof lora === "string" && lora && lora !== "None" ? [{ on: true, lora, strength: Number(val("strength_model") ?? 1) }] : []) };
    },
    after: (fresh) => fresh.onConfigure?.({}),
  },
  // PD's own node can't run (FUNCTION name mismatch), so the swap also makes old workflows work
  {
    from: "PDIMAGE_ImageCombine", to: "LCImageStitchMulti", names: { image1: "image_01", image2: "image_02", IMAGE: "image" }, drop: ["match_image_size"],
    set: (old) => ({ match_size: old.widgets?.find((w) => w.name === "match_image_size")?.value === false ? "off" : "match first" }),
  },

  // PlagueKind (MIT). Visual Crop: 0-1 fractions -> LC's 0-100 percent; only the image output has a home
  {
    from: "VisualBBoxCrop", to: "LCImageCrop", names: {}, drop: ["custom_ratio_w", "custom_ratio_h", "show_crop_values"],
    set: (old) => {
      const val = (n, fb) => { const v = Number(old.widgets?.find((w) => w.name === n)?.value); return Number.isFinite(v) ? v : fb; };
      const pct = (v, lo) => Math.round(Math.min(100, Math.max(lo, v * 100)) * 10) / 10;
      const ar = String(old.widgets?.find((w) => w.name === "aspect_ratio")?.value || "Free");
      const aspect = ["1:1", "4:3", "3:2", "16:9", "3:4", "2:3", "9:16"].includes(ar) ? ar : "free";
      return { x: pct(val("crop_x", 0), 0), y: pct(val("crop_y", 0), 0), width: pct(val("crop_w", 1), 0.5), height: pct(val("crop_h", 1), 0.5), aspect };
    },
  },
  // LoRA stack (LTX / MiniMax H3): exact in normal mode, or when every used row's video / audio / text multiplier is 1
  {
    from: "LTX_lora_loader", to: "LCLoraLoader", names: {}, drop: ["mode", "stack_data"],
    when: (old) => {
      const mode = old.widgets?.find((w) => w.name === "mode")?.value || "normal";
      return mode === "normal" || pkRows(old).every((r) => !r.on || [r.v, r.a, r.t].every((m) => Number(m ?? 1) === 1));
    },
    whyNot: "it uses separate video / audio / text strengths, which LC LoRA Loader doesn't have",
    set: (old) => ({ lora_rows: JSON.stringify(pkRows(old).filter((r) => typeof r.lora === "string" && r.lora && r.lora !== "None")
      .map((r) => ({ on: r.on !== false, lora: r.lora, strength: Number(r.str ?? 1) }))) }),
    after: (fresh) => fresh.onConfigure?.({}),
  },

  // ---- installed-pack sweep 2026-11-06 ----
  // rgthree / demonalone / vsLinx / CR switches. Any Switch: first connected input wins, as LC AnySwitch
  { from: "Any Switch (rgthree)", to: "LCAnySwitch", names: {}, set: (old) => ({ inputcount: Math.min(20, Math.max(2, ...(old.inputs || []).map((i) => (i.link != null ? Number(/^any_(\d+)$/.exec(i.name)?.[1]) || 0 : 0)))) }) },
  { from: "BooleanSwitchNode", to: "LCBooleanSwitch", names: {} },
  { from: "vsLinx_BooleanFlip", to: "LCBooleanFlip", names: {} },
  {
    from: "CR Image Input Switch", to: "LCIndexSwitch", names: { image1: "any_01", image2: "any_02", IMAGE: "*" }, drop: ["Input"],
    set: (old) => ({ inputcount: 2, index: Math.min(1, Math.max(0, (Number(old.widgets?.find((w) => w.name === "Input")?.value) || 1) - 1)) }),
  },
  { from: "mxStop", to: "LCStop", names: {}, outAt: ["Out"], missingOk: true, set: () => ({ enable: true }) },
  // text boxes -> Prompt
  { from: "DF_Text", to: "LCPositive", names: { Text: "positive", STRING: "positive" } },
  { from: "String", to: "LCPositive", names: { String: "positive", STRING: "positive" } },
  { from: "StringConstant", to: "LCPositive", names: { string: "positive", STRING: "positive" } },
  // single numbers -> LC Slider (ComfyLiterals keep the number as text)
  ...[["Float", "Number", "FLOAT", 2], ["Int", "Number", "INT", 0], ["FloatConstant", "value", "value", 2], ["INTConstant", "value", "value", 0], ["Cfg Literal", "float", "FLOAT", 2]]
    .map(([from, widget, out, dec]) => ({ from, to: "LCSlider", names: { [out]: "*" }, drop: [widget], set: (old) => sliderFor(old.widgets?.find((w) => w.name === widget)?.value, dec) })),
  { from: "Seed Generator (Image Saver)", to: "LCSeed", names: { INT: "seed" }, drop: ["seed", "increment"],
    when: (old) => !Number(old.widgets?.find((w) => w.name === "increment")?.value),
    whyNot: "it adds an increment to the seed, which LC Seed doesn't",
    set: (old) => ({ base_seed: Number(old.widgets?.find((w) => w.name === "seed")?.value) || 0 }) },
  { from: "Sampler Selector", to: "LCSamplerScheduler", names: {} },
  { from: "Scheduler Selector", to: "LCSamplerScheduler", names: {} },
  // image info
  { from: "Get resolution [Crystools]", to: "LCGetImage", names: {} },
  { from: "GetImageSize+", to: "LCGetImage", names: { count: "batch" } },
  { from: "WidgetToString", to: "LCWidgetToString", names: {} },
  // text tools
  { from: "RemoveDuplicateTags|LP", to: "LCDuplicateTags", names: { "tags TEXT": "text" }, set: () => ({ keep: "first" }) },
  {
    from: "CR Text Replace", to: "LCTextReplace", names: { find1: "find_1", replace1: "replace_1", find2: "find_2", replace2: "replace_2", find3: "find_3", replace3: "replace_3", STRING: "text" },
    set: (old) => ({ entrycount: Math.max(1, ...[1, 2, 3].filter((i) => String(old.widgets?.find((w) => w.name === `find${i}`)?.value ?? "") !== "")) }),
  },
  // image adjustments. LC Image Adjust uses FL's math on a -1..1 scale (FL's hue steps are 1/256 of a turn)
  {
    from: "FL_ImageAdjuster", to: "LCImageAdjust", names: { IMAGE: "image" }, drop: ["hue", "saturation", "brightness", "contrast", "sharpness"],
    set: (old) => {
      const v = (n) => Number(old.widgets?.find((w) => w.name === n)?.value) || 0;
      const c = (x) => Math.max(-1, Math.min(1, x));
      return { hue: c(v("hue") / 128), saturation: c(v("saturation") / 100), brightness: c(v("brightness") / 100), contrast: c(v("contrast") / 100), sharpness: c(v("sharpness") / 100) };
    },
  },
  { from: "ImageDesaturate+", to: "LCImageDesaturate", names: { IMAGE: "image" } },
  { from: "ChromaticAberration", to: "LCChromaticAberration", names: { IMAGE: "image" } },
  // Pro Post samples the LUT trilinearly; strength blends the same way
  { from: "ProPostApplyLUT", to: "LCApplyLUT", names: {}, outAt: ["image"], set: () => ({ interpolation: "trilinear" }) },
  {
    from: "ResizeImageNode", to: "LCImageMaskResize", names: { width: "custom_width", height: "custom_height", IMAGE: "image" }, drop: ["method"],
    set: (old) => ({ match_aspect_ratio: false, aspect_ratio: "custom", upscale_by: "none", proportion: "stretch", divisible_by: 1,
      upscale_method: { NEAREST: "nearest-exact", LANCZOS: "lanczos", BICUBIC: "bicubic" }[old.widgets?.find((w) => w.name === "method")?.value] || "lanczos" }),
  },
  // controlnet_aux preprocessors
  { from: "BAE-NormalMapPreprocessor", to: "LCNormalBAE", names: { IMAGE: "normal_map" }, drop: ["resolution"],
    set: (old) => ({ resolution: Math.max(256, Math.min(2048, Number(old.widgets?.find((w) => w.name === "resolution")?.value) || 512)) }) },
  {
    from: "DepthAnythingV2Preprocessor", to: "LCDepthAnythingV2", names: { IMAGE: "depth" }, drop: ["ckpt_name", "resolution"],
    set: (old) => {
      const ck = String(old.widgets?.find((w) => w.name === "ckpt_name")?.value || "depth_anything_v2_vitl.pth");
      const size = /vits/.test(ck) ? "Small" : /vitb/.test(ck) ? "Base" : "Large"; // no Giant in LC: Large is the closest
      const opts = LiteGraph.registered_node_types?.LCDepthAnythingV2?.nodeData?.input?.required?.model?.[0] || [];
      const res = Number(old.widgets?.find((w) => w.name === "resolution")?.value) || 518;
      return { ...(opts.find((o) => o.includes(size)) ? { model: opts.find((o) => o.includes(size)) } : {}), resolution: Math.max(224, Math.min(2044, Math.round(res / 14) * 14)) };
    },
  },
  // Detail Daemon (Jonseed): LC's schedule is the same (bias = peak). The original multiplies amount by CFG, LC doesn't,
  // so a set cfg override is folded into the amount; otherwise the amount carries over as it is
  {
    from: "DetailDaemonSamplerNode", to: "LCDetailDaemon", names: { detail_amount: "amount", bias: "peak" },
    drop: ["start_offset", "end_offset", "fade", "smooth", "cfg_scale_override", "detail_amount"],
    set: (old) => {
      const v = (n, fb) => { const x = Number(old.widgets?.find((w) => w.name === n)?.value); return Number.isFinite(x) ? x : fb; };
      const cfg = v("cfg_scale_override", 0);
      return { amount: Math.max(-5, Math.min(5, v("detail_amount", 0.1) * (cfg > 0 ? cfg : 1))), mode: "classic" };
    },
  },
];

// one number -> LC Slider settings (a range around the value)
function sliderFor(raw, decimals) {
  const v = Number(raw);
  const x = Number.isFinite(v) ? (decimals ? v : Math.round(v)) : 0;
  return { value: x, min: Math.min(0, Math.floor(x)), max: Math.max(decimals ? 1 : 100, Math.ceil(Math.abs(x) * 2)), step: decimals ? 0.01 : 1, decimals };
}

// PlagueKind's LoRA stack keeps its rows as JSON in the stack_data widget (and node.properties)
function pkRows(node) {
  const raw = node.widgets?.find((w) => w.name === "stack_data")?.value || node.properties?.stack_data || "[]";
  try {
    const r = JSON.parse(raw);
    return Array.isArray(r) ? r : [];
  } catch (_) {
    return [];
  }
}

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

// A node whose pack is missing keeps its settings only as a list of values. WIDGET_ORDER names them again, so the
// swap reads them the same way as on an installed node. Everything else (wires, title, place) comes from the real node.
const CONTROL = new Set(["fixed", "increment", "decrement", "randomize"]);
function readable(node) {
  // the frontend gives a missing node placeholder widgets named UNKNOWN, UNKNOWN_1...: their values are kept, not their names
  if (registered(node.type)) return node;
  const order = WIDGET_ORDER[node.type];
  const wv = node.widgets?.length ? node.widgets.map((w) => w.value) : node.widgets_values;
  if (!order || wv == null) return node;
  let widgets;
  if (!Array.isArray(wv)) widgets = Object.entries(wv).map(([name, value]) => ({ name, value }));
  else if (order === "*") widgets = wv.map((value, i) => ({ name: `#${i}`, value }));
  else {
    widgets = [];
    let i = 0;
    for (const name of order) {
      if (i >= wv.length) break;
      const value = wv[i++];
      widgets.push({ name, value });
      if (typeof value === "number" && CONTROL.has(wv[i])) i++; // a seed's control_after_generate
    }
  }
  return new Proxy(node, { get: (t, k) => (k === "widgets" ? widgets : Reflect.get(t, k)) });
}
const readableOk = (node, sw) => registered(node.type) || sw.missingOk || !!WIDGET_ORDER[node.type];
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
// an output's real name: some packs blank the label on the canvas (mxToolkit), so fall back to the node's definition
const outName = (node, i) => node.outputs?.[i]?.name || LiteGraph.registered_node_types?.[node.type]?.nodeData?.output_name?.[i] || "";
// A node's outgoing wires, read from the graph's own link list: some nodes (mxStop) don't keep their output's link list up to date
function outLinks(node) {
  const graph = node.graph || app.graph;
  const all = graph.links instanceof Map ? [...graph.links.values()] : Object.values(graph.links || {});
  return all.filter((l) => l && l.origin_id === node.id && graph.getNodeById(l.target_id)?.inputs?.[l.target_slot]?.link === l.id);
}
// outAt: LC output names by position, for nodes whose output name changes with what is wired (mxStop, Pro Post)
const outTo = (sw, node, i) => sw.outAt?.[i] ?? sel(sw, outName(node, i));

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
  // a missing pack's node is read through WIDGET_ORDER; without an entry its settings can't be named
  if (!readableOk(node, sw)) return { ok: false, why: "its pack isn't installed, so its settings can't be read" };
  node = readable(node);
  if (sw.when && !sw.when(node)) return { ok: false, why: sw.whyNot || "its settings have no LC home" };
  for (const inp of node.inputs || []) {
    if (inp.link == null) continue;
    const to = sel(sw, inp.name);
    if (!def.inputs.has(to)) return { ok: false, why: `its ${inp.name} input has no match` };
  }
  const wiredOut = new Set(outLinks(node).map((l) => l.origin_slot));
  for (const [i] of (node.outputs || []).entries()) {
    if (!wiredOut.has(i)) continue;
    const to = outTo(sw, node, i);
    if (!def.outputs.includes(to)) return { ok: false, why: `its ${outName(node, i) || "unnamed"} output has no match` };
  }
  // a "drop" setting that set() / when() reads is converted, not lost: only list the ones nothing reads
  const used = new Set();
  const spy = new Proxy(node, {
    get: (t, k) => (k === "widgets"
      ? (t.widgets || []).map((w) => new Proxy(w, { get: (o, p) => { if (p === "value") used.add(o.name); return Reflect.get(o, p); } }))
      : Reflect.get(t, k)),
  });
  try { sw.when?.(spy); sw.set?.(spy); sw.companion?.set?.(spy); } catch { /* a reader that fails just leaves its settings listed */ }
  const drops = (node.widgets || []).filter((w) => sw.drop?.includes(w.name) && !used.has(w.name)).map((w) => w.name);
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
  const view = readable(old); // settings of a missing pack's node, by name
  // buttons hold no value, and pressing one (rgthree's and LC's "🎲 New Fixed Random") would change the settings
  for (const w of view.widgets || []) if (w.name && w.type !== "button" && !sw.drop?.includes(w.name)) values[sel(sw, w.name)] = w.value;
  Object.assign(values, sw.set?.(view) || {});
  const ins = (old.inputs || []).filter((i) => i.link != null).map((i) => {
    const l = graph.links?.get?.(i.link) ?? graph.links?.[i.link];
    return l && { to: sel(sw, i.name), from: graph.getNodeById(l.origin_id), slot: l.origin_slot };
  }).filter(Boolean);
  const outs = [];
  // outAt nodes connect by position: their outputs can rename themselves once an input is wired (LC Stop takes the input's type)
  for (const l of outLinks(old)) outs.push({ from: outTo(sw, old, l.origin_slot), at: sw.outAt ? l.origin_slot : null, node: graph.getNodeById(l.target_id), slot: l.target_slot });
  const pos = [...old.pos], mode = old.mode, size = old.size ? [...old.size] : null;
  const converted = sw.convert ? sw.convert(old) : null; // read before the old node goes
  const compValues = sw.companion && registered(sw.companion.type) ? sw.companion.set?.(view) || {} : null;
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
    const slot = c.at ?? fresh.findOutputSlot?.(c.from) ?? fresh.outputs?.findIndex((o) => o.name === c.from);
    if (c.node && slot >= 0) fresh.connect(slot, c.node, c.slot);
  }
  if (compValues) {
    const comp = LiteGraph.createNode(sw.companion.type);
    if (comp) {
      graph.add(comp);
      comp.pos = [pos[0] - (comp.size?.[0] || 320) - 40, pos[1]];
      comp.mode = mode;
      for (const [name, v] of Object.entries(compValues)) {
        const w = comp.widgets?.find((x) => x.name === name);
        if (w && valid(w, v)) w.value = v;
      }
      const slot = fresh.inputs?.findIndex((i) => i.name === sw.companion.input);
      if (slot >= 0) comp.connect(0, fresh, slot);
    }
  }
  try {
    sw.after?.(fresh, view);
  } catch (_) {}
  const min = fresh.computeSize?.() || fresh.size;
  if (size) fresh.setSize?.([Math.max(size[0], min[0]), Math.max(min[1], fresh.size[1])]);
  return fresh;
}

/** Swap every node of the ticked types. Returns how many were swapped. */
export function swapTypes(types) {
  let done = 0;
  for (const grp of [...find(), ...findNotes()]) {
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
  const md = linkify(pixHtmlToMarkdown(cfg.content || ""));
  const title = old.title && old.title !== "Note Pixaroma" && old.title !== old.constructor?.title ? old.title : "";
  return lcNoteFrom(old, md, title);
}

// ------------------------------------------------------------------ any note -> LC Note
// Core Note (plain text), Markdown Note, Pixaroma's note and any other note node: the text, title, colours and place
// carry over. Plain text keeps its line breaks, and every bare web address becomes a real link.

/** The text an unknown note node holds: its first text setting. null when it holds none. */
export function noteText(node) {
  const w = (node.widgets || []).find((x) => typeof x.value === "string" && x.type !== "combo" && !/language|lang$/i.test(x.name || ""));
  if (w) return w.value;
  const v = (node.widgets_values || []).find((x) => typeof x === "string");
  return typeof v === "string" ? v : null;
}

/** Bare web addresses -> markdown links. Leaves existing links, <autolinks> and `code` alone. */
export function linkify(md) {
  const keep = /(\[[^\]]*\]\([^)]*\)|`[^`]*`|<https?:[^>\s]+>|@\[[^\]]*\]\([^)]*\))/g;
  const url = /(^|[\s(])(https?:\/\/[^\s<>()[\]]*[^\s<>()[\].,;:!?'"])/g;
  return String(md || "").split(keep).map((part, i) => (i % 2 ? part : part.replace(url, (_, pre, u) => `${pre}[${u}](${u})`))).join("");
}

/** Plain note text -> markdown: line breaks kept (a single newline would be merged into one line), links made real. */
export function plainToMarkdown(text) {
  const t = String(text || "").replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "");
  return linkify(t).replace(/([^\n])\n(?=[^\n])/g, "$1  \n").trim();
}

function lcNoteFrom(old, md, title) {
  const look = { color: old.color, bgcolor: old.bgcolor, collapsed: !!old.flags?.collapsed };
  return {
    apply(fresh) {
      const d = fresh.properties?.lc_note;
      if (d?.texts) d.texts[d.source] = { ...(d.texts[d.source] || {}), text: md };
      if (fresh._lcText) fresh._lcText.value = md;
      if (title) fresh.title = title;
      if (look.color) fresh.color = look.color;
      if (look.bgcolor) fresh.bgcolor = look.bgcolor;
      if (look.collapsed) fresh.flags = { ...(fresh.flags || {}), collapsed: true };
    },
  };
}

const ownTitle = (old, ...defaults) => (old.title && ![old.type, old.constructor?.title, titleOf(old.type), ...defaults].includes(old.title) ? old.title : "");

function plainNoteToLC(old) {
  return lcNoteFrom(old, plainToMarkdown(noteText(old)), ownTitle(old, "Note"));
}

function markdownNoteToLC(old) {
  return lcNoteFrom(old, linkify(String(noteText(old) || "").replace(/\r\n?/g, "\n")).trim(), ownTitle(old, "Markdown Note"));
}

export const NOTE_SWAPS = [
  { from: "Note", to: "LCNote", frontend: true, missingOk: true, note: true, convert: plainNoteToLC },
  { from: "MarkdownNote", to: "LCNote", frontend: true, missingOk: true, note: true, convert: markdownNoteToLC },
  { from: "PixaromaNote", to: "LCNote", frontend: true, missingOk: true, note: true, convert: pixNoteToLC },
];

/** Any other node that is just a note: "note" in its name, holds text, and nothing is wired to it. */
function noteLike(n) {
  if (n.type === "LCNote" || !/note/i.test(`${n.type} ${n.constructor?.title || ""}`)) return false;
  if ((n.inputs || []).some((i) => i.link != null) || (n.outputs || []).some((o) => o.links?.length)) return false;
  return typeof noteText(n) === "string";
}

/** Every note in the workflow (subgraphs too) that can become an LC Note, grouped by type. */
export function findNotes() {
  if (!registered("LCNote")) return [];
  const groups = new Map();
  for (const g of allGraphs()) {
    for (const n of g._nodes || []) {
      const sw = NOTE_SWAPS.find((s) => s.from === n.type) || (noteLike(n) && { from: n.type, to: "LCNote", frontend: true, missingOk: true, note: true, convert: plainNoteToLC });
      if (!sw) continue;
      if (!groups.has(sw.from)) groups.set(sw.from, { sw, nodes: [], blocked: [], drops: new Set(), targets: new Set(["LCNote"]) });
      groups.get(sw.from).nodes.push(n);
    }
  }
  return [...groups.values()];
}
