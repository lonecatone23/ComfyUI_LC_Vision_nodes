// The "?" menu: how to use each part, FAQ and tips.
const S = (title, body, open = false) => `<details class="va-hs"${open ? " open" : ""}><summary>${title}</summary>${body}</details>`;
const UL = (items) => `<ul>${items.map((i) => `<li>${i}</li>`).join("")}</ul>`;

export const HELP_HTML = [
  S("📸 Snapshots", UL([
    "Set the workflow up the way you like it (model, LoRAs, steps, bypassed nodes), then click <b>Save snapshot</b>.",
    "Tick what goes in. Prompts, seeds and input images are left out unless you tick them.",
    "<b>Apply</b> puts those settings back. <b>Undo</b> puts back what was there before.",
    "The <b>⋯</b> menu: update with current values, rename, add to library, delete.",
    "Snapshots are saved inside the workflow, so they travel with it.",
  ])),
  S("📚 Library", UL([
    "Snapshots for <b>any</b> workflow, saved in your user folder.",
    "Nodes are matched by type. When a workflow has two of the same node, it asks which one.",
    "Anything it can't place is listed as skipped. Nothing gets guessed.",
  ])),
  S("🩺 Checkup", UL([
    "Sits at the top of the Chat tab and runs by itself. A <b>red dot</b> on the icon means it found a problem.",
    "It catches:<ul><li>missing packs (with the pack page)</li><li>missing models (with a download link or a search)</li><li>files sitting in a subfolder</li><li>the wrong text encoder</li><li>a model format your card can't run well</li><li>errors from the last run, in plain words</li></ul>",
    "<b>Show node</b> makes the node glow. Fix buttons do the one-click fixes.",
    "Hit <b>Check again</b> after you install or download something.",
  ])),
  S("💬 Chat", UL([
    "Ask in plain words: \"What's broken?\", \"Where do I put my image?\", \"Set steps to 30\", \"Turn off the upscaler\".",
    "Select a node and ask <b>\"How does this work?\"</b> It reads that node's own help.",
    "Changes show as a list with <b>Yes, do it</b> / <b>No</b>. Undo is right under it.",
    "\"Where is...\" questions just happen: the nodes glow and the view jumps to them.",
    "The buttons under an answer are quick replies. Click one to ask it.",
  ])),
  S("🧭 Guided tours", UL([
    "Ask <b>\"Explain this workflow\"</b>, then hit <b>▶ Guided tour</b>. Back / Next, the arrow keys or a click on any step. Esc stops it.",
    "Authors: <b>Snapshots > Guided tour > Save to workflow</b> ships the tour inside the file. Saved tours are locked and play on any card.",
    "<b>To edit:</b> right-click the tour, <b>🔓 Unlock to edit</b>, right-click again, <b>Edit tour…</b>",
    "<b>+ Add a setting…</b> marks one more setting on a step. <b>×</b> removes a marker. Up to 8 per step.",
    "💡 To mark a node outside the step, select it on the canvas first. It shows at the top under <b>Selected on the canvas</b>.",
    "<b>Add a step</b> (at the bottom): pick a group (or your selected nodes) and where it goes, then <b>+ Add step</b>. <b>↑ ↓</b> move a step, <b>×</b> removes it.",
    "<b>Save</b> locks the tour again. Save the workflow to keep it.",
  ])),
  S("❓ FAQ", UL([
    "<b>The chat says there's no model.</b> The checkup works without one. For the chat, <b>LC Settings ⚙️ > Vision</b> downloads one.",
    "<b>It says it can't fix something.</b> Packs and models have to be installed or downloaded by you. It tells you what and where.",
    "<b>The first answer is slow.</b> It loads the model first (a few seconds). After that, answers take a few seconds.",
    "<b>How much VRAM does it use?</b> None until you ask the chat something. Then the chat model loads: about 10 GB for the 8B (20 GB+ cards), 7 GB on 16 GB cards, 5 GB on 12 GB, 3.5 GB on 8 GB. The checkup, snapshots, library and playing a saved tour never use VRAM.",
    "<b>Does it take VRAM while I render?</b> No. The chat model unloads when you queue, a minute after the last answer, or with <b>Free VRAM</b>.",
    "<b>Smaller card?</b> Leave <b>LC Settings ⚙️ > Vision > Chat model</b> on <b>Auto</b>: it picks the biggest model that fits. Under 8 GB it chats on the <b>CPU</b> instead: under 1 GB of VRAM, 10 to 30 seconds an answer. <b>Off</b> never loads a chat model.",
    "<b>Why can't I build a tour?</b> Building one needs a 20 GB+ card: the 8B model with a long 16k reply, about 11 GB. On a smaller card a bigger model download (9B etc.) won't unlock it. Any computer can make one by hand: Snapshots tab, <b>✚ Create tour</b>. A tour saved in the workflow plays on any card, no VRAM needed.",
    "<b>It got something wrong.</b> Say so, or click <b>Clear</b> and ask again. It never changes anything without your yes.",
    "<b>It's talking about the wrong workflow.</b> Click <b>Check again</b>. It follows tab switches by itself.",
    "<b>Can I turn it off?</b> LC Settings ⚙️ > Vision > Vision Assistant.",
  ])),
  S("💡 Tips", UL([
    "Save one snapshot per model (Krea 2, Anima, SDXL...) and switch the whole workflow in one click.",
    "Opened someone else's workflow? Ask \"What is broken?\" and then \"Can you fix it?\"",
    "Library snapshots are great for your go-to looks: sampler, steps, LoRA strength, detailers on or off.",
  ])),
].join("");

export const HELP_CSS = `
.va-tabs{align-items:center}
.va-help{margin-left:auto;width:22px;height:22px;border-radius:50%;border:1px solid var(--border-color);background:none;color:var(--descrip-text,#999);cursor:pointer;font-size:12px;font-weight:700;line-height:1;padding:0}
.va-help:hover,.va-help.on{color:var(--fg-color);background:var(--comfy-input-bg)}
.va{position:relative}
.va-helpbox{position:absolute;left:8px;right:8px;top:84px;z-index:20;max-height:calc(100% - 96px);overflow:auto;background:var(--comfy-menu-bg);border:1px solid var(--border-color);border-radius:10px;padding:8px 10px;box-shadow:0 8px 24px rgba(0,0,0,.4);font-size:12.5px;line-height:1.5}
.va-helpbox .va-hhead{display:flex;align-items:center;justify-content:space-between;font-weight:600;margin-bottom:4px}
.va-hs{border-top:1px solid var(--border-color);padding:5px 0}
.va-hs:first-of-type{border-top:0}
.va-hs summary{cursor:pointer;font-weight:600;list-style:none}
.va-hs summary::-webkit-details-marker{display:none}
.va-hs summary::before{content:"▸ ";color:var(--descrip-text,#999)}
.va-hs[open] summary::before{content:"▾ "}
.va-hs ul{margin:4px 0 2px 16px;padding:0}
.va-hs li{margin:2px 0}
`;
