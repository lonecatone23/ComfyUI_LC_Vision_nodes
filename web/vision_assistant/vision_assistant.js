// Vision Assistant: a sidebar tab for the open workflow. Snapshots save just the settings you changed (model files,
// LoRAs, steps, bypassed nodes...) and put them back in one click; the library keeps snapshots for any workflow.
import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";
import { LOGO_URL, LOGO_PNG } from "./va_logo.js";
import * as core from "./va_core.js";
import * as check from "./va_checkup.js";
import * as chat from "./va_chat.js";
import { HELP_HTML, HELP_CSS } from "./va_help.js";
import * as tour from "./va_tour.js";

let usedChat = false; // unload the chat model when a run starts, so it never takes VRAM from the render

const TAB_ID = "vision-assistant";
const baselines = new Map(); // workflow key -> {state, label}
const applied = new Map(); // workflow key -> snapshot name
const undo = new Map(); // workflow key -> {state, name}
const ui = { tab: "chat", view: "list", el: null, timer: null, key: null, lib: null, save: null, place: null, menu: null, cards: null, sig: "", busy: "", tours: new Map(), tourEdit: null, chats: new Map(), draft: "", model: "", chatStatus: null, cardsOpen: null, focusInput: false };

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const wfKey = () => {
  const w = app.extensionManager?.workflow?.activeWorkflow;
  return w?.path || w?.key || app.graph?.id || "default";
};
const wfName = () => {
  const w = app.extensionManager?.workflow?.activeWorkflow;
  return (w?.filename || w?.path || "This workflow").replace(/\.json$/i, "").split(/[\\/]/).pop();
};
function toast(severity, summary, detail) {
  try {
    app.extensionManager.toast.add({ severity, summary, detail, life: severity === "error" ? 6000 : 3500 });
  } catch (_) {
    console.log(`[Vision Assistant] ${summary} ${detail || ""}`);
  }
}

function baseline() {
  const k = wfKey();
  if (!baselines.has(k)) baselines.set(k, { state: core.capture(), label: "the workflow was opened" });
  return baselines.get(k);
}
function resetBaseline(label) {
  baselines.set(wfKey(), { state: core.capture(), label });
}
const changes = () => core.diff(baseline().state, core.capture());

// ------------------------------------------------------------------ style
function ensureStyle() {
  if (document.getElementById("va-style")) return;
  const st = document.createElement("style");
  st.id = "va-style";
  st.textContent = `
.va-icon{display:inline-block;width:1.25rem;height:1.25rem;background-color:currentColor;-webkit-mask:${LOGO_URL} center/contain no-repeat;mask:${LOGO_URL} center/contain no-repeat}
.va{display:flex;flex-direction:column;gap:10px;padding:12px;height:100%;box-sizing:border-box;overflow:auto;color:var(--fg-color);font-size:13px}
.va-head{display:flex;align-items:center;gap:8px}
.va-head img{width:22px;height:auto}
.va-head b{font-size:14px;font-weight:600}
.va-tabs{display:flex;gap:4px;border-bottom:1px solid var(--border-color);padding-bottom:6px}
.va-tab{background:none;border:0;color:var(--descrip-text,#999);padding:4px 10px;border-radius:6px;cursor:pointer;font-size:12px}
.va-tab.on{background:var(--comfy-input-bg);color:var(--fg-color)}
.va-sub{font-size:12px;color:var(--descrip-text,#999)}
.va-btn{background:var(--comfy-input-bg);color:var(--fg-color);border:1px solid var(--border-color);border-radius:6px;padding:5px 10px;cursor:pointer;font-size:12px}
.va-btn:hover{filter:brightness(1.2)}
.va-btn.wide{width:100%;padding:7px}
.va-btn.pri{border-color:var(--p-primary-color,#4a8);}
.va-link{background:none;border:0;color:var(--p-primary-color,#6ab);cursor:pointer;padding:0;font-size:12px}
.va-row{display:flex;align-items:center;gap:8px;padding:8px 0;border-top:1px solid var(--border-color);position:relative}
.va-row .va-name{font-weight:600}
.va-grow{flex:1;min-width:0}
.va-badge{font-size:10px;padding:1px 6px;border-radius:6px;background:rgba(80,180,120,.2);color:#7c9;margin-left:6px;font-weight:400}
.va-tag{font-size:10px;padding:0 5px;border-radius:5px;background:var(--comfy-input-bg);color:var(--descrip-text,#999);margin-left:4px}
.va-dots{background:none;border:0;color:var(--descrip-text,#999);cursor:pointer;font-size:16px;padding:0 4px}
.va-menu{position:absolute;right:0;top:34px;z-index:5;background:var(--comfy-menu-bg);border:1px solid var(--border-color);border-radius:8px;padding:4px;display:flex;flex-direction:column;min-width:170px;box-shadow:0 6px 18px rgba(0,0,0,.35)}
.va-menu button{background:none;border:0;color:var(--fg-color);text-align:left;padding:6px 10px;border-radius:6px;cursor:pointer;font-size:12px}
.va-menu button:hover{background:var(--comfy-input-bg)}
.va-check{display:flex;align-items:flex-start;gap:7px;padding:3px 0;font-size:12px;line-height:1.35}
.va-check.off{color:var(--descrip-text,#999)}
.va-check input{margin-top:2px}
.va-input{width:100%;box-sizing:border-box;background:var(--comfy-input-bg);color:var(--fg-color);border:1px solid var(--border-color);border-radius:6px;padding:6px 8px;font-size:13px}
.va-hint{font-size:12px;color:var(--descrip-text,#999);line-height:1.5}
.va-err{font-size:12px;color:#e77}
.va-group{font-size:11px;font-weight:600;color:var(--descrip-text,#999);margin-top:6px;text-transform:none}
.va-actions{display:flex;gap:6px;flex-wrap:wrap}
.va-actions .va-btn{flex:1}
.va-card{border:1px solid var(--border-color);border-left:3px solid var(--descrip-text,#999);border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:6px}
.va-card.l3{border-left-color:#e77}
.va-card.l1{border-left-color:#db5}
.va-card.l0{border-left-color:#6ab}
.va-card .va-name{font-weight:600}
.va-card .va-hint{white-space:pre-line}
.va-card .va-actions .va-btn{flex:0 1 auto}
.va-chat{display:flex;flex-direction:column;gap:8px;margin-top:4px}
.va-msg{padding:7px 10px;border-radius:10px;line-height:1.45;white-space:pre-wrap;word-break:break-word;font-size:12.5px}
.va-msg.me{align-self:flex-end;background:var(--comfy-input-bg);max-width:88%}
.va-msg.bot{align-self:stretch;border:1px solid var(--border-color);white-space:normal}
.va-msg.bot .va-h{font-weight:600;margin:6px 0 2px}
.va-msg.bot ul,.va-msg.bot ol{margin:2px 0;padding-left:18px}
.va-msg.bot li{margin:1px 0}
.va-msg.bot hr{border:0;border-top:1px solid var(--border-color);margin:8px 0}
.va-msg.bot .va-gap{height:6px}
.va-msg.err{border-color:#e77;color:#e99}
.va-msg code{font-size:11.5px;background:var(--comfy-input-bg);padding:0 3px;border-radius:4px}
.va-prop{margin-top:8px;padding-top:6px;border-top:1px dashed var(--border-color);white-space:normal}
.va-typing{color:var(--descrip-text,#999);font-style:italic}
.va-chips{display:flex;flex-wrap:wrap;gap:6px}
.va-chip{background:none;border:1px solid var(--border-color);border-radius:12px;padding:4px 10px;color:var(--fg-color);cursor:pointer;font-size:12px}
.va-chip:hover{background:var(--comfy-input-bg)}
a.va-chip{text-decoration:none;display:inline-block}
.va-compose{display:flex;gap:6px;align-items:flex-end;position:sticky;bottom:-12px;background:var(--comfy-menu-bg);padding:6px 0}
.va-compose textarea{resize:vertical;min-height:38px;font-family:inherit}
.va-model{width:auto;flex:1;min-width:0;padding:3px 6px;font-size:11px}
.va-tourbar{display:flex;align-items:center;gap:8px;margin-bottom:6px;white-space:normal}
.va-tourlist{margin:2px 0 8px 18px;padding:0;white-space:normal}
.va-tourlist li{cursor:pointer;margin:3px 0;padding:2px 4px;border-radius:6px}
.va-tourlist li span{display:block;font-size:11.5px;color:var(--descrip-text,#999)}
.va-tourlist li:hover,.va-tourlist li.on{background:var(--comfy-input-bg)}
.va-tourlist li.on b{color:#ffb84a}
.va-fit{font-size:10px;padding:1px 6px;border-radius:6px;margin-left:6px;font-weight:400}
.va-fit.ok{background:rgba(80,180,120,.2);color:#7c9}
.va-fit.part{background:rgba(220,180,80,.18);color:#db5}
.va-fit.no{background:var(--comfy-input-bg);color:var(--descrip-text,#999)}
.va-dim{opacity:.55}
.va-btn:disabled{opacity:.45;cursor:not-allowed}
.va-dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#e77;margin-left:5px;vertical-align:middle}
.va-alert{position:relative}
.va-alert::after{content:"";position:absolute;top:6px;right:6px;width:7px;height:7px;border-radius:50%;background:#e77}
`;
  st.textContent += HELP_CSS;
  document.head.appendChild(st);
}

// ------------------------------------------------------------------ render
function render() {
  const el = ui.el;
  if (!el) return; // the panel element can arrive before it is attached to the page
  const tabs = [
    ["snapshots", "Snapshots", "Snapshots saved in this workflow"],
    ["library", "Library", "Your snapshots for any workflow"],
    ["chat", "Chat", "Ask about this workflow in plain words"],
  ];
  el.innerHTML = `<div class="va">
    <div class="va-head"><img src="${LOGO_PNG}" alt=""><b>Vision Assistant</b></div>
    <div class="va-tabs">${tabs.map(([id, label, tip]) => `<button class="va-tab${ui.tab === id ? " on" : ""}" data-tab="${id}" title="${tip}">${label}${id === "chat" && problems() ? '<span class="va-dot"></span>' : ""}</button>`).join("")}<button class="va-help${ui.help ? " on" : ""}" data-help title="Help: how to use it, FAQ, tips">?</button></div>
    ${ui.help ? `<div class="va-helpbox"><div class="va-hhead"><span>Vision Assistant help</span><button class="va-dots" data-helpclose title="Close">✕</button></div>${HELP_HTML}</div>` : ""}
    <div class="va-body"></div></div>`;
  el.querySelectorAll(".va-tab").forEach((b) => (b.onclick = () => {
    ui.tab = b.dataset.tab;
    ui.view = "list";
    ui.menu = null;
    render();
  }));
  el.querySelector("[data-help]").onclick = (e) => {
    e.stopPropagation();
    ui.help = !ui.help;
    render();
  };
  const hc = el.querySelector("[data-helpclose]");
  if (hc) hc.onclick = () => {
    ui.help = false;
    render();
  };
  if (ui.help) {
    // keep the help open (and its sections as they were) while the rest of the panel refreshes
    const box = el.querySelector(".va-helpbox");
    box.querySelectorAll("details").forEach((d, i) => {
      if (ui.helpOpen && i in ui.helpOpen) d.open = ui.helpOpen[i];
      d.ontoggle = () => {
        ui.helpOpen = ui.helpOpen || {};
        ui.helpOpen[i] = d.open;
      };
    });
    if (ui.helpScroll) box.scrollTop = ui.helpScroll;
    box.onscroll = () => (ui.helpScroll = box.scrollTop);
  }
  const body = el.querySelector(".va-body");
  if (ui.view === "save") return renderSave(body);
  if (ui.view === "touredit") return renderTourEdit(body);
  if (ui.view === "place") return renderPlace(body);
  if (ui.tab === "snapshots") return renderSnapshots(body);
  if (ui.tab === "library") return renderLibrary(body);
  return renderChat(body);
}

function renderSnapshots(body) {
  const snaps = core.workflowSnaps();
  const n = changes().length;
  const k = wfKey();
  const u = undo.get(k);
  body.innerHTML = `
    <div class="va-sub">${esc(wfName())}</div>
    <div class="va-hint" data-live="count">${n ? `${n} change${n === 1 ? "" : "s"} since ${esc(baseline().label)}` : `No changes since ${esc(baseline().label)}`}</div>
    <button class="va-btn wide pri" data-act="save" title="Pick which of your changes go into a new snapshot">Save snapshot</button>
    ${u ? `<button class="va-link" data-act="undo" title="Put back the settings from before you applied it">Undo "${esc(u.name)}"</button>` : ""}
    <div class="va-list">${snaps.length ? snaps.map((s, i) => rowHtml(s, i, applied.get(k) === s.name)).join("") :
      `<div class="va-hint" style="margin-top:8px">Set the workflow up the way you want (model, LoRAs, steps, bypassed nodes), then save it as a snapshot. Applying it later only changes what it holds: your prompt, seed and input images stay put.</div>`}</div>
    ${toursHtml()}`;
  body.querySelector('[data-act="save"]').onclick = () => openSave();
  const ub = body.querySelector('[data-act="undo"]');
  if (ub) ub.onclick = () => {
    core.restore(u.state);
    undo.delete(k);
    applied.delete(k);
    resetBaseline("undo");
    toast("info", `Undid "${u.name}"`);
    render();
  };
  wireRows(body, snaps, false);
  wireTours(body);
}

// ------------------------------------------------------------------ tours (saved in the workflow, edited by right-click only)
const lastTour = () => ui.tours.get(wfKey()) || null;

function toursHtml() {
  const t = tour.saved();
  const fresh = lastTour();
  const menu = ui.menu === "tour";
  const locked = tour.isLocked();
  return `<div class="va-group" style="margin-top:12px">Guided tour</div>
    ${t ? `<div class="va-row" data-tourrow title="${locked ? "Locked. Right-click to unlock it for editing" : "Unlocked. Right-click to edit, rebuild, delete or lock it"}">
        <div class="va-grow"><div class="va-name">${locked ? "🔒" : "🔓"} ${esc(t.title)}</div><div class="va-sub">${t.steps.length} steps, saved in this workflow${locked ? ", locked" : ", <b>unlocked</b>"}</div></div>
        <button class="va-btn" data-tp="play" title="Play the tour">▶ Play</button>
        ${menu ? `<div class="va-menu">${locked ? `<button data-tm="unlock">🔓 Unlock to edit</button>`
          : `<button data-tm="edit">Edit tour…</button><button data-tm="rebuild">Build a new one (replaces this)</button><button data-tm="delete">Delete tour</button><button data-tm="lock">🔒 Lock</button>`}</div>` : ""}
      </div>`
      : fresh ? `<div class="va-row"><div class="va-grow"><div class="va-name">🧭 ${esc(fresh.title)}</div><div class="va-sub">${fresh.steps.length} steps, not saved yet</div></div>
        <button class="va-btn" data-tp="play">▶ Play</button><button class="va-btn pri" data-tp="save" title="Saves the tour inside this workflow, so everyone who opens it gets it">Save to workflow</button></div>`
      : `<div class="va-hint">No tour yet. Ask the chat "Explain this workflow" and press <b>▶ Guided tour</b>, then save it here.</div>`}`;
}

function wireTours(body) {
  const row = body.querySelector("[data-tourrow]");
  if (row) row.oncontextmenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    ui.menu = "tour";
    render();
  };
  body.querySelectorAll("[data-tp]").forEach((b) => (b.onclick = () => {
    if (b.dataset.tp === "play") return tour.start(tour.saved() || lastTour(), 0);
    try {
      tour.save(lastTour());
    } catch (err) {
      return toast("error", "Not saved", err.message);
    }
    ui.tours.delete(wfKey());
    toast("success", "Tour saved and locked", "Save the workflow to keep it. Right-click the tour to unlock it for editing.");
    render();
  }));
  body.querySelectorAll("[data-tm]").forEach((b) => (b.onclick = async (e) => {
    e.stopPropagation();
    ui.menu = null;
    const a = b.dataset.tm;
    if (a === "unlock" || a === "lock") {
      tour.setLocked(a === "lock");
      toast("info", a === "lock" ? "Tour locked" : "Tour unlocked", a === "lock" ? "Nothing can change it until you unlock it." : "Edit it, then lock it again (saving an edit locks it for you).");
      return render();
    }
    if (a === "edit") {
      ui.view = "touredit";
      ui.tourEdit = JSON.parse(JSON.stringify(tour.saved()));
      return render();
    }
    if (a === "delete") {
      tour.remove(); // refuses while locked
      toast("info", "Tour deleted");
      return render();
    }
    if (a === "rebuild") {
      toast("info", "Building a new tour…", "This takes a moment.");
      try {
        tour.save(await tour.build(chat.choice()));
        toast("success", "New tour saved");
      } catch (err) {
        toast("error", "The tour didn't build", err.message);
      }
      return render();
    }
  }));
}

function renderTourEdit(body) {
  const t = ui.tourEdit;
  body.innerHTML = `
    <div class="va-name" style="font-weight:600">Edit tour</div>
    <div class="va-hint">Change the words people see. The parts and the marked settings stay as they are.</div>
    <input class="va-input" data-f="title" value="${esc(t.title)}" title="The tour's name">
    ${t.steps.map((st, i) => `<div class="va-group">Step ${i + 1}</div>
      <input class="va-input" data-st="${i}" data-k="title" value="${esc(st.title)}">
      <textarea class="va-input" data-st="${i}" data-k="text" rows="3" style="resize:vertical;font-family:inherit">${esc(st.text)}</textarea>
      ${st.settings.map((x) => `<div class="va-sub">• ${esc(x.widget)}: <input class="va-input" style="display:inline-block;width:auto;min-width:60%;padding:2px 6px" data-set="${i}|${esc(x.node)}|${esc(x.widget)}" value="${esc(x.why)}"></div>`).join("")}`).join("")}
    <div class="va-actions" style="margin-top:8px"><button class="va-btn pri" data-te="save">Save</button><button class="va-btn" data-te="cancel">Cancel</button></div>`;
  body.querySelectorAll("input, textarea").forEach((el) => (el.onkeydown = (e) => e.stopPropagation()));
  body.querySelector('[data-te="cancel"]').onclick = () => {
    ui.view = "list";
    render();
  };
  body.querySelector('[data-te="save"]').onclick = () => {
    t.title = body.querySelector('[data-f="title"]').value.trim() || t.title;
    body.querySelectorAll("[data-st]").forEach((el) => (t.steps[Number(el.dataset.st)][el.dataset.k] = el.value.trim()));
    body.querySelectorAll("[data-set]").forEach((el) => {
      const [i, node, widget] = el.dataset.set.split("|");
      const x = t.steps[Number(i)].settings.find((y) => String(y.node) === node && y.widget === widget);
      if (x) x.why = el.value.trim();
    });
    tour.save(t); // locks it again
    ui.view = "list";
    toast("success", "Tour saved and locked", "Save the workflow to keep it.");
    render();
  };
}

function rowHtml(s, i, isApplied, lib = false, fit = null) {
  const menu = ui.menu === `${lib ? "l" : "w"}${i}`;
  const none = fit && !fit.ok;
  const part = fit && fit.ok && fit.ok < fit.total;
  const badge = !fit ? "" : none ? '<span class="va-fit no">not for this workflow</span>'
    : part ? `<span class="va-fit part">partly: ${fit.ok} of ${fit.total}</span>` : '<span class="va-fit ok">fits</span>';
  const applyTip = none ? `None of its nodes are in this workflow${s.from ? ` (made for ${s.from})` : ""}.`
    : part ? `Applies ${fit.ok} of ${fit.total}. Skipped: ${fit.miss.slice(0, 6).join("; ")}${fit.miss.length > 6 ? "…" : ""}`
    : "Change the workflow to this snapshot's settings";
  const items = lib ? [["rename", "Rename"], ["towf", "Add to this workflow"], ["delete", "Delete"]]
    : [["update", "Update with current values"], ["rename", "Rename"], ["tolib", "Add to library"], ["delete", "Delete"]];
  return `<div class="va-row" data-i="${i}">
    <div class="va-grow"><div class="va-name">${esc(s.name)}${isApplied ? '<span class="va-badge">applied</span>' : ""}${badge}</div>
    <div class="va-sub">${esc(core.summary(s))}${lib && s.from ? ` · made for ${esc(s.from)}` : ""}</div></div>
    <button class="va-btn" data-do="apply" title="${esc(applyTip)}" ${none ? "disabled" : ""}>Apply</button>
    <button class="va-dots" data-do="menu" title="More">⋯</button>
    ${menu ? `<div class="va-menu">${items.map(([a, l]) => `<button data-do="${a}">${l}</button>`).join("")}</div>` : ""}
  </div>`;
}

function wireRows(body, list, lib) {
  body.querySelectorAll(".va-row").forEach((row) => {
    const i = Number(row.dataset.i);
    const s = list[i];
    row.querySelectorAll("[data-do]").forEach((b) => (b.onclick = async (e) => {
      e.stopPropagation();
      const a = b.dataset.do;
      if (a === "menu") {
        ui.menu = ui.menu === `${lib ? "l" : "w"}${i}` ? null : `${lib ? "l" : "w"}${i}`;
        return render();
      }
      ui.menu = null;
      if (a === "apply") return lib ? applyLibrary(s) : applySnap(s, false, {});
      if (a === "update") {
        const cur = core.capture();
        s.items = s.items.map((it) => {
          const c = cur[it.key.id];
          if (!c || c.type !== it.key.type) return it;
          return it.kind === "mode" ? { ...it, value: c.mode } : { ...it, value: it.name in c.w ? c.w[it.name] : it.value };
        });
        core.saveWorkflowSnaps(list);
        toast("success", `Updated "${s.name}"`, "It now holds the current values of its settings.");
        return render();
      }
      if (a === "rename") return renameRow(row, s, list, lib);
      if (a === "delete") return confirmRow(row, `Delete "${s.name}"?`, async () => {
        list.splice(i, 1);
        if (lib) await core.saveLibrary(list); else core.saveWorkflowSnaps(list);
        render();
      });
      if (a === "tolib") {
        const libList = await core.loadLibrary();
        libList.push({ ...JSON.parse(JSON.stringify(s)), created: Date.now(), from: wfName() });
        await core.saveLibrary(libList);
        ui.lib = libList;
        toast("success", `Added "${s.name}" to your library`);
        return render();
      }
      if (a === "towf") {
        const wl = core.workflowSnaps();
        wl.push(JSON.parse(JSON.stringify(s)));
        core.saveWorkflowSnaps(wl);
        toast("success", `Added "${s.name}" to this workflow`, "Node matches are by type, check it once with Apply.");
        return render();
      }
    }));
  });
}

function renameRow(row, s, list, lib) {
  const name = row.querySelector(".va-name");
  name.innerHTML = `<input class="va-input" value="${esc(s.name)}" title="Enter to save, Esc to cancel">`;
  const inp = name.querySelector("input");
  inp.focus();
  inp.select();
  inp.onkeydown = async (e) => {
    e.stopPropagation();
    if (e.key === "Escape") return render();
    if (e.key !== "Enter") return;
    const v = inp.value.trim();
    if (!v) return;
    s.name = v;
    if (lib) await core.saveLibrary(list); else core.saveWorkflowSnaps(list);
    render();
  };
}

function confirmRow(row, text, yes) {
  row.innerHTML = `<div class="va-grow">${esc(text)}</div><button class="va-btn" data-y>Delete</button><button class="va-btn" data-n>Cancel</button>`;
  row.querySelector("[data-y]").onclick = yes;
  row.querySelector("[data-n]").onclick = () => render();
}

function applySnap(s, library, picks) {
  const k = wfKey();
  const r = core.apply(s, { library, picks });
  undo.set(k, { state: r.before, name: s.name });
  applied.set(k, s.name);
  resetBaseline(`"${s.name}" was applied`);
  const sk = r.skipped.length;
  toast(sk ? "warn" : "success", `Applied "${s.name}"`,
    `${r.changed} change${r.changed === 1 ? "" : "s"}.` + (sk ? ` ${sk} skipped: ${r.skipped.slice(0, 3).join("; ")}${sk > 3 ? "…" : ""}` : ""));
  ui.view = "list";
  render();
}

// ------------------------------------------------------------------ save view
function openSave() {
  ui.save = { name: "", all: false, picks: null, error: "" };
  ui.view = "save";
  render();
}

function renderSave(body) {
  const sv = ui.save;
  const base = baseline();
  const items = core.diff(base.state, core.capture(), { all: sv.all });
  if (!sv.picks) sv.picks = new Set(items.map((it, i) => (it.changed && !it.off ? i : -1)).filter((i) => i >= 0));
  const byNode = new Map();
  const titles = {};
  core.nodesOf().forEach((n) => (titles[core.nodeLabel(n)] = (titles[core.nodeLabel(n)] || 0) + 1));
  items.forEach((it, i) => {
    const g = titles[it.key.title] > 1 ? `${it.key.title} #${it.key.id}` : `${it.key.title}`; // two nodes with one title
    if (!byNode.has(g)) byNode.set(g, []);
    byNode.get(g).push([it, i]);
  });
  const line = (it) => it.kind === "mode"
    ? `${it.changed ? `${core.MODE_NAMES[it.from] || "on"} → ` : ""}${core.MODE_NAMES[it.value] || "on"}`
    : `${esc(it.name)}: ${it.changed ? `${esc(core.fmt(it.from))} → ` : ""}${esc(core.fmt(it.value))}`;
  const nChanged = items.filter((i) => i.changed).length;
  body.innerHTML = `
    <div class="va-name" style="font-weight:600">Save snapshot</div>
    <div class="va-hint">${nChanged} change${nChanged === 1 ? "" : "s"} since ${esc(base.label)}. Ticked ones go in. Prompts, seeds and input images are left out unless you tick them.</div>
    <input class="va-input" data-f="name" placeholder="Animosity" value="${esc(sv.name)}" title="A short name, like the model or the look">
    <label class="va-check" title="List every setting, not only the ones you changed"><input type="checkbox" data-f="all" ${sv.all ? "checked" : ""}> Show unchanged settings too</label>
    <div class="va-items">${items.length ? [...byNode.entries()].map(([g, list]) => `<div class="va-group">${esc(g)}</div>` + list.map(([it, i]) =>
      `<label class="va-check${it.off ? " off" : ""}"><input type="checkbox" data-i="${i}" ${sv.picks.has(i) ? "checked" : ""}><span>${line(it)}${it.off ? `<span class="va-tag">${it.off}</span>` : ""}</span></label>`).join("")).join("")
      : `<div class="va-hint">Nothing has changed yet. Change some settings first, or tick "Show unchanged settings too".</div>`}</div>
    ${sv.error ? `<div class="va-err">${esc(sv.error)}</div>` : ""}
    <div class="va-actions">
      <button class="va-btn pri" data-s="wf" title="Saved inside this workflow, so it travels with it">Save to workflow</button>
      <button class="va-btn" data-s="lib" title="Saved in your library, for any workflow with the same kind of nodes">Save to library</button>
      <button class="va-btn" data-s="cancel">Cancel</button>
    </div>`;
  const nameInp = body.querySelector('[data-f="name"]');
  nameInp.oninput = () => {
    sv.name = nameInp.value;
    if (sv.error) {
      sv.error = "";
      body.querySelector(".va-err")?.remove();
    }
  };
  nameInp.onkeydown = (e) => e.stopPropagation();
  body.querySelector('[data-f="all"]').onchange = (e) => {
    sv.all = e.target.checked;
    sv.picks = null;
    render();
  };
  body.querySelectorAll(".va-items input[data-i]").forEach((c) => (c.onchange = () => {
    const i = Number(c.dataset.i);
    if (c.checked) sv.picks.add(i); else sv.picks.delete(i);
  }));
  body.querySelectorAll("[data-s]").forEach((b) => (b.onclick = async () => {
    if (b.dataset.s === "cancel") {
      ui.view = "list";
      return render();
    }
    const name = sv.name.trim();
    const chosen = items.filter((_, i) => sv.picks.has(i)).map(({ key, kind, name: n, value }) => (kind === "mode" ? { key, kind, value } : { key, kind, name: n, value }));
    if (!name) sv.error = "Give the snapshot a name.";
    else if (!chosen.length) sv.error = "Tick at least one setting.";
    if (sv.error) return render();
    const snap = { name, created: Date.now(), items: chosen, ...(b.dataset.s === "lib" ? { from: wfName() } : {}) };
    if (b.dataset.s === "wf") {
      const list = core.workflowSnaps();
      const old = list.findIndex((s) => s.name === name);
      if (old >= 0) list[old] = snap; else list.push(snap);
      core.saveWorkflowSnaps(list);
      applied.set(wfKey(), name);
    } else {
      try {
        const list = await core.loadLibrary();
        const old = list.findIndex((s) => s.name === name);
        if (old >= 0) list[old] = snap; else list.push(snap);
        await core.saveLibrary(list);
        ui.lib = list;
      } catch (e) {
        sv.error = e.message;
        return render();
      }
    }
    resetBaseline(`"${name}" was saved`);
    toast("success", `Saved "${name}"`, `${chosen.length} setting${chosen.length === 1 ? "" : "s"}${b.dataset.s === "lib" ? " in your library" : " in this workflow"}.`);
    ui.view = "list";
    ui.tab = b.dataset.s === "lib" ? "library" : "snapshots";
    render();
  }));
}

// ------------------------------------------------------------------ library
async function renderLibrary(body) {
  if (!ui.lib) {
    body.innerHTML = `<div class="va-hint">Loading your library…</div>`;
    ui.lib = await core.loadLibrary();
    if (ui.tab !== "library" || ui.view !== "list") return;
  }
  const list = ui.lib;
  // how each one fits the open workflow: fitting first, then partly, the rest folded away
  const rows = list.map((s, i) => ({ s, i, fit: core.fitOf(s) }));
  const rank = (r) => (!r.fit.ok ? 2 : r.fit.ok < r.fit.total ? 1 : 0);
  rows.sort((a, b) => rank(a) - rank(b) || a.s.name.localeCompare(b.s.name));
  const usable = rows.filter((r) => r.fit.ok);
  const other = rows.filter((r) => !r.fit.ok);
  body.innerHTML = `
    <div class="va-hint">Your snapshots for any workflow. Each one shows how well it fits this workflow. Applying one matches nodes by type, and asks when a workflow has two of the same.</div>
    <div class="va-list">${!list.length ? `<div class="va-hint" style="margin-top:8px">Empty for now. Save a snapshot with "Save to library", or add one from a workflow's ⋯ menu.</div>`
      : usable.length ? usable.map((r) => rowHtml(r.s, r.i, false, true, r.fit)).join("") : `<div class="va-hint" style="margin-top:8px">None of your library snapshots fit this workflow.</div>`}</div>
    ${other.length ? `<button class="va-link" data-c="libother" style="margin-top:8px;text-align:left" title="Snapshots made for other workflows: none of their nodes are here">${ui.libOther ? "▾" : "▸"} For other workflows (${other.length})</button>
      ${ui.libOther ? `<div class="va-list va-dim">${other.map((r) => rowHtml(r.s, r.i, false, true, r.fit)).join("")}</div>` : ""}` : ""}`;
  const lo = body.querySelector('[data-c="libother"]');
  if (lo) lo.onclick = () => {
    ui.libOther = !ui.libOther;
    render();
  };
  wireRows(body, list, true);
}

function applyLibrary(s) {
  const amb = core.ambiguous(s);
  if (!amb.length) return applySnap(s, true, {});
  ui.place = { snap: s, amb, picks: {} };
  ui.view = "place";
  render();
}

function renderPlace(body) {
  const pl = ui.place;
  body.innerHTML = `
    <div class="va-name" style="font-weight:600">Where should "${esc(pl.snap.name)}" go?</div>
    <div class="va-hint">This workflow has more than one of these nodes. Pick the one to change, or all of them.</div>
    ${pl.amb.map((a, j) => `<div class="va-group">${esc(a.key.title)} <span class="va-tag">${esc(a.key.type)}</span></div>
      <select class="va-input" data-j="${j}"><option value="">Skip it</option><option value="*">All of them</option>
      ${a.options.map((n) => `<option value="${n.id}"${String(n.id) === String(a.key.id) ? " selected" : ""}>${esc(core.nodeLabel(n))} (#${n.id})</option>`).join("")}</select>`).join("")}
    <div class="va-actions" style="margin-top:8px"><button class="va-btn pri" data-p="go">Apply</button><button class="va-btn" data-p="cancel">Cancel</button></div>`;
  body.querySelector('[data-p="cancel"]').onclick = () => {
    ui.view = "list";
    render();
  };
  body.querySelector('[data-p="go"]').onclick = () => {
    const picks = {};
    body.querySelectorAll("select[data-j]").forEach((sel) => {
      const a = pl.amb[Number(sel.dataset.j)];
      const k = `${a.key.type}|${a.key.title}|${a.key.id}`;
      picks[k] = sel.value === "*" ? a.options.map((n) => n.id) : sel.value ? [sel.value] : ["__none__"];
    });
    applySnap(pl.snap, true, picks);
  };
}

// ------------------------------------------------------------------ chat: checkup cards first, then the conversation
const problems = () => (ui.cards || []).filter((c) => c.level === 3).length;
const sigOf = (cards) => cards.map((c) => `${c.level}|${c.title}|${c.nodeId ?? ""}`).join("|");

async function refreshCards(force = false) {
  const cards = await check.checkAll();
  const sig = sigOf(cards);
  const changed = sig !== ui.sig;
  ui.cards = cards;
  ui.sig = sig;
  markIcon();
  if ((changed || force) && ui.el?.isConnected && ui.view === "list" && !ui.busy && !ui.el.contains(document.activeElement)) render();
  else if (changed && ui.el?.isConnected) ui.el.querySelector('[data-tab="chat"]')?.replaceChildren(document.createTextNode("Chat"), ...(problems() ? [Object.assign(document.createElement("span"), { className: "va-dot" })] : []));
}

function markIcon() {
  const btn = document.querySelector(".va-icon")?.closest("button");
  btn?.classList.toggle("va-alert", problems() > 0);
}

function renderChat(body) {
  if (!ui.cards) {
    body.innerHTML = `<div class="va-hint">Checking this workflow…</div>`;
    return refreshCards(true);
  }
  const cards = ui.cards;
  const msgs = chatOf();
  const st = ui.chatStatus;
  if (!st) status();
  const lite = !!(st && !st.pending && st.available && (!st.plan || st.plan.lite));
  const open = ui.cardsOpen ?? !msgs.length;
  const p = problems();
  body.innerHTML = `
    <div class="va-row" style="border-top:0;padding-top:0">
      <button class="va-link va-grow" style="text-align:left" data-c="toggle" title="${open ? "Hide" : "Show"} the checkup">${open ? "▾" : "▸"} ${cards.length ? `Checkup: ${cards.length} thing${cards.length === 1 ? "" : "s"} to look at${p ? ` (${p} problem${p === 1 ? "" : "s"})` : ""}` : "Checkup: all good"}</button>
      <button class="va-btn" data-c="recheck" title="Check the workflow and this computer again">${ui.busy === "check" ? "Checking…" : "Check again"}</button></div>
    ${ui.checked ? `<div class="va-hint">✓ ${esc(ui.checked)}</div>` : ""}
    ${open ? (cards.length ? cards.map((c, i) => `<div class="va-card l${c.level}" data-k="${i}">
      <div class="va-name">${c.level === 3 ? "⚠️ " : c.level === 1 ? "💡 " : ""}${esc(c.title)}</div>
      <div class="va-hint">${esc(c.text)}</div>
      <div class="va-actions">${c.nodeId != null && check.nodeById(c.nodeId) ? `<button class="va-btn" data-a="show" title="Jump to the node">Show node</button>` : ""}
        ${(c.actions || []).map((a, j) => `<button class="va-btn${a.run && a.run !== "dismiss" ? " pri" : ""}" data-a="${j}" title="${esc(a.tip || "")}">${ui.busy === `${i}:${j}` ? "Working…" : esc(a.label)}${a.href ? " ↗" : ""}</button>`).join("")}</div>
    </div>`).join("") : `<div class="va-hint">✅ Nothing wrong that I can see: every node is installed, every file is here, and the text encoder matches the model.</div>`) : ""}
    <div class="va-chat">
      ${msgs.length ? msgs.map((m, i) => msgHtml(m, i)).join("") : `<div class="va-hint">Ask about this workflow in plain words. I can explain it, find problems and change settings, and I always ask before I change or run anything.</div>
        <div class="va-chips">${["What's wrong with this workflow?", "Explain this workflow", "How do I make it faster?", ...(authorKnown() ? ["About the author"] : [])].map((s) => `<button class="va-chip" data-q="${esc(s)}">${esc(s)}</button>`).join("")}</div>`}
      ${ui.busy === "chat" ? `<div class="va-msg bot"><span class="va-typing">Thinking…</span></div>` : ""}
    </div>
    ${st && !st.available ? `<div class="va-err">${esc(st.why || "The chat isn't available.")}</div>` : ""}
    ${lite ? `<div class="va-card l0"><div class="va-name">💡 Chat is off on this card</div><div class="va-hint">${esc(st.plan?.why || st.why || "")}</div></div>` : `
    <div class="va-compose">
      <textarea class="va-input" data-c="input" rows="2" placeholder="Ask Vision Assistant…" title="Enter sends, Shift+Enter for a new line">${esc(ui.draft || "")}</textarea>
      <button class="va-btn pri" data-c="send" title="Send">${ui.busy === "chat" ? "…" : "Send"}</button>
    </div>`}
    <div class="va-row va-sub" style="border-top:0;padding:0;gap:6px">
      ${st?.models ? `<select class="va-input va-model" data-c="model" title="${esc(planTip(st))}">
        <option value="auto"${chat.choice() === "auto" ? " selected" : ""}>Auto: ${esc(st.plan?.name ? `${shortName(st.plan.name)} · ${st.plan.ctx / 1024}k · ${st.plan.mode === "cpu" ? "CPU" : `~${st.plan.need_gb} GB`}` : "chat off on this card")}</option>
        ${st.models.map((m) => `<option value="${esc(m)}"${m === chat.choice() ? " selected" : ""}>${esc(shortName(m))}</option>`).join("")}
        <option value="off"${chat.choice() === "off" ? " selected" : ""}>Off: checkup only, no VRAM</option></select>` : ""}
      ${msgs.length ? `<button class="va-link" data-c="clear" title="Start a new conversation">Clear</button>` : ""}
      <button class="va-link" data-c="unload" title="Unload the chat model now. It also unloads by itself when you queue, or a minute after the last answer.">Free VRAM</button>
    </div>`;
  body.querySelector('[data-c="toggle"]').onclick = () => {
    ui.cardsOpen = !open;
    render();
  };
  body.querySelector('[data-c="recheck"]').onclick = async () => {
    ui.busy = "check";
    ui.cardsOpen = true;
    render();
    const was = ui.sig;
    const wait = new Promise((r) => setTimeout(r, 700)); // long enough to see that it ran
    await check.system(true).catch(() => {});
    await check.report(true).catch(() => {});
    check.dismissError();
    ui.cards = await check.checkAll();
    ui.sig = sigOf(ui.cards);
    await wait;
    ui.busy = "";
    const n = ui.cards.length;
    ui.checked = `Checked just now: ${n ? `${n} thing${n === 1 ? "" : "s"} to look at` : "all good"}${ui.sig === was ? ", nothing changed" : ""}.`;
    markIcon();
    render();
    setTimeout(() => {
      ui.checked = "";
      if (ui.tab === "chat" && ui.view === "list" && !ui.el?.contains(document.activeElement)) render();
    }, 4000);
  };
  body.querySelectorAll(".va-card").forEach((el) => {
    const c = cards[Number(el.dataset.k)];
    el.querySelectorAll("[data-a]").forEach((b) => (b.onclick = () => cardAction(c, b.dataset.a, `${el.dataset.k}:${b.dataset.a}`)));
  });
  const inp = body.querySelector('[data-c="input"]'); // not there in Lite / Off
  if (inp) {
    inp.oninput = () => (ui.draft = inp.value);
    inp.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        ask(inp.value);
      }
    };
    inp.onkeyup = (e) => e.stopPropagation();
    body.querySelector('[data-c="send"]').onclick = () => ask(inp.value);
  }
  body.querySelectorAll("[data-q]").forEach((b) => (b.onclick = () => ask(b.dataset.q)));
  const sel = body.querySelector('[data-c="model"]');
  if (sel) sel.onchange = async () => {
    await app.extensionManager.setting.set("LCVision.Chat.Model", sel.value); // same as LC Settings ⚙️ > Vision > Chat model
    chat.unload();
    ui.chatStatus = null;
    render();
  };
  const clr = body.querySelector('[data-c="clear"]');
  if (clr) clr.onclick = () => {
    ui.chats.set(wfKey(), []);
    render();
  };
  body.querySelector('[data-c="unload"]').onclick = async () => {
    await chat.unload();
    toast("info", "Chat model unloaded");
  };
  body.querySelectorAll("[data-m]").forEach((b) => (b.onclick = () => proposal(Number(b.dataset.m), b.dataset.p)));
  body.querySelectorAll("[data-tour]").forEach((b) => (b.onclick = () => startTour(Number(b.dataset.tour), 0)));
  body.querySelectorAll("[data-step]").forEach((li) => (li.onclick = () => {
    const [mi, k] = li.dataset.step.split("|").map(Number);
    startTour(mi, k);
  }));
  const box = body.querySelector(".va-chat");
  box.lastElementChild?.scrollIntoView?.({ block: "end" });
  if (ui.focusInput) {
    ui.focusInput = false;
    inp?.focus();
  }
}

const EXPLAIN_Q = /explain|how does (this|the|it)|what does (this|the) workflow|walk me through|guided tour|give me a tour/i;

/** The saved tour if the workflow has one (the author's words), else build one with the model. */
async function startTour(mi, step) {
  const m = chatOf()[mi];
  if (!m) return;
  if (!m.tour) {
    const t = tour.saved() || lastTour();
    if (t) m.tour = t;
    else {
      m.tourBusy = true;
      render();
      try {
        m.tour = await tour.build(chat.choice());
        ui.tours.set(wfKey(), m.tour);
        usedChat = true;
      } catch (e) {
        toast("error", "The tour didn't build", e.message);
      }
      m.tourBusy = false;
      render();
      if (!m.tour) return;
    }
  }
  tour.start(m.tour, step, () => {
    if (ui.tab === "chat" && ui.view === "list" && !ui.el?.contains(document.activeElement)) render();
  });
}

const shortName = (m) => String(m).replace(/-Instruct|-abliterated(-v\d)?|_abliterated(-v\d)?|-c_abliterated(-v\d)?|Huihui-/gi, "").replace(/\.gguf$/i, "");
const planTip = (st) => st.plan?.mode === "cpu" ? st.plan.why : st.plan?.name
  ? `Auto picked ${st.plan.name} with ${st.plan.ctx} context: about ${st.plan.need_gb} GB of VRAM on your ${st.plan.vram_gb} GB card, only while you chat (it unloads a minute after the last answer, or when you queue).`
  : (st.plan?.why || "Which LC Vision model answers.");

const chatOf = () => {
  if (!ui.chats.has(wfKey())) ui.chats.set(wfKey(), []);
  return ui.chats.get(wfKey());
};

async function status() {
  ui.chatStatus = { pending: true, available: true };
  ui.chatStatus = await chat.status();
  if (ui.tab === "chat" && ui.view === "list") render();
}

// Light Markdown for the replies: headings, rules, bullet and numbered lists, bold, italics, code, links
function md(text) {
  const a = (u, t) => `<a href="${u}" target="_blank" rel="noopener">${t}</a>`;
  const inline = (s) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<i>$2</i>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (m, t, u) => a(u, t))
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, (m, pre, u) => pre + a(u, u.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")));
  const out = [];
  let list = null;
  let olCount = 0;
  const close = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (const raw of String(text || "").split("\n")) {
    const line = raw.trimEnd();
    let m;
    if ((m = line.match(/^\s*#{1,6}\s+(.*)$/))) {
      close();
      olCount = 0;
      out.push(`<div class="va-h">${inline(m[1])}</div>`);
    } else if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      close();
      out.push("<hr>");
    } else if ((m = line.match(/^\s*[-*•]\s+(.*)$/)) || (m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      const kind = /^\s*\d/.test(line) ? "ol" : "ul";
      if (list !== kind) {
        close();
        // a numbered list split by blank lines (or by bullets under an item) keeps counting
        const n = parseInt(line, 10);
        const start = kind === "ol" ? (n > 1 ? n : olCount + 1) : 0;
        out.push(kind === "ol" && start > 1 ? `<ol start="${start}">` : `<${kind}>`);
        if (kind === "ol") olCount = start - 1;
        list = kind;
      }
      if (kind === "ol") olCount++;
      out.push(`<li>${inline(m[1])}</li>`);
    } else if (!line.trim()) {
      close();
      out.push('<div class="va-gap"></div>');
    } else {
      close();
      olCount = 0;
      out.push(`<div>${inline(line)}</div>`);
    }
  }
  close();
  return out.join("").replace(/(<div class="va-gap"><\/div>)+/g, '<div class="va-gap"></div>');
}

function msgHtml(m, i) {
  if (m.role === "user") return `<div class="va-msg me">${esc(m.content)}</div>`;
  const txt = md(m.content);
  const props = (m.vetted || []).filter((v) => !v.suggest);
  const good = props.filter((v) => v.ok && !v.safe);
  const shows = props.filter((v) => v.ok && v.safe);
  const bad = props.filter((v) => !v.ok && v.text);
  const last = i === chatOf().length - 1 && ui.busy !== "chat";
  const chips = last ? (m.chips || []) : [];
  const asked = chatOf()[i - 1];
  const explain = !m.error && asked?.role === "user" && !asked.about && EXPLAIN_Q.test(asked.content);
  const canBuild = !!ui.chatStatus?.plan?.tours || !!tour.saved() || !!m.tour || !!lastTour();
  const tourBit = !explain ? "" : `<div class="va-tourbar"><button class="va-btn pri" data-tour="${i}" ${canBuild ? "" : "disabled"} title="${canBuild ? "Walks you through the workflow on the canvas, one part at a time" : "Building a tour needs about 11 GB of VRAM (the 8B model). A tour saved in the workflow still plays on any card."}">${m.tourBusy ? "Building the tour (about a minute)…" : "▶ Guided tour"}</button>${tour.saved() ? '<span class="va-sub">by the author</span>' : ""}</div>
    ${m.tour ? `<div class="va-group" style="margin-top:4px">How it works <span class="va-sub">(click a step)</span></div><ol class="va-tourlist">${m.tour.steps.map((st, k) => `<li data-step="${i}|${k}" class="${tour.playing() === k ? "on" : ""}"><b>${esc(st.title)}</b><span>${esc(st.text)}</span></li>`).join("")}</ol>` : ""}`;
  return `<div class="va-msg bot${m.error ? " err" : ""}">${tourBit}${txt || (props.length ? "" : "…")}
    ${good.length ? `<div class="va-prop"><div class="va-group" style="margin-top:0">${m.state === "done" ? "Done:" : m.state === "no" ? "Not done:" : "Shall I do this?"}</div>
      ${good.map((v) => `<div class="va-check">• ${esc(v.text)}</div>`).join("")}
      ${m.state ? (m.state === "done" ? `<button class="va-link" data-m="${i}" data-p="undo" title="Put the settings back">Undo</button>` : "")
        : `<div class="va-actions"><button class="va-btn pri" data-m="${i}" data-p="yes">Yes, do it</button><button class="va-btn" data-m="${i}" data-p="no">No</button></div>`}</div>` : ""}
    ${shows.length ? `<div class="va-actions">${shows.map((v, j) => `<button class="va-btn" data-m="${i}" data-p="show${j}" title="Make it glow again">✨ ${esc(v.text)}</button>`).join("")}</div>` : ""}
    ${bad.length ? `<div class="va-sub">Left out (not possible here): ${bad.map((v) => esc(v.text)).join("; ")}</div>` : ""}
  </div>${chips.length ? `<div class="va-chips">${chips.map((c) => (typeof c === "object" ? `<a class="va-chip" href="${esc(c.href)}" target="_blank" rel="noopener" title="${esc(c.href)}">${esc(c.label)}</a>` : `<button class="va-chip" data-q="${esc(c)}" title="Ask this">${esc(c)}</button>`)).join("")}</div>` : ""}`;
}

// Quick replies under the newest answer: the model's own suggestions, else ones that fit the checkup and selection
const AUTHOR_Q = /\bauthor\b|who (made|created|built|wrote) (this|it)|about the author/i;
const askedAboutAuthor = () => chatOf().some((m) => m.role === "user" && AUTHOR_Q.test(m.content));
const authorKnown = () => chat.hasNotes() || chat.authorLinks().length > 0;

// Quick replies under the newest answer: the model's own suggestions, else ones that fit the checkup and selection.
// "About the author" stays offered until it has been asked; right after the author answer come "Support the author"
// buttons that open the author's page (only on that answer: the next subject replaces them).
function quickReplies(vetted, asked) {
  const support = AUTHOR_Q.test(asked) ? chat.supportLinks().slice(0, 2).map((x) => ({ label: `❤️ Support the author on ${x.site}`, href: x.href })) : [];
  const said = vetted.filter((v) => v.ok && v.suggest).map((v) => v.text);
  const pending = vetted.some((v) => v.ok && !v.safe && !v.suggest);
  const out = [];
  const add = (t) => {
    if (out.length < 3 && !out.some((x) => x.toLowerCase() === t.toLowerCase()) && t.toLowerCase() !== asked.toLowerCase() && !AUTHOR_Q.test(t)) out.push(t);
  };
  said.forEach(add);
  if (!out.length) {
    const cards = ui.cards || [];
    if (!pending && cards.some((c) => check.fixesOf(c).length)) add("Can you fix it?");
    if (cards.some((c) => c.level === 3)) add("What is broken?");
    if (chat.selected().length) add("How does this work?");
    add("Explain this workflow");
    add("Do I have all the models?");
  }
  if (authorKnown() && !askedAboutAuthor()) out.splice(Math.min(out.length, 3), 0, "About the author");
  return [...support, ...out.slice(0, 4)]; // support buttons first, the usual questions still after them
}

// The model sometimes invents a plausible URL. Keep links it was actually shown, and searches; drop the rest.
function keepRealLinks(text, ctx) {
  const ok = (u) => ctx.includes(u.replace(/[).,]+$/, "")) || /^https:\/\/(huggingface\.co\/models\?search=|civitai\.com\/search\/)/.test(u);
  return text
    .replace(/\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, (m, t, u) => (ok(u) ? m : t))
    .replace(/(^|[\s(])(https?:\/\/[^\s)<>\]]+)/g, (m, pre, u) => (ok(u) ? m : `${pre}(link removed: not from this workflow)`));
}

async function ask(text) {
  text = String(text || "").trim();
  if (!text || ui.busy === "chat") return;
  const msgs = chatOf();
  // "this" with a node selected means that node: say so in the question, a big workflow buries the SELECTED block
  const sel = chat.selected();
  const about = sel.length && /\b(this|these|it)\b/i.test(text) && !/workflow|tour|walk me/i.test(text)
    ? sel.map((n) => `${n.title || n.type} (#${n.id})`).join(", ") : "";
  msgs.push({ role: "user", content: text, about });
  ui.draft = "";
  ui.busy = "chat";
  ui.cardsOpen = false;
  render();
  try {
    ui.cards = await check.checkAll(); // never answer from the previous workflow's checkup
    ui.sig = "";
    const ctx = await chat.context(text, ui.cards);
    // tell the model what became of its earlier proposals, so it never assumes they were done
    const hist = msgs.filter((m) => !m.error).map((m) => {
      const props = (m.vetted || []).filter((v) => v.ok && !v.safe);
      const note = !props.length ? "" : m.state === "done" ? " [The user said yes: these changes were made.]"
        : m.state === "no" ? " [The user said no: nothing was changed.]" : " [The user hasn't answered: nothing was changed.]";
      return { role: m.role, content: m.content + note + (m.about ? ` [About the selected node: ${m.about}]` : "") };
    });
    const r = await chat.send(hist, ctx, chat.choice());
    usedChat = true;
    const vetted = (r.actions || []).map(chat.vet);
    // a "[ ] Do this?" checklist in the text becomes buttons (and a heading left with nothing under it goes too)
    const asks = [];
    const raw = keepRealLinks(String(r.reply || ""), ctx).replace(/\s*—\s*/g, ", ")
      .replace(/\s*\(?\bCHECKUP #\d+\)?/g, "")
      // a closing "Quick replies:" / "Next steps:" list written as text: its items become buttons too
      .replace(/\n[^\n]*\b(quick replies|next steps|you (can|could) ask|try asking)\b[^\n]*\n((?:[ \t]*(?:[-*•]|\d+[.)])[^\n]*(?:\n|$))+)\s*$/i,
        (m, h, x, items) => (items.split("\n").forEach((l) => { const q = l.replace(/^[ \t]*(?:[-*•]|\d+[.)])[ \t]*/, "").replace(/\*\*/g, "").trim(); if (q) asks.push(q); }), ""))
      .replace(/^[ \t]*(?:[-*•][ \t]*)?\[[ xX]?\][ \t]*(.+)$/gm, (m, q) => (asks.push(q.replace(/\*\*/g, "").trim()), ""))
      .replace(asks.length ? /\n[^\n]*[?:][ \t]*\s*$/ : /$^/, "");
    const reply = raw.replace(/\n{3,}/g, "\n\n").trim() || (vetted.some((v) => v.ok) ? "Here's what I'd change:" : "I couldn't work that out. Try saying it another way.");
    const chips = [...new Set([...asks.map((q) => q.replace(/^["“”]+|["“”]+$/g, "")), ...quickReplies(vetted, text)])].slice(0, 6);
    msgs.push({ role: "assistant", content: reply, vetted, chips });
    vetted.filter((v) => v.ok && v.auto).slice(0, 1).forEach((v) => setTimeout(() => v.run(), 50)); // pointing changes nothing, so it just happens
  } catch (e) {
    msgs.push({ role: "assistant", content: e.message, error: true });
  }
  ui.busy = "";
  ui.focusInput = true;
  render();
}

async function proposal(i, what) {
  const m = chatOf()[i];
  if (!m) return;
  const good = (m.vetted || []).filter((v) => v.ok && !v.safe && !v.suggest);
  if (what.startsWith("show")) return (m.vetted || []).filter((v) => v.ok && v.safe && !v.suggest)[Number(what.slice(4))]?.run();
  if (what === "no") m.state = "no";
  if (what === "yes") {
    m.before = await chat.carryOut(good);
    m.state = "done";
    undo.set(wfKey(), { state: m.before, name: "the chat's changes" });
  }
  if (what === "undo" && m.before) {
    core.restore(m.before);
    m.state = "no";
    toast("info", "Put the settings back");
  }
  if (what === "yes" || what === "undo") {
    ui.cards = await check.checkAll(); // a fix (or its undo) changes what the checkup finds
    ui.sig = sigOf(ui.cards);
    markIcon();
  }
  render();
}

async function cardAction(c, which, busyKey) {
  if (which === "show") return c.nodeIds?.length > 1 ? check.showNodes(c.nodeIds) : check.showNode(c.nodeId);
  const a = c.actions[Number(which)];
  if (a.href) return window.open(a.href, "_blank", "noopener");
  if (a.run === "dismiss") {
    check.dismissError();
    return refreshCards(true);
  }
  if (a.run === "report") {
    ui.busy = busyKey;
    render();
    try {
      await check.runReport();
      toast("success", "System report done", "The findings are in the checkup.");
    } catch (e) {
      toast("error", "The report didn't run", e.message);
    }
    ui.busy = "";
    return refreshCards(true);
  }
  if (a.run?.set) {
    const before = core.capture();
    const ok = check.setWidget(...a.run.set) && (!a.run.also || check.setWidget(...a.run.also));
    if (!ok) return toast("error", "Couldn't change it", "The node or setting is gone. Check again.");
    undo.set(wfKey(), { state: before, name: c.title });
    toast("success", "Changed", `${c.title}: done. Undo is on the Snapshots tab.`);
    return refreshCards(true);
  }
  if (a.run?.repair) {
    const r = check.runFix(a);
    toast(r ? "success" : "warn", r ? "Wiring repaired" : "Nothing repaired", r ? "Save the workflow to keep it. Ctrl+Z undoes it." : "What's left needs a hand: see the checkup.");
    return refreshCards(true);
  }
  if (a.run?.quant) {
    const m = check.addQuantize(...a.run.quant);
    if (!m) return toast("error", "Couldn't add LC Model Quantize");
    check.showNode(m.id);
    return toast("info", "Added LC Model Quantize", "Check the source and format, queue it once, then pick the new file in your loader.");
  }
  if (a.run?.add) {
    const m = check.addNear(...a.run.add);
    if (!m) return toast("error", "Couldn't add it");
    toast("info", `Added ${m.title}`, "It's next to the broken node. Wire it up, then delete the old one.");
    return refreshCards(true);
  }
}

// ------------------------------------------------------------------ mount
// A different workflow can arrive in the same tab (a file dropped on it), so watch the graph's own id as well
const watchKey = () => `${wfKey()}|${app.graph?.id || ""}`;

/** Called every 1.5 s, panel open or not: notices a workflow switch and starts a fresh checkup for it. */
function checkSwitch() {
  const k = watchKey();
  if (k === ui.key) return false;
  ui.key = k;
  tour.stop();
  ui.view = "list";
  ui.menu = null;
  baseline();
  ui.cards = null;
  ui.sig = "";
  refreshCards(true).catch(() => {});
  if (ui.el?.isConnected) render();
  return true;
}

function mount(el) {
  ensureStyle();
  ui.el = el;
  baseline();
  if (!checkSwitch()) {
    ui.cards = null; // reopened: always look again rather than show what was found while it was closed
    refreshCards(true).catch(() => {});
  }
  render();
  clearInterval(ui.timer);
  requestAnimationFrame(render);
  ui.timer = setInterval(() => {
    if (!ui.el?.isConnected) return;
    if (ui.view === "list" && ui.tab === "snapshots") {
      const live = ui.el.querySelector('[data-live="count"]');
      if (live) {
        const n = changes().length;
        live.textContent = n ? `${n} change${n === 1 ? "" : "s"} since ${baseline().label}` : `No changes since ${baseline().label}`;
      }
    }
  }, 1500);
  document.addEventListener("pointerdown", closeMenu, true);
}

function closeMenu(e) {
  if (ui.help && !e.target.closest?.(".va-helpbox, [data-help]")) {
    ui.help = false;
    render();
  }
  if (ui.menu && !e.target.closest?.(".va-menu, .va-dots, [data-tourrow]")) {
    ui.menu = null;
    render();
  }
}

let enabled = false;
const TAB = {
  id: TAB_ID,
  icon: "va-icon",
  title: "Vision Assistant",
  tooltip: "Vision Assistant: snapshots, your library, and help with this workflow",
  type: "custom",
  render: (el) => mount(el),
};

/** LC Settings ⚙️ > Vision > Vision Assistant turns the whole thing on and off. */
function setEnabled(on) {
  const em = app.extensionManager;
  if (!em?.registerSidebarTab || on === enabled) return;
  enabled = on;
  if (on) return em.registerSidebarTab(TAB);
  try {
    if (em.sidebarTab?.activeSidebarTabId === TAB_ID) em.sidebarTab.toggleSidebarTab?.(TAB_ID);
  } catch (_) {}
  em.unregisterSidebarTab?.(TAB_ID);
  clearInterval(ui.timer);
  ui.el = null;
  if (usedChat) chat.unload();
}
window.LCVisionAssistant = { setEnabled };

app.registerExtension({
  name: "LC.VisionAssistant",
  async setup() {
    ensureStyle();
    if (!app.extensionManager?.registerSidebarTab) return console.warn("[Vision Assistant] this ComfyUI has no sidebar tabs");
    setEnabled(app.extensionManager.setting?.get?.("LCVision.Assistant.Enabled") !== false);
    let tick = 0;
    setInterval(() => {
      if (!enabled || checkSwitch()) return;
      if (++tick % 3 === 0) refreshCards().catch(() => {}); // keeps the red dot current while the panel is closed
    }, 1500);
    api.addEventListener("execution_start", () => {
      if (usedChat) chat.unload(); // the chat model never takes VRAM from a render
    });
  },
});
