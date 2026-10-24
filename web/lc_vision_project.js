/**
 * LC Vision Showrunner: the project file. output/LC_H3/<project>/project.json holds the Shot List, the Reference
 * Assembler's list and the Showrunner's settings. Saved on every Run and with 💾; 📂 loads one back.
 * Loading never empties the Reference Assembler: it only fills it when it has nothing in it.
 */
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const DIRECTOR = "LCVisionDirector";
const DIR_KEYS = ["preset", "segment_seconds", "overlap_seconds", "style_tag", "custom_system_prompt"];
const SEG_KEYS = ["memory", "memory_gap", "color_match", "refs_on", "carry_on_line"];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const widget = (node, name) => node?.widgets?.find((w) => w.name === name);
const first = (type) => (app.graph?._nodes || []).find((n) => n.type === type && n.mode === 0);

// the project name, also when it comes in on a wire (a Project Name primitive, through Set / Get nodes)
export async function projectSource(dir) {
  const inp = dir?.inputs?.find((i) => i.name === "project");
  if (!dir || inp?.link == null) return { name: String(widget(dir, "project")?.value || "").trim(), node: dir, key: "project" };
  try {
    const p = await app.graphToPrompt();
    let v = p.output[dir.id]?.inputs?.project, id = null;
    for (let k = 0; k < 8 && Array.isArray(v); k++) {
      id = v[0];
      const src = p.output[id]?.inputs || {};
      const key = ["value", "string", "text"].find((x) => x in src);
      v = key ? src[key] : undefined;
      if (!Array.isArray(v)) {
        const n = app.graph.getNodeById(+id) || app.graph.getNodeById(id);
        return { name: String(v ?? "").trim(), node: n, key };
      }
    }
  } catch (_e) {}
  return { name: String(widget(dir, "project")?.value || "").trim(), node: dir, key: "project" };
}

function toast(detail, severity = "info") {
  try {
    app.extensionManager?.toast?.add({ severity, summary: "Project", detail, life: 4000 });
  } catch (_e) {}
}

// a small dialog: title, body html, buttons [{label, value, primary}] -> the value clicked (null = closed)
function dialog(title, body, buttons) {
  return new Promise((resolve) => {
    const bg = document.createElement("div");
    bg.style.cssText = "position:fixed;inset:0;z-index:10001;background:#0008;display:flex;align-items:center;justify-content:center";
    bg.innerHTML = `<div style="background:#1e1e1e;border:1px solid #555;border-radius:10px;padding:16px 18px;max-width:520px;width:90%;font:13px system-ui;color:#ddd;box-shadow:0 8px 32px #000a">
      <div style="font-size:16px;font-weight:700;color:#ffc850;margin-bottom:8px">${title}</div><div>${body}</div>
      <div data-b style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px;flex-wrap:wrap"></div></div>`;
    const done = (v) => {
      bg.remove();
      resolve(v);
    };
    for (const b of buttons) {
      const el = document.createElement("button");
      el.textContent = b.label;
      el.style.cssText = `background:${b.primary ? "#2f6b3a" : "#2a2a2a"};color:#eee;border:1px solid #555;border-radius:6px;padding:6px 12px;cursor:pointer;font:13px system-ui`;
      el.onclick = () => done(typeof b.value === "function" ? b.value(bg) : b.value);
      bg.querySelector("[data-b]").appendChild(el);
    }
    bg.addEventListener("pointerdown", (e) => e.target === bg && done(null));
    bg.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") done(null);
    });
    document.body.appendChild(bg);
    bg.querySelector("input")?.focus();
  });
}

const EMPTY_SHOTS = { place: "", setup: "", cast: [], shots: [] };

async function newProject(dir) {
  const list = await fetch(`/lc_vision/movie/projects?t=${Date.now()}`, { cache: "no-store" }).then((x) => x.json()).then((x) => x.projects || []).catch(() => []);
  const names = new Set(list.map((p) => p.name.toLowerCase()));
  const res = await dialog("🆕 New project",
    `<div style="margin-bottom:6px">A name for its folder in output/LC_H3 (letters, numbers, spaces, - and _).</div>
     <input data-n placeholder="parka_girl_cafe" style="width:100%;box-sizing:border-box;background:#111;color:#eee;border:1px solid #555;border-radius:6px;padding:6px 8px;font:14px system-ui">
     <label style="display:flex;gap:6px;align-items:center;margin-top:8px;opacity:.85"><input type="checkbox" data-k checked> Keep the Reference Assembler's pictures</label>
     <div data-w style="color:#f3c969;margin-top:6px;min-height:16px"></div>`,
    [{ label: "Cancel", value: null }, { label: "Create", primary: true, value: (bg) => ({ name: bg.querySelector("[data-n]").value.trim(), keep: bg.querySelector("[data-k]").checked }) }]);
  if (!res) return;
  if (!/^[A-Za-z0-9 _-]{1,60}$/.test(res.name)) return toast("Use letters, numbers, spaces, - and _ (up to 60).", "warn");
  if (names.has(res.name.toLowerCase())) return toast(`${res.name} already exists: 📂 Load it instead.`, "warn");
  await save(dir, true, true); // the project we are leaving keeps its latest state
  const src = await projectSource(dir);
  const pw = widget(src.node, src.key);
  if (pw) pw.value = res.name;
  const shot = first("LCVisionShotList");
  if (shot) {
    widget(shot, "shot_list").value = JSON.stringify(EMPTY_SHOTS);
    shot.onConfigure?.({});
  }
  const asm = first("LCH3ReferenceAssembler");
  if (asm && !res.keep) {
    widget(asm, "references").value = JSON.stringify({ items: [] });
    asm.onConfigure?.({});
  }
  showName(dir, res.name);
  await save(dir, true);
  app.graph.setDirtyCanvas(true, true);
  window.dispatchEvent(new CustomEvent("lc-vision-project", { detail: { name: res.name } }));
  toast(`New project ${res.name}. Fill in the Shot List, then Run.`, "success");
}

// the Showrunner stopped instead of writing a new plan over locked segments: explain, and offer the way out
api.addEventListener("lc_vision_locked_plan", async (e) => {
  const project = e.detail?.project || "";
  const dir = first(DIRECTOR);
  const locked = (String(e.detail?.message || "").match(/\(([\d, ]+)\)/) || [])[1] || "";
  const pick = await dialog(`🔒 ${esc(project)} has locked segments`,
    `<div>The Shot List on the canvas tells a different story than ${esc(project)}'s plan, and segment${locked.includes(",") ? "s" : ""} ${esc(locked)} ${locked.includes(",") ? "are" : "is"} locked. Nothing was changed.</div>
     <div style="margin-top:8px;opacity:.85">💡 This happens when the workflow was saved with an older Shot List. Loading the project's own Shot List fixes it.</div>`,
    [{ label: "Close", value: null }, { label: "🔓 Unlock all and plan again", value: "unlock" }, { label: `📂 Load ${project}'s Shot List`, value: "load", primary: true }]);
  if (pick === "load" && dir) {
    await load(dir, project);
    toast(`${project}'s Shot List is back. Run again.`, "success");
  } else if (pick === "unlock") {
    const r = await fetch("/lc_vision/movie/lock", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project, index: 0, locked: false }) }).then((x) => x.json()).catch((er) => ({ error: String(er) }));
    toast(r.error ? `Not unlocked: ${r.error}` : `${project} is unlocked. Run again to plan the new story (the old renders move to takes/).`, r.error ? "warn" : "info");
  }
});

function showName(dir, name) {
  if (dir?._lcProj) dir._lcProj.name.textContent = name ? `🎬 ${name}` : "🎬 no project";
}

function collect(dir) {
  const pick = (node, keys) => Object.fromEntries(keys.map((k) => [k, widget(node, k)?.value]).filter(([, v]) => v !== undefined));
  const shot = first("LCVisionShotList");
  const asm = first("LCH3ReferenceAssembler");
  const seg = first("LCH3Segment");
  const parse = (v, d) => {
    try {
      return JSON.parse(v || "");
    } catch (_e) {
      return d;
    }
  };
  return {
    shot_list: shot ? parse(widget(shot, "shot_list")?.value, {}) : null,
    references: asm ? parse(widget(asm, "references")?.value, { items: [] }) : null,
    director: pick(dir, DIR_KEYS),
    segment: seg ? pick(seg, SEG_KEYS) : {},
    saved: new Date().toISOString(),
  };
}

// which save of the project file this tab last loaded or wrote (kept in the workflow, so it survives a page reload)
function seen(dir, project) {
  const s = dir.properties?.lc_project_seen;
  return s?.name === project ? s.saved : "";
}

function markSeen(dir, project, saved) {
  if (!saved) return;
  dir.properties = dir.properties || {};
  dir.properties.lc_project_seen = { name: project, saved };
}

// auto = the save on Run (and before 🆕 New): when the project file was saved since this tab last saw it, the file keeps
// its own Shot List and pictures. A tab that never saw it counts as older. 💾 always writes this tab's.
export async function save(dir, quiet = false, auto = false) {
  const project = (await projectSource(dir)).name;
  if (!project) return quiet || toast("Give the project a name first.", "warn");
  const data = collect(dir);
  if (auto) data.based_on = seen(dir, project) || "1970-01-01T00:00:00.000Z";
  const r = await fetch("/lc_vision/movie/project", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ project, data }) }).then((x) => x.json()).catch((e) => ({ error: String(e) }));
  if (r.error) return toast(`Not saved: ${r.error}`, "warn");
  if (r.kept_stale) {
    toast(`${project} was saved since this tab last loaded it, so the project kept its own Shot List and pictures. 📂 Load ${project} to bring them in, or 💾 Save to keep this tab's.`, "warn");
    return;
  }
  markSeen(dir, project, r.stamp);
  if (r.kept_shot_list) toast(`This Shot List tells a different story than ${project}'s plan, which has locked segments, so the project kept its own. 📂 Load ${project} to bring it in.`, "warn");
  if (dir._lcProj) dir._lcProj.note.textContent = `saved ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  if (!quiet) toast(`Saved ${project}.`);
}

const itemsKey = (items) => JSON.stringify((items || []).map((x) => [x.file, x.role, x.name, x.on !== false]));

async function load(dir, name) {
  const d = await fetch(`/lc_vision/movie/project?project=${encodeURIComponent(name)}&t=${Date.now()}`, { cache: "no-store" }).then((x) => (x.ok ? x.json() : {})).catch(() => ({}));
  const src = await projectSource(dir);
  // the project we are leaving: its saved pictures tell us whether the Assembler still holds just those
  const leaving = src.name && src.name !== name
    ? await fetch(`/lc_vision/movie/project?project=${encodeURIComponent(src.name)}&t=${Date.now()}`, { cache: "no-store" }).then((x) => (x.ok ? x.json() : {})).catch(() => ({}))
    : {};
  const pw = widget(src.node, src.key);
  if (pw) pw.value = name;
  if (!d || !Object.keys(d).length) {
    toast(`${name} has no project file yet (made before projects were saved). Its renders and plan are still there.`);
    showName(dir, name);
    app.graph.setDirtyCanvas(true, true);
    window.dispatchEvent(new CustomEvent("lc-vision-project", { detail: { name } }));
    return;
  }
  markSeen(dir, name, d.saved);
  for (const [k, v] of Object.entries(d.director || {})) {
    const w = widget(dir, k);
    if (w && v !== undefined) w.value = v;
  }
  const seg = first("LCH3Segment");
  for (const [k, v] of Object.entries(d.segment || {})) {
    const w = widget(seg, k);
    if (w && v !== undefined) w.value = v;
  }
  const shot = first("LCVisionShotList");
  if (shot && d.shot_list) {
    widget(shot, "shot_list").value = JSON.stringify(d.shot_list);
    shot.onConfigure?.({});
  }
  const asm = first("LCH3ReferenceAssembler");
  let refsNote = "";
  if (asm && d.references) {
    const cur = (() => {
      try {
        return JSON.parse(widget(asm, "references")?.value || "{}").items || [];
      } catch (_e) {
        return [];
      }
    })();
    // swap pictures only when nothing would be lost: the Assembler is empty, or it still holds exactly the pictures
    // the project we are leaving was saved with. Pictures you changed (a storyboard set you reuse) are kept.
    const untouched = cur.length && leaving?.references?.items && itemsKey(cur) === itemsKey(leaving.references.items);
    if ((!cur.length && d.references.items?.length) || untouched) {
      widget(asm, "references").value = JSON.stringify(d.references);
      asm.onConfigure?.({});
      if (untouched) refsNote = ` Pictures switched to ${name}'s.`;
    } else if (cur.length) refsNote = " The Reference Assembler kept its own pictures (they were changed since the last save).";
  }
  showName(dir, name);
  app.graph.setDirtyCanvas(true, true);
  toast(`Loading ${name}. Please wait...${refsNote}`);
  window.dispatchEvent(new CustomEvent("lc-vision-project", { detail: { name } }));  // the Vision Assistant's Movie tab follows
}

async function openMenu(dir, anchor) {
  document.querySelector(".lcproj-menu")?.remove();
  const list = (await fetch(`/lc_vision/movie/projects?t=${Date.now()}`, { cache: "no-store" }).then((x) => x.json()).then((x) => x.projects || []).catch(() => []))
    .filter((p) => !p.library); // the card library isn't a movie
  const m = document.createElement("div");
  m.className = "lcproj-menu";
  const r = anchor.getBoundingClientRect();
  m.style.cssText = `position:fixed;left:${r.left}px;top:${r.bottom + 2}px;z-index:10000;background:#1e1e1e;border:1px solid #555;border-radius:6px;max-height:320px;overflow:auto;min-width:240px;font:12px system-ui;color:#ddd;box-shadow:0 4px 16px #0008`;
  m.innerHTML = list.length
    ? list.map((p) => `<div data-p="${esc(p.name)}" style="padding:5px 10px;cursor:pointer;display:flex;gap:10px;justify-content:space-between"><span>${esc(p.name)}</span><span style="opacity:.6">${p.done}/${p.segments}${p.has_project ? "" : " · no file"}</span></div>`).join("")
    : `<div style="padding:6px 10px;opacity:.6">No projects in output/LC_H3 yet.</div>`;
  m.querySelectorAll("[data-p]").forEach((el) => {
    el.onmouseenter = () => (el.style.background = "#333");
    el.onmouseleave = () => (el.style.background = "");
    el.onclick = () => {
      m.remove();
      load(dir, el.dataset.p);
    };
  });
  document.body.appendChild(m);
  setTimeout(() => document.addEventListener("pointerdown", function off(e) {
    if (!m.contains(e.target)) {
      m.remove();
      document.removeEventListener("pointerdown", off, true);
    }
  }, true), 0);
}

function build(dir) {
  if (dir._lcProj) return;
  const row = document.createElement("div");
  row.style.cssText = "display:flex;flex-wrap:wrap;gap:6px 8px;align-items:center;font:12px system-ui;color:#ccc;padding:0 2px 8px";
  row.innerHTML = `<b data-name data-tour="project name" style="font-size:14px;color:#ffc850;flex:1 1 100%;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="The project: its folder in output/LC_H3. 🆕 New or 📂 Load changes it."></b>
    <button data-a="new" data-tour="🆕 New" title="Start a new project: give it a name, the Shot List starts empty">🆕 New</button>
    <button data-a="load" data-tour="📂 Load" title="Open a saved project: its shot list, settings and (when the Reference Assembler is empty) its pictures">📂 Load</button>
    <button data-a="save" data-tour="💾 Save" title="Save the shot list, references and settings to output/LC_H3/&lt;project&gt;/project.json (also happens on every Run)">💾 Save</button>
    <span style="display:none"></span>`;
  row.querySelectorAll("button").forEach((b) => (b.style.cssText = "background:#2a2a2a;color:#ddd;border:1px solid #444;border-radius:6px;padding:5px 14px;font-size:14px;cursor:pointer"));
  row.querySelector('[data-a="load"]').onclick = (e) => openMenu(dir, e.currentTarget);
  row.querySelector('[data-a="save"]').onclick = () => save(dir);
  row.querySelector('[data-a="new"]').onclick = () => newProject(dir);
  dir._lcProj = { row, note: row.querySelector("span"), name: row.querySelector("[data-name]") };
  // the name is set with 🆕 New or 📂 Load only: the typed field is hidden (a typo made a new folder)
  const pw = widget(dir, "project");
  if (pw && !pw._lcHidden) {
    pw._lcHidden = true;
    pw.type = "hidden";
    pw.computeSize = () => [0, -4];
    try {
      pw.hidden = true;
    } catch (_e) {}
    if (pw.options) pw.options.hidden = true;
  }
  setTimeout(async () => showName(dir, (await projectSource(dir)).name), 200);
  const w = dir.addDOMWidget("lc_project", "project_buttons", row, { serialize: false, hideOnZoom: false, getValue: () => "", setValue() {} });
  w.computeSize = () => [dir.size?.[0] || 300, 70];
  // stays the last widget: a widget slipped in between would shift the saved values of the ones after it
}

// save the project with every Run, before it is queued (the values that go to the server are the ones saved)
// Only a prompt that holds this graph's Showrunner saves: the Reference Assembler's sheet preview queues just the
// Assembler, and on a page reload with old tabs open that run saved an old tab's Shot List and pictures over the project.
const origQueue = api.queuePrompt.bind(api);
api.queuePrompt = async function (...args) {
  const dir = first(DIRECTOR);
  const runs = dir && args[1]?.output?.[String(dir.id)]?.class_type === DIRECTOR;
  // awaited: with the project on a wire, save() first resolves the name (graphToPrompt), and the queue request went
  // out ahead of it, so the Storyboard Builder could read the project file from before this Run
  if (runs) await save(dir, true, true).catch(() => {});
  return origQueue(...args);
};

app.registerExtension({
  name: "LC.Vision.Project",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== DIRECTOR) return;
    const created = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = created?.apply(this, arguments);
      build(this);
      return r;
    };
    const cfg = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = cfg?.apply(this, arguments);
      build(this);
      return r;
    };
  },
});
