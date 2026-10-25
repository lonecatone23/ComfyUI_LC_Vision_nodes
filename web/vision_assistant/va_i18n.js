// Vision Assistant interface language: the tour editor, the tour card and their messages follow LC123's Note language
// (or ComfyUI's own language). Strings are keyed by their English text; locales/<code>.json holds the translations,
// {name} placeholders are filled in. A missing file or string just shows the English.
import { app } from "../../../scripts/app.js";

// ComfyUI's own interface languages (the same list LC Note uses): code, label, name given to the translator
export const LANGS = [
  ["en", "English", "English"],
  ["zh", "中文", "Simplified Chinese"],
  ["zh-TW", "繁體中文", "Traditional Chinese"],
  ["ru", "Русский", "Russian"],
  ["ja", "日本語", "Japanese"],
  ["ko", "한국어", "Korean"],
  ["fr", "Français", "French"],
  ["es", "Español", "Spanish"],
  ["ar", "عربي", "Arabic"],
  ["tr", "Türkçe", "Turkish"],
  ["pt-BR", "Português (BR)", "Brazilian Portuguese"],
  ["fa", "فارسی", "Persian (Farsi)"],
  ["he", "עברית", "Hebrew"],
  ["it", "Italiano", "Italian"],
];
export const BY_CODE = Object.fromEntries(LANGS.map((l) => [l[0], l]));

const get = (id) => app.extensionManager?.setting?.get?.(id) ?? app.ui?.settings?.getSettingValue?.(id);

/** The reader's language code: LC123's Note language, else ComfyUI's language, else English. */
export function lang() {
  for (const v of [get("LC123.Notes.Language"), get("Comfy.Locale")]) {
    if (!v || v === "auto") continue;
    if (BY_CODE[v]) return v;
    const base = String(v).split(/[-_]/)[0];
    if (BY_CODE[base]) return base;
  }
  return "en";
}

const dicts = {}; // code -> {english: translated} | null while loading / missing
async function load(code) {
  if (code === "en" || code in dicts) return;
  dicts[code] = null;
  try {
    const r = await fetch(new URL(`./locales/${code}.json`, import.meta.url));
    if (r.ok) dicts[code] = await r.json();
  } catch (_) {}
}

/** Load the reader's strings (call once early; t() shows English until they arrive). */
export const ready = () => load(lang());

/** The reader's text for an English string. vars fill {name} placeholders. */
export function t(en, vars) {
  const code = lang();
  if (!(code in dicts)) load(code);
  let s = (dicts[code] && dicts[code][en]) || en;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return s;
}

/** A count with the right English plural; other languages use their "{n} …" string for both. */
export const tn = (n, one, many) => (n === 1 ? t(one, { n }) : t(many, { n }));
