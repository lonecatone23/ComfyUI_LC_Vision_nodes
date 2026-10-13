// Vision Assistant, Movie tab: an H3 long-video project at a glance. Segments made and still to make, the face /
// join / color checks as plain-words cards with a fix button, one-click redo, render-all and a player. Reads
// output/LC_H3/<project>/ through /lc_vision/movie/*; acts by setting the LC H3 Segment node and queueing.
import { app } from "../../../scripts/app.js";
import { api } from "../../../scripts/api.js";

const SEGMENT = "LCH3Segment";
const REDIRECT = "LCVisionRedirect";
const DIRECTOR = "LCVisionDirector";
const st = { project: "", data: null, projects: null, playing: "", loading: false, sig: "" };

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const nodesOf = (type) => (app.graph?._nodes || []).filter((n) => n.type === type || n.comfyClass === type);
const widget = (node, name) => (node?.widgets || []).find((w) => w.name === name);

/** True when the open workflow can make H3 long-video segments, so the tab only shows where it means something. */
export function relevant() {
  return nodesOf(SEGMENT).length > 0;
}

function projectFromGraph() {
  const d = nodesOf(DIRECTOR)[0];
  return d ? String(widget(d, "project")?.value || "").trim() : "";
}

async function getJson(url) {
  const r = await api.fetchApi(url);
  return r.ok ? r.json() : null;
}

export async function refresh(force) {
  if (st.loading) return;
  st.loading = true;
  try {
    if (!st.projects || force) st.projects = (await getJson("/lc_vision/movie/projects"))?.projects || [];
    const want = projectFromGraph() || st.project || st.projects[0]?.name || "";
    st.project = want;
    st.data = want ? await getJson(`/lc_vision/movie/status?project=${encodeURIComponent(want)}`) : null;
  } finally {
    st.loading = false;
  }
}

const view = (file, bust) => `/api/view?type=output&subfolder=${encodeURIComponent(st.data.subfolder)}&filename=${encodeURIComponent(file)}${bust ? `&t=${bust}` : ""}`;
const segFile = (i) => `seg_${String(i).padStart(3, "0")}.mp4`;

function faceWord(m, d) {
  if (m == null) return "";
  return m >= d.face_same ? "same person" : m >= d.face_close ? "close" : "someone else";
}

/** Everything worth a person's attention, worst first, each with the one action that fixes it. */
function problems(d) {
  const out = [];
  const segs = d.segments || [];
  for (const s of segs) {
    if (!s.done) continue;
    if (s.stale) out.push({ lvl: 3, title: `Segment ${s.index} no longer lines up`, text: `It continued from an older version of segment ${s.index - 1}, which was redone since. Redo it so the join matches.`, act: ["redo", s.index] });
    if (s.index > 1 && s.face && s.face.match < d.face_close) out.push({ lvl: 3, title: `Segment ${s.index}: face drifted`, text: `Face match ${s.face.match.toFixed(2)}: it reads as someone else. A new seed usually fixes it.`, act: ["redo", s.index] });
  }
  for (const j of d.report?.joins || []) {
    if (j.flag) out.push({ lvl: 1, title: `Jumpy join into segment ${j.segment}`, text: `At ${j.time_s.toFixed(2)} s the picture jumps ${j.jump.toFixed(2)}x more than normal motion. Redo segment ${j.segment}.`, act: ["redo", j.segment] });
  }
  for (const r of d.report?.drift || []) {
    if (r.flag) out.push({ lvl: 1, title: `Color drifting in segment ${r.segment}`, text: `Color shift ${r.delta_e.toFixed(1)} from the start of its scene${r.warmer_by > 2 ? " (getting warmer)" : r.warmer_by < -2 ? " (getting cooler)" : ""}. Set color_match to 0.3 on the LC H3 Segment node and redo it. Skip this if the scene walks into new light on purpose.`, act: ["redo", r.segment] });
  }
  // one card per segment: a redo fixes every problem it has at once
  for (let k = out.length - 1; k > 0; k--) {
    const first = out.findIndex((p) => p.act?.[0] === "redo" && p.act[1] === out[k].act?.[1]);
    if (out[k].act?.[0] === "redo" && first > -1 && first < k) {
      out[first].text += "\n" + out[k].title + ": " + out[k].text;
      out[first].lvl = Math.max(out[first].lvl, out[k].lvl);
      out.splice(k, 1);
    }
  }
  const next = segs.find((s) => !s.done);
  if (next) out.push({ lvl: 0, title: `Next: segment ${next.index} (${next.mode.toLowerCase()})`, text: next.action.slice(0, 220) + (next.action.length > 220 ? "…" : ""), act: ["next", next.index] });
  else if (segs.length && d.full_outdated) out.push({ lvl: 0, title: "The joined video is out of date", text: "Segments changed after the last join. Run the workflow once more with LC H3 Assemble in it, or queue Assemble on its own.", act: null });
  else if (segs.length && !d.full) out.push({ lvl: 0, title: "All segments made", text: "Run LC H3 Assemble to join them into one video.", act: null });
  return out.sort((a, b) => b.lvl - a.lvl);
}

async function queueSegment(index, newSeed) {
  const segNode = nodesOf(SEGMENT)[0];
  if (!segNode) return "There is no LC H3 Segment node in this workflow.";
  const iw = widget(segNode, "index");
  const sw = widget(segNode, "seed");
  const redirect = nodesOf(REDIRECT)[0];
  const rw = widget(redirect, "index");
  const keep = iw?.value;
  if (iw) iw.value = index;
  if (rw) rw.value = index;
  if (newSeed && sw) sw.value = Math.floor(Math.random() * 2 ** 32);
  try {
    await app.queuePrompt(0, 1);
  } finally {
    // back to "next segment", so a plain Run afterwards doesn't redo this one again
    if (iw) iw.value = keep === undefined ? 0 : 0;
    if (rw) rw.value = 0;
    app.graph.setDirtyCanvas(true, true);
  }
  return "";
}

async function queueRemaining(count) {
  for (let k = 0; k < count; k++) {
    const err = await queueSegment(0, false);
    if (err) return err;
  }
  return "";
}

export function render(body, { toast, rerender, askChat }) {
  if (!st.data && !st.loading) {
    body.innerHTML = `<div class="va-hint">Loading the movie…</div>`;
    refresh(true).then(rerender);
    return;
  }
  const d = st.data;
  if (!d || d.error) {
    body.innerHTML = `<div class="va-hint">${esc(d?.error || "No movie project yet.")} Run LC Vision Director once to write the plan; it saves to output/LC_H3/&lt;project&gt;/.</div>`;
    return;
  }
  const segs = d.segments || [];
  const done = segs.filter((s) => s.done);
  const secs = done.reduce((t, s) => t + (s.frames || 0), 0) / 24;
  const probs = problems(d);
  const picker = (st.projects || []).length > 1 && !projectFromGraph()
    ? `<select class="va-input va-model" data-m="pick">${st.projects.map((p) => `<option${p.name === d.project ? " selected" : ""}>${esc(p.name)}</option>`).join("")}</select>` : "";
  const bust = Math.round(Date.now() / 5000);
  body.innerHTML = `
    <div class="va-row" style="border-top:0;padding-top:0"><div class="va-grow"><div class="va-name">🎬 ${esc(d.project)}</div>
      <div class="va-sub">${done.length} of ${segs.length} segments made · ${secs.toFixed(1)} s so far</div></div>${picker}
      <button class="va-dots" data-m="reload" title="Refresh">⟳</button></div>
    ${d.full ? `<video class="va-video" src="${view(d.full, bust)}" controls preload="metadata" style="width:100%;border-radius:8px;background:#000"></video>
      <div class="va-sub">${d.full_outdated ? "⚠️ Older than the latest segments. Join again to update it." : "The joined video."}</div>` : ""}
    <div class="va-group">Checkup</div>
    ${probs.length ? probs.map((p, k) => `<div class="va-card l${p.lvl}"><div class="va-name">${esc(p.title)}</div><div class="va-hint">${esc(p.text)}</div>
      ${p.act ? `<div class="va-actions"><button class="va-btn${p.lvl ? "" : " pri"}" data-p="${k}">${p.act[0] === "next" ? `Make segment ${p.act[1]}` : `Redo segment ${p.act[1]} (new seed)`}</button>
      ${p.act[0] === "next" && segs.length - done.length > 1 ? `<button class="va-btn" data-m="all">Make all ${segs.length - done.length} remaining</button>` : ""}</div>` : ""}</div>`).join("")
      : `<div class="va-hint">Nothing to fix. Every face, join and color check passed.</div>`}
    <div class="va-group">Segments</div>
    <div class="va-list">${segs.map((s) => `<div class="va-row" style="align-items:flex-start">
      ${s.done ? `<img src="/api/lc_vision/movie/thumb?project=${encodeURIComponent(d.project)}&i=${s.index}&t=${Math.round(s.modified || 0)}" style="width:96px;border-radius:6px;cursor:pointer" data-play="${s.index}" title="Play segment ${s.index}">`
        : `<div style="width:96px;height:54px;border-radius:6px;border:1px dashed var(--border-color);display:flex;align-items:center;justify-content:center" class="va-sub">not made</div>`}
      <div class="va-grow"><div><b>${s.index}</b> <span class="va-tag">${s.mode.toLowerCase()}</span>
        ${s.index === 1 && s.face ? `<span class="va-fit ok" title="Segment 1 is the face every other segment is compared to">face reference</span>` : ""}
        ${s.index > 1 && s.face ? `<span class="va-fit ${s.face.match >= d.face_same ? "ok" : s.face.match >= d.face_close ? "part" : "no"}" title="Face match to segment 1 (0 to 1)">face ${s.face.match.toFixed(2)} ${faceWord(s.face.match, d)}</span>` : ""}
        ${s.stale ? `<span class="va-fit no">out of line</span>` : ""}</div>
        <div class="va-sub" style="white-space:normal">${esc(s.action.slice(0, 140))}${s.action.length > 140 ? "…" : ""}</div>
        ${st.playing === String(s.index) ? `<video src="${view(segFile(s.index), Math.round(s.modified || 0))}" controls autoplay style="width:100%;border-radius:6px;margin-top:4px;background:#000"></video>` : ""}</div>
      ${s.done ? `<button class="va-dots" data-redo="${s.index}" title="Redo segment ${s.index} with a new seed">↻</button>` : ""}</div>`).join("")}</div>
    <button class="va-btn wide" data-m="ask" title="Open Chat with this project's numbers, to ask what to do">Ask about this movie</button>`;

  const act = async (fn) => {
    const err = await fn();
    if (err) toast("warn", "Movie", err);
    else toast("info", "Movie", "Queued. The checkup updates when it finishes.");
  };
  body.querySelectorAll("[data-p]").forEach((b) => (b.onclick = () => {
    const [kind, i] = probs[+b.dataset.p].act;
    act(() => queueSegment(i, kind === "redo"));
  }));
  body.querySelectorAll("[data-redo]").forEach((b) => (b.onclick = () => act(() => queueSegment(+b.dataset.redo, true))));
  body.querySelectorAll("[data-play]").forEach((im) => (im.onclick = () => {
    st.playing = st.playing === im.dataset.play ? "" : im.dataset.play;
    rerender();
  }));
  const all = body.querySelector('[data-m="all"]');
  if (all) all.onclick = () => act(() => queueRemaining(segs.length - done.length));
  body.querySelector('[data-m="reload"]').onclick = () => refresh(true).then(rerender);
  const pick = body.querySelector('[data-m="pick"]');
  if (pick) pick.onchange = () => {
    st.project = pick.value;
    st.data = null;
    refresh(false).then(rerender);
  };
  body.querySelector('[data-m="ask"]').onclick = () => askChat(summary(d));
}

/** The project in plain numbers, for the chat to reason about. */
function summary(d) {
  const lines = [`H3 long-video project "${d.project}": ${(d.segments || []).length} segments of ${d.segment_s?.toFixed?.(2)} s, ${d.overlap_s?.toFixed?.(2)} s overlap.`];
  for (const s of d.segments || []) {
    lines.push(`Segment ${s.index} (${s.mode}): ${s.done ? `made, seed ${s.seed}${s.face ? `, face match ${s.face.match}` : ""}${s.stale ? ", out of line with the segment before" : ""}` : "not made"}. Plan: ${s.action.slice(0, 160)}`);
  }
  for (const j of d.report?.joins || []) if (j.mode === "CONTINUE") lines.push(`Join into segment ${j.segment}: ${j.jump}x normal motion${j.flag ? " (flagged)" : ""}.`);
  for (const r of d.report?.drift || []) lines.push(`Color shift in segment ${r.segment}: ${r.delta_e}${r.flag ? " (flagged)" : ""}.`);
  return lines.join("\n");
}

/** Keep the tab current: a finished run may have saved a segment or a joined video. */
export function watch(onChange) {
  const bump = () => refresh(false).then(() => {
    const sig = JSON.stringify(st.data?.segments?.map((s) => [s.done, s.modified, s.stale]) || []) + (st.data?.full_outdated ? 1 : 0) + (st.data?.full || "");
    if (sig !== st.sig) {
      st.sig = sig;
      onChange();
    }
  });
  api.addEventListener("execution_success", bump);
  api.addEventListener("execution_error", bump);
}

export function reset() {
  st.data = null;
}
