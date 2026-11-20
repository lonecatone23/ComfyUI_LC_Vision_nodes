// LC Image with Prompt: a viewer with the picture on the left and its prompt on the right. Click the prompt to copy it.
// Opens on a double click on the node or with the 🔍 button. Arrows step through, Esc closes.
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE = "LCVisionImageWithPrompt";

const css = `
.lc-iwp{position:fixed;inset:0;z-index:10000;background:rgba(10,10,12,.92);display:flex;flex-direction:column;
  font-family:system-ui,sans-serif;color:#e8e8ee}
.lc-iwp-main{flex:1;display:flex;gap:16px;padding:16px 16px 8px;min-height:0}
.lc-iwp-pic{flex:1;display:flex;align-items:center;justify-content:center;min-width:0;position:relative}
.lc-iwp-pic img{max-width:100%;max-height:100%;object-fit:contain;border-radius:6px}
.lc-iwp-side{width:min(420px,38vw);display:flex;flex-direction:column;gap:8px;min-height:0}
.lc-iwp-head{display:flex;justify-content:space-between;align-items:center;font-size:13px;color:#a8a8b4}
.lc-iwp-text{flex:1;overflow:auto;background:#1c1c22;border:1px solid #33333d;border-radius:8px;padding:14px;
  font-size:14px;line-height:1.5;white-space:pre-wrap;cursor:copy;user-select:text}
.lc-iwp-text:hover{border-color:#6a6a7a}
.lc-iwp-text.copied{border-color:#5ac26e}
.lc-iwp-btn{background:#2a2a32;border:1px solid #3a3a46;color:#e8e8ee;border-radius:6px;padding:4px 10px;cursor:pointer}
.lc-iwp-btn:hover{background:#383842}
.lc-iwp-nav{position:absolute;top:50%;transform:translateY(-50%);font-size:28px;padding:8px 14px}
.lc-iwp-strip{display:flex;gap:6px;padding:8px 16px 14px;overflow-x:auto}
.lc-iwp-strip img{height:64px;border-radius:4px;opacity:.55;cursor:pointer;border:2px solid transparent}
.lc-iwp-strip img.on{opacity:1;border-color:#e8e8ee}
@media (max-width:760px){.lc-iwp-main{flex-direction:column}.lc-iwp-side{width:auto;height:40%}}
`;

function urlFor(img) {
  const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder || "", type: img.type || "temp" });
  return api.apiURL(`/view?${q}`);
}

function openViewer(node, start = 0) {
  const imgs = node._lcIwpImages || [];
  const texts = node._lcIwpPrompts || [];
  if (!imgs.length) {
    app.extensionManager?.toast?.add?.({ severity: "info", summary: "Image with Prompt", detail: "Run the workflow first.", life: 2500 });
    return;
  }
  if (!document.getElementById("lc-iwp-css")) {
    const st = document.createElement("style");
    st.id = "lc-iwp-css";
    st.textContent = css;
    document.head.appendChild(st);
  }
  let at = Math.max(0, Math.min(start, imgs.length - 1));
  const root = document.createElement("div");
  root.className = "lc-iwp";
  root.innerHTML = `<div class="lc-iwp-main"><div class="lc-iwp-pic"><img alt=""></div>
    <div class="lc-iwp-side"><div class="lc-iwp-head"><span class="lc-iwp-count"></span>
    <span><button class="lc-iwp-btn lc-iwp-copy">📋 Copy</button> <button class="lc-iwp-btn lc-iwp-close">✕</button></span></div>
    <div class="lc-iwp-text" title="Click to copy"></div></div></div><div class="lc-iwp-strip"></div>`;
  const pic = root.querySelector(".lc-iwp-pic img");
  const text = root.querySelector(".lc-iwp-text");
  const count = root.querySelector(".lc-iwp-count");
  const strip = root.querySelector(".lc-iwp-strip");
  if (imgs.length > 1) {
    for (const [cls, step, label] of [["left:4px", -1, "‹"], ["right:4px", 1, "›"]]) {
      const b = document.createElement("button");
      b.className = "lc-iwp-btn lc-iwp-nav";
      b.style.cssText = cls;
      b.textContent = label;
      b.onclick = () => show(at + step);
      root.querySelector(".lc-iwp-pic").appendChild(b);
    }
  }
  const thumbs = imgs.map((im, i) => {
    const t = document.createElement("img");
    t.src = urlFor(im);
    t.onclick = () => show(i);
    if (imgs.length > 1) strip.appendChild(t);
    return t;
  });

  function show(i) {
    at = (i + imgs.length) % imgs.length;
    pic.src = urlFor(imgs[at]);
    text.textContent = texts[at] ?? texts[texts.length - 1] ?? "";
    text.classList.remove("copied");
    count.textContent = imgs.length > 1 ? `${at + 1} / ${imgs.length}` : "";
    thumbs.forEach((t, k) => t.classList.toggle("on", k === at));
    thumbs[at]?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }

  async function copy() {
    const s = text.textContent;
    try {
      await navigator.clipboard.writeText(s);
    } catch (_) {
      const ta = document.createElement("textarea");
      ta.value = s;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    text.classList.add("copied");
    const b = root.querySelector(".lc-iwp-copy");
    b.textContent = "✓ Copied";
    setTimeout(() => (b.textContent = "📋 Copy"), 1400);
  }

  function close() {
    document.removeEventListener("keydown", onKey, true);
    root.remove();
  }

  function onKey(e) {
    if (e.key === "Escape") close();
    else if (e.key === "ArrowLeft") show(at - 1);
    else if (e.key === "ArrowRight") show(at + 1);
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  text.onclick = () => {
    if (!window.getSelection()?.toString()) copy(); // selecting part of it copies only that, the browser way
  };
  root.querySelector(".lc-iwp-copy").onclick = copy;
  root.querySelector(".lc-iwp-close").onclick = close;
  root.addEventListener("mousedown", (e) => {
    if (e.target === root || e.target.classList.contains("lc-iwp-pic")) close();
  });
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(root);
  show(at);
}

app.registerExtension({
  name: "LC.Vision.ImageWithPrompt",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE) return;
    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);
      const b = this.addWidget("button", "🔍 View with prompt", null, () => openViewer(this, this.imageIndex ?? 0));
      b.serialize = false;
      if (b.options) b.options.serialize = false;
      return r;
    };
    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      onExecuted?.apply(this, arguments);
      this._lcIwpImages = message?.images || [];
      this._lcIwpPrompts = message?.lc_image_prompts || [];
    };
    const onDblClick = nodeType.prototype.onDblClick;
    nodeType.prototype.onDblClick = function (e, pos) {
      const r = onDblClick?.apply(this, arguments);
      if (pos && pos[1] > 0) openViewer(this, this.imageIndex ?? 0); // the title bar keeps its own double click
      return r;
    };
  },
});
