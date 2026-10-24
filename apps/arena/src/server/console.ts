import { HOLDOUT_APP, HOLDOUT_DISPLAY_NAME } from "../holdout/meta";
import { BRANDS } from "./ui";
import { APP_NAMES, CLASSIC_APPS, SAVE_BUTTON_RENAMES } from "./variations";

/**
 * Judge console: a static page whose inline script calls the admin API. All dynamic values are
 * written with textContent (mismatch values can contain agent-written note text). The app list,
 * display names, and rename-save pairs are injected as JSON so the page covers every app.
 * Note: the template string must not contain backticks or "${" sequences.
 */
const TEMPLATE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Overclock Arena · Judge console</title>
<link rel="icon" href="data:,">
<style>
:root{--bg:#070a12;--bg2:#0c111d;--panel:#111827cc;--panel-solid:#111827;--line:#1f2a3d;--line2:#2a3850;--fg:#e6eaf2;--muted:#8a94a8;--dim:#5d677b;
--cyan:#22d3ee;--violet:#a78bfa;--green:#34d399;--amber:#fbbf24;--red:#f87171;--crm:#2dd4bf;--orders:#fb923c;--support:#a78bfa;--app4:#60a5fa;
--mono:"JetBrains Mono","SF Mono",Menlo,Consolas,monospace;--sans:"Inter","Segoe UI",system-ui,-apple-system,sans-serif}
*{box-sizing:border-box}
[hidden]{display:none!important}
html,body{margin:0;background:var(--bg);color:var(--fg);font-family:var(--sans);font-size:14px;line-height:1.45}
body{background:radial-gradient(1200px 600px at 10% -10%,rgba(34,211,238,.10),transparent 60%),radial-gradient(900px 500px at 100% 0,rgba(167,139,250,.10),transparent 60%),var(--bg);min-height:100vh}
a{color:var(--cyan)}
button{font:inherit;cursor:pointer;color:var(--fg);background:#18223a;border:1px solid var(--line2);border-radius:8px;padding:.5em .95em;font-weight:600;transition:background .15s,border-color .15s,transform .05s}
button:hover{background:#1f2c4a;border-color:#3b4d6e}
button:active{transform:translateY(1px)}
button:disabled{opacity:.5;cursor:default}
button.primary{background:linear-gradient(135deg,#0891b2,#7c3aed);border-color:transparent;color:#fff}
button.primary:hover{filter:brightness(1.1)}
button.danger{background:#3a1520;border-color:#7f1d1d;color:#fecaca}
button.ghost{background:transparent}
input,select,textarea{font:inherit;color:var(--fg);background:#0b1220;border:1px solid var(--line2);border-radius:8px;padding:.5em .65em}
input:focus,select:focus,textarea:focus,button:focus-visible{outline:2px solid var(--cyan);outline-offset:1px}
label{font-size:.78em;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;font-weight:700;display:block;margin-bottom:.3em}
header.top{display:flex;align-items:center;gap:1.2em;padding:1em 1.6em;border-bottom:1px solid var(--line);background:rgba(7,10,18,.75);backdrop-filter:blur(8px);position:sticky;top:0;z-index:5}
.logo{display:flex;align-items:center;gap:.65em;font-weight:800;font-size:1.15em;letter-spacing:-.01em}
.logo-mark{width:30px;height:30px;border-radius:9px;background:conic-gradient(from 210deg,#22d3ee,#a78bfa,#f472b6,#22d3ee);box-shadow:0 0 24px rgba(34,211,238,.35)}
.logo small{display:block;font-size:.62em;color:var(--muted);font-weight:600;letter-spacing:.12em;text-transform:uppercase}
.live{display:flex;align-items:center;gap:.45em;font-size:.8em;color:var(--muted);font-weight:600}
.dot{width:9px;height:9px;border-radius:50%;background:var(--green);box-shadow:0 0 0 0 rgba(52,211,153,.6);animation:pulse 1.6s infinite}
.dot.bad{background:var(--red);animation:none}
@keyframes pulse{0%{box-shadow:0 0 0 0 rgba(52,211,153,.55)}70%{box-shadow:0 0 0 9px rgba(52,211,153,0)}100%{box-shadow:0 0 0 0 rgba(52,211,153,0)}}
.scn-chip{font-family:var(--mono);font-size:.82em;padding:.3em .7em;border:1px solid var(--line2);border-radius:999px;color:var(--fg);background:#0b1220}
.top-links{margin-left:auto;display:flex;gap:.5em}
.top-links a{font-size:.85em;text-decoration:none;padding:.35em .75em;border-radius:999px;border:1px solid var(--line2);color:var(--fg)}
.top-links a:hover{border-color:var(--cyan)}
main{padding:1.4em 1.6em 3em;max-width:1500px;margin:0 auto;display:grid;gap:1.2em;grid-template-columns:repeat(12,minmax(0,1fr))}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:1.1em 1.2em;box-shadow:0 10px 30px rgba(0,0,0,.25)}
.panel h2{margin:0 0 .9em;font-size:.8em;text-transform:uppercase;letter-spacing:.14em;color:var(--muted);font-weight:800;display:flex;align-items:center;gap:.6em}
.panel h2 .hint{margin-left:auto;text-transform:none;letter-spacing:0;font-weight:500;color:var(--dim)}
.span-4{grid-column:span 4}.span-5{grid-column:span 5}.span-7{grid-column:span 7}.span-8{grid-column:span 8}.span-12{grid-column:span 12}.span-6{grid-column:span 6}
@media (max-width:1100px){.span-4,.span-5,.span-7,.span-8,.span-6{grid-column:span 12}}
.app-card{position:relative;overflow:hidden}
.app-card::before{content:"";position:absolute;inset:0 0 auto 0;height:3px;background:var(--accent)}
.app-head{display:flex;align-items:baseline;gap:.6em;margin-bottom:.6em}
.app-name{font-weight:800;font-size:1.05em}
.app-origin{font-family:var(--mono);font-size:.78em;color:var(--dim);margin-left:auto}
.rps{display:flex;align-items:flex-end;gap:.8em;margin:.2em 0 .7em}
.rps-num{font-size:2.3em;font-weight:800;font-variant-numeric:tabular-nums;line-height:1}
.rps-unit{color:var(--muted);font-size:.8em;margin-bottom:.35em}
.spark{flex:1;height:44px}
.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:.5em}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(17rem,1fr));gap:1.2em}
.metric{background:#0b1220;border:1px solid var(--line);border-radius:10px;padding:.5em .6em}
.metric .k{font-size:.68em;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;font-weight:700}
.metric .v{font-size:1.25em;font-weight:800;font-variant-numeric:tabular-nums}
.metric.warn .v{color:var(--amber)}.metric.bad .v{color:var(--red)}.metric.good .v{color:var(--green)}
.bar{height:5px;background:#1a2438;border-radius:99px;margin-top:.35em;overflow:hidden}
.bar > i{display:block;height:100%;width:0;background:var(--accent);transition:width .3s}
.chips{display:flex;flex-wrap:wrap;gap:.35em;margin-top:.7em;min-height:1.6em}
.chip{font-size:.72em;font-weight:700;padding:.2em .6em;border-radius:999px;background:rgba(251,191,36,.12);color:var(--amber);border:1px solid rgba(251,191,36,.35)}
.chip.none{background:transparent;color:var(--dim);border-color:var(--line)}
.kv{display:grid;grid-template-columns:max-content 1fr;gap:.35em 1em;font-size:.92em}
.kv dt{color:var(--muted)}.kv dd{margin:0;font-family:var(--mono);overflow-wrap:anywhere}
.form-row{display:flex;gap:.7em;align-items:flex-end;flex-wrap:wrap;margin-top:1em}
.form-row > div{display:flex;flex-direction:column}
.form-row input{width:7.5em}
.goal{white-space:pre-wrap;font-size:.82em;color:var(--muted);background:#0b1220;border:1px solid var(--line);border-radius:10px;padding:.7em .8em;max-height:9.5em;overflow:auto;margin-top:.9em}
.acc-wrap{display:flex;align-items:center;gap:1.4em}
.ring{width:132px;height:132px;flex:none}
.acc-num{font-size:2.6em;font-weight:900;font-variant-numeric:tabular-nums;line-height:1}
.acc-sub{color:var(--muted);margin-top:.2em}
.acc-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:.5em;flex:1}
table{width:100%;border-collapse:collapse;font-size:.85em}
th,td{text-align:left;padding:.45em .6em;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--muted);font-size:.72em;text-transform:uppercase;letter-spacing:.08em;font-weight:800}
td{font-family:var(--mono);overflow-wrap:anywhere}
td.exp{color:var(--green)}td.act{color:var(--red)}
.table-scroll{max-height:300px;overflow:auto;margin-top:.9em;border:1px solid var(--line);border-radius:10px}
.empty{color:var(--dim);padding:1em;text-align:center;font-family:var(--sans)}
.matrix{display:grid;grid-template-columns:minmax(14em,1.4fr) repeat(4,minmax(6.5em,1fr));gap:.45em;align-items:stretch}
.matrix .hdr{font-size:.72em;color:var(--muted);text-transform:uppercase;letter-spacing:.1em;font-weight:800;padding:.3em .2em;text-align:center}
.matrix .hdr:first-child{text-align:left}
.kind{padding:.45em .2em}
.kind b{display:block}
.kind span{font-size:.8em;color:var(--dim)}
.cell{border-radius:9px;font-size:.82em}
.cell.on{background:rgba(251,191,36,.14);border-color:rgba(251,191,36,.55);color:var(--amber)}
.cell:not(.on):hover{border-color:var(--cyan)}
.big-actions{display:flex;gap:.7em;flex-wrap:wrap;margin-top:1.1em;align-items:center}
.result{font-family:var(--mono);font-size:.82em;color:var(--muted)}
textarea.json{width:100%;min-height:320px;font-family:var(--mono);font-size:.82em;line-height:1.5;resize:vertical;tab-size:2}
.err{color:var(--red);font-size:.85em;white-space:pre-wrap;font-family:var(--mono);margin-top:.5em}
.ok{color:var(--green)}
.log{list-style:none;margin:0;padding:0;max-height:360px;overflow:auto;font-size:.84em}
.log li{display:flex;gap:.7em;padding:.45em .2em;border-bottom:1px solid var(--line)}
.log time{font-family:var(--mono);color:var(--dim);flex:none}
.log .tag{font-weight:800;font-size:.72em;text-transform:uppercase;letter-spacing:.08em;padding:.15em .5em;border-radius:6px;background:#18223a;color:var(--cyan);flex:none;align-self:flex-start}
.log .tag.warn{color:var(--amber)}.log .tag.bad{color:var(--red)}
.toggle{display:flex;align-items:center;gap:.45em;font-size:.85em;color:var(--muted);text-transform:none;letter-spacing:0;font-weight:600;margin:0}
</style>
</head>
<body>
<header class="top">
  <div class="logo"><div class="logo-mark" aria-hidden="true"></div><div>Overclock Arena<small>Judge console</small></div></div>
  <div class="live"><span class="dot" id="live-dot"></span><span id="live-text">Connecting…</span></div>
  <span class="scn-chip" id="scn-chip">no scenario</span>
  <nav class="top-links" id="top-links" aria-label="Apps"></nav>
</header>
<main>
  <div class="span-12 cards" id="cards"></div>

  <section class="panel span-5" aria-labelledby="h-scn">
    <h2 id="h-scn">Scenario<span class="hint" id="scn-loaded"></span></h2>
    <dl class="kv" id="scn-kv"></dl>
    <div class="goal" id="scn-goal" hidden></div>
    <form class="form-row" id="load-form">
      <div><label for="f-seed">Seed</label><input id="f-seed" type="number" min="0" value="4242"></div>
      <div><label for="f-template">Template</label><select id="f-template">
        <option value="t1-order-reconcile">T1 · Order reconcile</option>
        <option value="t2-ticket-triage">T2 · Ticket triage</option>
        <option value="t3-crm-status-sync">T3 · CRM status sync (holdout)</option>
        <option value="t4-holdout">T4 · Fourth app (holdout)</option>
      </select></div>
      <div><label for="f-records">Records</label><input id="f-records" type="number" min="1" max="500" value="100"></div>
      <button type="submit" class="primary">Load scenario</button>
      <button type="button" id="btn-reset" class="danger">Reset to snapshot</button>
    </form>
  </section>

  <section class="panel span-7" aria-labelledby="h-check">
    <h2 id="h-check">Ground-truth check<span class="hint"><label class="toggle"><input type="checkbox" id="auto-check"> Auto-check every 3 s</label></span></h2>
    <div class="acc-wrap">
      <svg class="ring" viewBox="0 0 120 120" aria-hidden="true"><circle cx="60" cy="60" r="50" fill="none" stroke="#1a2438" stroke-width="12"/><circle id="ring-arc" cx="60" cy="60" r="50" fill="none" stroke="url(#rg)" stroke-width="12" stroke-linecap="round" stroke-dasharray="0 999" transform="rotate(-90 60 60)"/><defs><linearGradient id="rg" x1="0" x2="1"><stop offset="0" stop-color="#22d3ee"/><stop offset="1" stop-color="#a78bfa"/></linearGradient></defs></svg>
      <div><div class="acc-num" id="acc-num">—</div><div class="acc-sub" id="acc-sub">Run a check to compare the apps against ground truth.</div>
        <div class="big-actions" style="margin-top:.8em"><button type="button" class="primary" id="btn-check">Check now</button><span class="result" id="check-time"></span></div></div>
      <div class="acc-stats">
        <div class="metric"><div class="k">Correct</div><div class="v" id="c-correct">—</div></div>
        <div class="metric"><div class="k">Duplicates</div><div class="v" id="c-dup">—</div></div>
        <div class="metric"><div class="k">Collateral</div><div class="v" id="c-coll">—</div></div>
        <div class="metric"><div class="k">Escalations</div><div class="v" id="c-esc">—</div></div>
        <div class="metric"><div class="k">Need change</div><div class="v" id="e-need">—</div></div>
        <div class="metric"><div class="k">Notes expected</div><div class="v" id="e-notes">—</div></div>
        <div class="metric"><div class="k">Mismatches</div><div class="v" id="c-mis">—</div></div>
        <div class="metric"><div class="k">Records</div><div class="v" id="e-records">—</div></div>
      </div>
    </div>
    <div class="table-scroll"><table><thead><tr><th>Record</th><th>Entity</th><th>Field</th><th>Expected</th><th>Actual</th></tr></thead><tbody id="mis-body"><tr><td colspan="5" class="empty">No check run yet.</td></tr></tbody></table></div>
  </section>

  <section class="panel span-8" aria-labelledby="h-surprise">
    <h2 id="h-surprise">Surprises<span class="hint">Click to switch on; click a lit cell to switch it off.</span></h2>
    <div class="matrix" id="matrix"></div>
    <div class="big-actions">
      <button type="button" class="primary" id="btn-edit-unprocessed">Edit an unprocessed record</button>
      <button type="button" class="danger" id="btn-clear">Clear all surprises</button>
      <span class="result" id="surprise-result"></span>
    </div>
  </section>

  <section class="panel span-4" aria-labelledby="h-log">
    <h2 id="h-log">Activity</h2>
    <ul class="log" id="log"></ul>
  </section>

  <section class="panel span-12" aria-labelledby="h-json">
    <h2 id="h-json">Variation config<span class="hint" id="json-state">in sync</span></h2>
    <textarea class="json" id="json" spellcheck="false" aria-label="Variation config JSON"></textarea>
    <div class="big-actions">
      <button type="button" class="primary" id="btn-json-apply">Apply config</button>
      <button type="button" id="btn-json-reload">Reload from server</button>
      <button type="button" id="btn-json-format">Format</button>
      <span class="result" id="json-result"></span>
    </div>
    <div class="err" id="json-err" hidden></div>
  </section>
</main>
<script type="application/json" id="arena-meta">__ARENA_META__</script>
<script>
(function(){
"use strict";
var META = JSON.parse(document.getElementById("arena-meta").textContent);
var APPS = META.apps;
var NAMES = META.names;
var SAVE = META.save;
var ACCENTS = META.accents;
var KINDS = [
  { kind: "rename-save", title: "Rename save buttons", desc: "Save changes → Update record, …" },
  { kind: "confirm-modal", title: "Confirmation modal", desc: "Edits need a Confirm click" },
  { kind: "announcement", title: "Announcement overlay", desc: "Blocking “What's new” dialog" },
  { kind: "fields-in-tab", title: "Fields in tab", desc: "Status controls behind a tab" },
  { kind: "shuffle-fields", title: "Shuffle fields", desc: "Edit form order changes" },
  { kind: "latency", title: "Latency", desc: "250–500 ms, 10% slow (+2 s)" },
  { kind: "partial-failure", title: "Partial failures", desc: "10% 503 before / 10% 500 after commit" },
  { kind: "concurrency-limit", title: "Concurrency limit", desc: "429 above 6 in flight" }
];
var OFF_PATCH = {
  "rename-save": function(app){ var p = {}; p[SAVE[app][0]] = null; return { renameButtons: obj(app, p) }; },
  "confirm-modal": function(app){ return { confirmModal: obj(app, null) }; },
  "announcement": function(app){ return { announcementModal: obj(app, null) }; },
  "fields-in-tab": function(app){ return { editInTab: obj(app, null) }; },
  "shuffle-fields": function(app){ return { shuffleFields: obj(app, null) }; },
  "latency": function(app){ return { latency: obj(app, null) }; },
  "partial-failure": function(app){ return { failures: obj(app, null) }; },
  "concurrency-limit": function(app){ return { concurrencyLimit: obj(app, null) }; }
};
function obj(k, v){ var o = {}; o[k] = v; return o; }
function $(id){ return document.getElementById(id); }
function el(tag, attrs, kids){
  var e = document.createElement(tag);
  if (attrs) for (var k in attrs) { if (k === "text") e.textContent = attrs[k]; else if (k === "cls") e.className = attrs[k]; else e.setAttribute(k, attrs[k]); }
  (kids || []).forEach(function(c){ e.appendChild(typeof c === "string" ? document.createTextNode(c) : c); });
  return e;
}
function fmt(v){ if (v === null || v === undefined) return ""; return typeof v === "string" ? v : JSON.stringify(v); }
function api(method, path, body){
  var init = { method: method, headers: {} };
  if (body !== undefined) { init.headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
  return fetch(path, init).then(function(r){
    return r.text().then(function(t){
      var data = null; try { data = t ? JSON.parse(t) : null; } catch (e) { data = { error: t }; }
      if (!r.ok) { var err = new Error((data && data.error) || ("HTTP " + r.status)); err.status = r.status; err.data = data; throw err; }
      return data;
    });
  });
}
function log(tag, text, tone){
  var li = el("li", null, [el("time", { text: new Date().toLocaleTimeString([], { hour12: false }) }), el("span", { cls: "tag" + (tone ? " " + tone : ""), text: tag }), el("span", { text: text })]);
  var ul = $("log"); ul.insertBefore(li, ul.firstChild);
  while (ul.children.length > 80) ul.removeChild(ul.lastChild);
}

// ---------- App cards
var cards = {}, history = {}, last = {};
APPS.forEach(function(app){
  var root = el("section", { cls: "panel app-card", "data-card": app, style: "--accent:var(" + ACCENTS[app] + ")" });
  $("cards").appendChild(root);
  var origin = el("a", { cls: "app-origin", href: "#", target: "_blank", rel: "noopener", text: "" });
  var rpsNum = el("div", { cls: "rps-num", text: "0" });
  var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "spark"); svg.setAttribute("viewBox", "0 0 120 44"); svg.setAttribute("preserveAspectRatio", "none"); svg.setAttribute("aria-hidden", "true");
  var area = document.createElementNS("http://www.w3.org/2000/svg", "path"); area.setAttribute("fill", "var(--accent)"); area.setAttribute("opacity", ".15");
  var line = document.createElementNS("http://www.w3.org/2000/svg", "path"); line.setAttribute("fill", "none"); line.setAttribute("stroke", "var(--accent)"); line.setAttribute("stroke-width", "1.6");
  svg.appendChild(area); svg.appendChild(line);
  function metric(k, cls){ var v = el("div", { cls: "v", text: "0" }); var m = el("div", { cls: "metric" + (cls ? " " + cls : "") }, [el("div", { cls: "k", text: k }), v]); return { root: m, v: v }; }
  var m = {
    inflight: metric("In flight"), max: metric("Peak"), writes: metric("Writes", "good"), requests: metric("Requests"),
    t429: metric("429s", "warn"), c409: metric("409s", "warn"), b503: metric("503 inj.", "bad"), a500: metric("500 inj.", "bad"), d403: metric("Denied 403", "warn")
  };
  var bar = el("div", { cls: "bar" }, [el("i")]);
  m.inflight.root.appendChild(bar);
  var chips = el("div", { cls: "chips" });
  root.appendChild(el("div", { cls: "app-head" }, [el("span", { cls: "app-name", text: NAMES[app] }), origin]));
  root.appendChild(el("div", { cls: "rps" }, [el("div", null, [rpsNum, el("div", { cls: "rps-unit", text: "requests / s" })]), svg]));
  root.appendChild(el("div", { cls: "metrics" }, [m.inflight.root, m.max.root, m.writes.root, m.requests.root, m.t429.root, m.c409.root, m.b503.root, m.a500.root, m.d403.root]));
  root.appendChild(chips);
  cards[app] = { origin: origin, rps: rpsNum, area: area, line: line, m: m, bar: bar.firstChild, chips: chips };
  history[app] = [];
});
function drawSpark(app){
  var h = history[app], c = cards[app];
  var max = Math.max(1, Math.max.apply(null, h.concat([0])));
  var n = 60, pts = [];
  for (var i = 0; i < h.length; i++) { var x = (n - h.length + i) * (120 / (n - 1)); var y = 42 - (h[i] / max) * 38; pts.push(x.toFixed(1) + "," + y.toFixed(1)); }
  if (!pts.length) { c.line.setAttribute("d", ""); c.area.setAttribute("d", ""); return; }
  c.line.setAttribute("d", "M" + pts.join(" L"));
  c.area.setAttribute("d", "M" + pts[0].split(",")[0] + ",44 L" + pts.join(" L") + " L120,44 Z");
}

// ---------- Surprise matrix
var cellEls = {};
(function buildMatrix(){
  var mx = $("matrix");
  mx.style.gridTemplateColumns = "minmax(14em,1.4fr) repeat(" + (APPS.length + 1) + ",minmax(6.5em,1fr))";
  ["Surprise"].concat(APPS).concat(["All apps"]).forEach(function(h){ mx.appendChild(el("div", { cls: "hdr", text: h })); });
  KINDS.forEach(function(k){
    mx.appendChild(el("div", { cls: "kind" }, [el("b", { text: k.title }), el("span", { text: k.desc })]));
    APPS.concat(["all"]).forEach(function(app){
      var b = el("button", { type: "button", cls: "cell", "data-app": app, "data-kind": k.kind, text: "Off" });
      b.addEventListener("click", function(){ toggleSurprise(k.kind, app); });
      cellEls[k.kind + "|" + app] = b;
      mx.appendChild(b);
    });
  });
  mx.appendChild(el("div", { cls: "kind" }, [el("b", { text: "Clear app" }), el("span", { text: "Remove every surprise for one app" })]));
  APPS.forEach(function(app){
    var b = el("button", { type: "button", cls: "cell ghost", text: "Clear " + app });
    b.addEventListener("click", function(){ surprise("clear", app); });
    mx.appendChild(b);
  });
  var all = el("button", { type: "button", cls: "cell ghost", text: "Clear all" });
  all.addEventListener("click", function(){ surprise("clear", "all"); });
  mx.appendChild(all);
})();
function isOn(cfg, kind, app){
  switch (kind) {
    case "rename-save": var r = cfg.renameButtons[app]; return !!(r && r[SAVE[app][0]]);
    case "confirm-modal": return !!cfg.confirmModal[app];
    case "announcement": return !!cfg.announcementModal[app];
    case "fields-in-tab": return !!cfg.editInTab[app];
    case "shuffle-fields": return !!cfg.shuffleFields[app];
    case "latency": return !!cfg.latency[app];
    case "partial-failure": var f = cfg.failures[app]; return !!(f && (f.beforeCommitRate > 0 || f.afterCommitRate > 0));
    case "concurrency-limit": return cfg.concurrencyLimit[app] !== undefined;
  }
  return false;
}
var currentCfg = null;
function renderCfg(cfg){
  currentCfg = cfg;
  KINDS.forEach(function(k){
    var allOn = true;
    APPS.forEach(function(app){
      var on = isOn(cfg, k.kind, app); if (!on) allOn = false;
      var b = cellEls[k.kind + "|" + app]; b.classList.toggle("on", on); b.textContent = on ? "On" : "Off"; b.setAttribute("aria-pressed", on ? "true" : "false");
    });
    var a = cellEls[k.kind + "|all"]; a.classList.toggle("on", allOn); a.textContent = allOn ? "All on" : "All"; a.setAttribute("aria-pressed", allOn ? "true" : "false");
  });
  APPS.forEach(function(app){
    var c = cards[app].chips; c.textContent = "";
    var any = false;
    KINDS.forEach(function(k){ if (isOn(cfg, k.kind, app)) { any = true; c.appendChild(el("span", { cls: "chip", text: k.title })); } });
    if (cfg.theme !== "default") { any = true; c.appendChild(el("span", { cls: "chip", text: "Theme: " + cfg.theme })); }
    if (cfg.pageSize[app]) { any = true; c.appendChild(el("span", { cls: "chip", text: "Page size " + cfg.pageSize[app] })); }
    if (!any) c.appendChild(el("span", { cls: "chip none", text: "No surprises" }));
  });
  if (!jsonDirty) { $("json").value = JSON.stringify(cfg, null, 2); $("json-state").textContent = "in sync"; }
}
function toggleSurprise(kind, app){
  if (!currentCfg) return;
  var apps = app === "all" ? APPS : [app];
  var allOn = apps.every(function(a){ return isOn(currentCfg, kind, a); });
  if (allOn) {
    var patch = {};
    apps.forEach(function(a){ var p = OFF_PATCH[kind](a); for (var key in p) { patch[key] = patch[key] || {}; for (var ak in p[key]) patch[key][ak] = p[key][ak]; } });
    api("PATCH", "/api/variations", patch).then(function(cfg){ renderCfg(cfg); log("off", kind + " · " + app); }).catch(function(e){ log("error", e.message, "bad"); });
  } else surprise(kind, app);
}
function surprise(kind, app){
  return api("POST", "/api/judge/surprise", { kind: kind, app: app }).then(function(cfg){ renderCfg(cfg); log(kind === "clear" ? "clear" : "surprise", kind + " · " + app, kind === "clear" ? "" : "warn"); }).catch(function(e){ log("error", e.message, "bad"); });
}
$("btn-clear").addEventListener("click", function(){ surprise("clear", "all"); });
$("btn-edit-unprocessed").addEventListener("click", function(){
  api("POST", "/api/judge/edit-unprocessed", {}).then(function(r){
    var text = r.recordKey + " → " + r.entity + " " + r.id + " " + JSON.stringify(r.patch);
    $("surprise-result").textContent = "Edited " + text; log("data edit", text, "warn");
  }).catch(function(e){ $("surprise-result").textContent = e.message; log("error", e.message, "bad"); });
});

// ---------- JSON editor
var jsonDirty = false;
$("json").addEventListener("input", function(){ jsonDirty = true; $("json-state").textContent = "edited (not applied)"; });
$("btn-json-reload").addEventListener("click", function(){ jsonDirty = false; $("json-err").hidden = true; refreshCfg(); });
$("btn-json-format").addEventListener("click", function(){ try { $("json").value = JSON.stringify(JSON.parse($("json").value), null, 2); $("json-err").hidden = true; } catch (e) { $("json-err").hidden = false; $("json-err").textContent = e.message; } });
$("btn-json-apply").addEventListener("click", function(){
  var parsed; try { parsed = JSON.parse($("json").value); } catch (e) { $("json-err").hidden = false; $("json-err").textContent = "JSON parse error: " + e.message; return; }
  api("PUT", "/api/variations", parsed).then(function(cfg){ jsonDirty = false; $("json-err").hidden = true; renderCfg(cfg); $("json-result").textContent = "Applied at " + new Date().toLocaleTimeString([], { hour12: false }); log("config", "Variation config replaced"); })
    .catch(function(e){ $("json-err").hidden = false; $("json-err").textContent = e.message + (e.data && e.data.issues ? "\n" + JSON.stringify(e.data.issues, null, 2) : ""); });
});
function refreshCfg(){ return api("GET", "/api/variations").then(renderCfg); }

// ---------- Scenario
function renderScenario(s){
  var kv = $("scn-kv"); kv.textContent = "";
  if (!s) { $("scn-chip").textContent = "no scenario"; $("scn-goal").hidden = true; return; }
  $("scn-chip").textContent = s.scenarioId;
  [["Title", s.title], ["Template", s.template], ["Seed", String(s.seed)], ["Records", String(s.records.length)], ["Holdout", s.holdout ? "yes" : "no"], ["Apps", s.applications.map(function(a){ return a.name; }).join(", ")]]
    .forEach(function(p){ kv.appendChild(el("dt", { text: p[0] })); kv.appendChild(el("dd", { text: p[1] })); });
  $("scn-goal").hidden = false; $("scn-goal").textContent = s.goal;
}
function refreshScenario(){
  return api("GET", "/api/scenario").then(renderScenario).catch(function(e){ if (e.status === 404) renderScenario(null); });
}
function refreshSummary(){
  return api("GET", "/api/expectation-summary").then(function(x){ $("e-need").textContent = x.needChange; $("e-notes").textContent = x.notes; $("e-records").textContent = x.records; }).catch(function(){});
}
$("load-form").addEventListener("submit", function(ev){
  ev.preventDefault();
  var body = { seed: Number($("f-seed").value), template: $("f-template").value, records: Number($("f-records").value) };
  api("POST", "/api/scenario", body).then(function(s){ renderScenario(s); refreshCfg(); refreshSummary(); clearCheck(); resetHistory(); log("scenario", "Loaded " + s.scenarioId); })
    .catch(function(e){ log("error", e.message, "bad"); });
});
$("btn-reset").addEventListener("click", function(){
  api("POST", "/api/reset", {}).then(function(s){ renderScenario(s); refreshCfg(); refreshSummary(); clearCheck(); resetHistory(); log("reset", "Restored snapshot, cleared surprises and stats"); })
    .catch(function(e){ log("error", e.message, "bad"); });
});

// ---------- Check
function clearCheck(){ $("acc-num").textContent = "—"; $("acc-sub").textContent = "Run a check to compare the apps against ground truth."; ["c-correct","c-dup","c-coll","c-esc","c-mis"].forEach(function(id){ $(id).textContent = "—"; }); setRing(0); var tb = $("mis-body"); tb.textContent = ""; tb.appendChild(el("tr", null, [el("td", { colspan: "5", cls: "empty", text: "No check run yet." })])); }
function setRing(frac){ var c = 2 * Math.PI * 50; $("ring-arc").setAttribute("stroke-dasharray", (c * frac).toFixed(1) + " " + c.toFixed(1)); }
function runCheck(quiet){
  return api("GET", "/api/check").then(function(r){
    var pct = (r.accuracy * 100);
    $("acc-num").textContent = pct.toFixed(1) + "%";
    $("acc-num").style.color = pct >= 99.95 ? "var(--green)" : pct >= 80 ? "var(--amber)" : "var(--red)";
    $("acc-sub").textContent = r.correctRecords + " of " + r.totalRecords + " records correct";
    $("c-correct").textContent = r.correctRecords + "/" + r.totalRecords;
    $("c-dup").textContent = r.duplicateWrites; $("c-coll").textContent = r.collateralWrites; $("c-esc").textContent = r.escalationExpected; $("c-mis").textContent = r.mismatches.length;
    setRing(r.accuracy);
    $("check-time").textContent = "checked " + new Date(r.checkedAt).toLocaleTimeString([], { hour12: false });
    var tb = $("mis-body"); tb.textContent = "";
    if (!r.mismatches.length) tb.appendChild(el("tr", null, [el("td", { colspan: "5", cls: "empty", text: "No mismatches." })]));
    r.mismatches.slice(0, 200).forEach(function(m){
      tb.appendChild(el("tr", null, [el("td", { text: m.recordKey }), el("td", { text: m.entity }), el("td", { text: m.field }), el("td", { cls: "exp", text: fmt(m.expected) }), el("td", { cls: "act", text: fmt(m.actual) })]));
    });
    if (r.mismatches.length > 200) tb.appendChild(el("tr", null, [el("td", { colspan: "5", cls: "empty", text: "…and " + (r.mismatches.length - 200) + " more" })]));
    if (!quiet) log("check", pct.toFixed(1) + "% · " + r.correctRecords + "/" + r.totalRecords + " · dup " + r.duplicateWrites + " · collateral " + r.collateralWrites);
  }).catch(function(e){ if (!quiet) log("error", e.message, "bad"); });
}
$("btn-check").addEventListener("click", function(){ runCheck(false); });
var autoTimer = null;
$("auto-check").addEventListener("change", function(){ if (this.checked) { runCheck(true); autoTimer = setInterval(function(){ runCheck(true); }, 3000); } else { clearInterval(autoTimer); } });

// ---------- Stats polling
function resetHistory(){ APPS.forEach(function(a){ history[a] = []; last[a] = null; drawSpark(a); }); }
function pollStats(){
  return api("GET", "/api/stats").then(function(s){
    $("live-dot").classList.remove("bad"); $("live-text").textContent = "Live";
    var now = Date.now();
    APPS.forEach(function(app){
      var st = s.apps[app], c = cards[app], prev = last[app];
      var rps = 0;
      if (prev && st.requests >= prev.requests) rps = (st.requests - prev.requests) / Math.max(0.25, (now - prev.t) / 1000);
      last[app] = { requests: st.requests, t: now };
      history[app].push(rps); if (history[app].length > 60) history[app].shift();
      c.rps.textContent = rps < 10 ? rps.toFixed(1) : String(Math.round(rps));
      drawSpark(app);
      c.m.inflight.v.textContent = st.inFlight; c.m.max.v.textContent = st.maxInFlight; c.m.writes.v.textContent = st.writes; c.m.requests.v.textContent = st.requests;
      c.m.t429.v.textContent = st.throttled429; c.m.c409.v.textContent = st.conflicts409; c.m.b503.v.textContent = st.injectedBeforeCommit; c.m.a500.v.textContent = st.injectedAfterCommit; c.m.d403.v.textContent = st.deniedWrites || 0;
      var limit = currentCfg && currentCfg.concurrencyLimit[app];
      c.bar.style.width = Math.min(100, (st.inFlight / (limit || Math.max(8, st.maxInFlight || 1))) * 100) + "%";
    });
  }).catch(function(){ $("live-dot").classList.add("bad"); $("live-text").textContent = "Disconnected"; });
}

// ---------- Boot
api("GET", "/api/health").then(function(h){
  var nav = $("top-links");
  APPS.forEach(function(app){
    var o = h.origins[app];
    nav.appendChild(el("a", { href: o, target: "_blank", rel: "noopener", text: NAMES[app] + " ↗" }));
    cards[app].origin.textContent = o.replace(/^https?:\/\//, ""); cards[app].origin.setAttribute("href", o);
  });
}).catch(function(){});
refreshScenario(); refreshCfg(); refreshSummary(); pollStats();
setInterval(pollStats, 1000);
setInterval(function(){ if (!jsonDirty) refreshCfg(); }, 1000);
setInterval(function(){ refreshScenario(); refreshSummary(); }, 5000);
log("ready", "Judge console connected");
})();
</script>
</body>
</html>`;

const ACCENTS: Record<string, string> = { CRM: "--crm", Orders: "--orders", Support: "--support", [HOLDOUT_APP]: "--app4" };
const META = {
  apps: APP_NAMES,
  names: { ...Object.fromEntries(CLASSIC_APPS.map((a) => [a, BRANDS[a].name])), [HOLDOUT_APP]: HOLDOUT_DISPLAY_NAME },
  save: Object.fromEntries(APP_NAMES.map((a) => [a, [SAVE_BUTTON_RENAMES[a].from, SAVE_BUTTON_RENAMES[a].to]])),
  accents: Object.fromEntries(APP_NAMES.map((a) => [a, ACCENTS[a] ?? "--cyan"])),
};

export const JUDGE_CONSOLE_HTML = TEMPLATE.replace("__ARENA_META__", () => JSON.stringify(META).replace(/</g, "\\u003c"));
