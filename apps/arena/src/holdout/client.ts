// HOLDOUT FIXTURE — engine/prompt developers must not read this file.

/**
 * Browser assets for the holdout app. Constants only: page data reaches the DOM through
 * textContent and attributes, never through innerHTML.
 * Note: these strings must not contain backticks or "${" sequences.
 */

export const CLIENT_CSS = String.raw`
*,*::before,*::after{box-sizing:border-box}
[hidden]{display:none!important}
:root{--font:"IBM Plex Sans","Source Sans 3","Segoe UI",system-ui,sans-serif;--mono:"IBM Plex Mono","SF Mono",Menlo,Consolas,monospace;--fs:14.5px;
--bg:#eef3f7;--panel:#fff;--ink:#0f2537;--ink-strong:#08192a;--muted:#5a6e80;--line:#d6e0e8;--line-strong:#b7c7d4;--accent:#0b6e8a;--accent-ink:#fff;--accent-soft:#e1f1f6;
--bar:#0a1d2e;--bar-ink:#d9ebf5;--bar-muted:#8fb0c4;--sel:#e8f4f8;--focus:#38bdf8;--danger:#a4271b;--danger-soft:#fdecea;--ok:#146c43;--ok-soft:#e3f5ec;--warn:#8a4b06;--warn-soft:#fdf1df;
--radius:10px;--radius-sm:6px;--pad:1rem;--gap:.75rem}
html{-webkit-text-size-adjust:100%}
body{margin:0;font-family:var(--font);font-size:var(--fs);line-height:1.45;color:var(--ink);background:var(--bg)}
a{color:var(--accent)}
h1,h2,h3{color:var(--ink-strong);line-height:1.2}
h2{font-size:1.25rem;margin:0}
h3{font-size:.8rem;text-transform:uppercase;letter-spacing:.09em;color:var(--muted);margin:1.4rem 0 .6rem}
button,input,select,textarea{font:inherit;color:inherit}
button{cursor:pointer;border:1px solid var(--line-strong);background:var(--panel);border-radius:var(--radius-sm);padding:.4rem .85rem;font-weight:600;color:var(--ink-strong)}
button:hover{background:#f5f9fb}
button:disabled{opacity:.55;cursor:default}
button.rw-primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
button.rw-primary:hover{filter:brightness(1.07)}
.rw-linkish{border:0;background:none;padding:0;color:var(--accent);text-decoration:underline;font-weight:500}
input[type=text],input[type=search],input[type=password],input:not([type]),select,textarea{width:100%;border:1px solid var(--line-strong);border-radius:var(--radius-sm);padding:.42rem .6rem;background:#fff}
textarea{resize:vertical}
:focus-visible{outline:3px solid var(--focus);outline-offset:1px}
label{display:block;font-weight:600;font-size:.85rem;margin:0 0 .3rem;color:var(--ink-strong)}
.rw-muted{color:var(--muted)}
.rw-mono{font-family:var(--mono);font-size:.92em}
.rw-boot{padding:3rem;text-align:center;color:var(--muted)}
.rw-wordmark{display:flex;align-items:center;gap:.5rem;font-weight:700;letter-spacing:.02em;margin:0}
.rw-glyph{width:20px;height:20px;border-radius:5px;background:conic-gradient(from 200deg,#7dd3fc,#0b6e8a,#e0f2fe,#7dd3fc);box-shadow:inset 0 0 0 2px rgba(255,255,255,.35)}
.rw-frame{min-height:100vh;display:flex;flex-direction:column}
.rw-bar{display:flex;align-items:center;gap:1.5rem;padding:.55rem 1.25rem;background:var(--bar);color:var(--bar-ink)}
.rw-bar .rw-wordmark{color:#fff}
.rw-nav{display:flex;gap:.2rem;background:rgba(255,255,255,.06);padding:.2rem;border-radius:999px}
.rw-nav [role=tab]{color:var(--bar-muted);text-decoration:none;padding:.3rem .9rem;border-radius:999px;font-weight:600;font-size:.92rem}
.rw-nav [role=tab][aria-selected=true]{background:#fff;color:var(--bar)}
.rw-account{margin-left:auto}
.rw-account-btn{background:transparent;border-color:rgba(255,255,255,.25);color:var(--bar-ink)}
.rw-account-btn:hover{background:rgba(255,255,255,.08)}
.rw-alert{margin:.75rem 1.25rem 0;padding:.6rem .8rem;border:1px solid #f3b8b1;background:var(--danger-soft);color:var(--danger);border-radius:var(--radius-sm);display:flex;gap:.75rem;align-items:flex-start}
.rw-alert p{margin:0;flex:1}
.rw-alert button{padding:.1rem .5rem}
.rw-body{flex:1;display:grid;grid-template-columns:minmax(0,1fr);align-items:start}
.rw-body.rw-has-detail{grid-template-columns:minmax(0,1fr) minmax(22rem,34rem)}
.rw-pane{padding:1rem 1.25rem 2rem;min-width:0}
.rw-pane-head{display:flex;align-items:baseline;gap:1rem;margin:.25rem 0 .9rem}
.rw-pane-head h1{font-size:1.35rem;margin:0}
.rw-tools{display:flex;flex-wrap:wrap;gap:.6rem;align-items:center;margin-bottom:.75rem}
.rw-tools input[type=search]{max-width:26rem}
.rw-chips{display:flex;flex-wrap:wrap;gap:.3rem}
.rw-chips button{border-radius:999px;padding:.2rem .7rem;font-size:.85rem;font-weight:600}
.rw-chips button[aria-pressed=true]{background:var(--accent-soft);border-color:var(--accent);color:var(--accent)}
.rw-count{color:var(--muted);font-size:.88rem;margin:0 0 .5rem}
.rw-rows{list-style:none;margin:0;padding:0;background:var(--panel);border:1px solid var(--line);border-radius:var(--radius)}
.rw-row{display:grid;grid-template-columns:minmax(0,1fr) auto auto auto;gap:.75rem;align-items:center;padding:.5rem .75rem;border-top:1px solid var(--line)}
.rw-row:first-child{border-top:0}
.rw-row.rw-current{background:var(--sel);box-shadow:inset 3px 0 0 var(--accent)}
.rw-row-main{display:flex;flex-direction:column;text-decoration:none;color:inherit;min-width:0}
.rw-row-main:hover .rw-key{text-decoration:underline}
.rw-key{font-family:var(--mono);font-weight:600;color:var(--ink-strong)}
.rw-sub{color:var(--muted);font-size:.84rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rw-more{border:0;background:none;font-size:1.2rem;line-height:1;padding:.2rem .5rem;color:var(--muted)}
.rw-more:hover{background:var(--sel)}
.rw-empty{padding:1.5rem;text-align:center;color:var(--muted)}
.rw-load{margin-top:.75rem}
.rw-pill{display:inline-block;padding:.05rem .55rem;border-radius:999px;font-size:.78rem;font-weight:700;background:#eef2f5;color:#334155;white-space:nowrap}
.rw-pill.s-available,.rw-pill.c-active,.rw-pill.v-normal{background:var(--ok-soft);color:var(--ok)}
.rw-pill.s-reserved,.rw-pill.c-limited{background:#e7ecfb;color:#2b47a3}
.rw-pill.s-quarantined,.rw-pill.v-service_requested{background:var(--warn-soft);color:var(--warn)}
.rw-pill.s-discard_pending,.rw-pill.c-withdrawn{background:var(--danger-soft);color:var(--danger)}
.rw-pill.s-consumed{background:#eceff3;color:#4b5563}
.rw-flag{font-size:.74rem;font-weight:700;color:var(--danger);border:1px solid #f3b8b1;border-radius:4px;padding:0 .35rem}
.rw-units{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(15rem,1fr));gap:.75rem}
.rw-units a{display:block;background:var(--panel);border:1px solid var(--line);border-radius:var(--radius);padding:.8rem .9rem;text-decoration:none;color:inherit}
.rw-units a:hover{border-color:var(--accent)}
.rw-units a.rw-current{border-color:var(--accent);box-shadow:0 0 0 2px var(--accent-soft)}
.rw-units .rw-key{display:block}
.rw-units .rw-sub{display:block;margin:.15rem 0 .5rem}
.rw-detail{background:var(--panel);border-left:1px solid var(--line);padding:1rem 1.25rem 2rem;position:sticky;top:0;max-height:100vh;overflow:auto}
.rw-detail-head{display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;margin-bottom:.9rem}
.rw-eyebrow{margin:0 0 .15rem;font-size:.75rem;text-transform:uppercase;letter-spacing:.1em;color:var(--muted);font-weight:700}
.rw-close{border:0;background:none;font-size:1.3rem;line-height:1;padding:.15rem .45rem;color:var(--muted)}
.rw-detail-actions{display:flex;gap:.5rem;flex-wrap:wrap;margin:0 0 1rem}
.rw-fields{display:grid;grid-template-columns:9rem minmax(0,1fr);gap:.5rem 1rem;margin:0}
.rw-fields dt{color:var(--muted);font-size:.88rem;padding-top:.15rem}
.rw-fields dd{margin:0;min-width:0;overflow-wrap:anywhere}
.rw-editable{display:flex;gap:.5rem;align-items:flex-start;flex-wrap:wrap}
.rw-editable .rw-value{flex:1;min-width:6rem}
.rw-editable .rw-edit{padding:.05rem .5rem;font-size:.8rem}
.rw-inline{display:flex;flex-direction:column;gap:.4rem;width:100%}
.rw-inline .rw-btns{display:flex;gap:.4rem}
.rw-log{list-style:none;margin:0;padding:0;border-left:2px solid var(--line);padding-left:.9rem}
.rw-log li{margin:0 0 .7rem;position:relative}
.rw-log li::before{content:"";position:absolute;left:-1.24rem;top:.4rem;width:.6rem;height:.6rem;border-radius:50%;background:var(--panel);border:2px solid var(--accent)}
.rw-entry-text{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}
.rw-entry-meta{margin:.1rem 0 0;font-size:.8rem;color:var(--muted)}
.rw-entry-form{border:1px solid var(--line);border-radius:var(--radius-sm);padding:.7rem;margin:0 0 .9rem;background:#f8fbfc}
.rw-entry-form .rw-btns{display:flex;gap:.4rem;margin-top:.5rem}
.rw-hint{font-size:.8rem;color:var(--muted);margin:.3rem 0 0}
.rw-excursions{list-style:none;margin:0;padding:0}
.rw-excursions li{display:grid;grid-template-columns:6.5rem 1fr;gap:.1rem .75rem;padding:.45rem 0;border-top:1px solid var(--line)}
.rw-excursions li:first-child{border-top:0}
.rw-excursions .rw-exc-meta{grid-column:2;color:var(--muted);font-size:.85rem}
.rw-subtabs{display:flex;gap:.25rem;border-bottom:1px solid var(--line);margin:0 0 1rem}
.rw-subtabs [role=tab]{border:0;border-bottom:3px solid transparent;border-radius:0;background:none;color:var(--muted);padding:.4rem .8rem;margin-bottom:-1px}
.rw-subtabs [role=tab][aria-selected=true]{color:var(--ink-strong);border-bottom-color:var(--accent)}
.rw-menu{position:absolute;z-index:50;min-width:13rem;list-style:none;margin:0;padding:.3rem;background:var(--panel);border:1px solid var(--line-strong);border-radius:var(--radius-sm);box-shadow:0 12px 30px rgba(8,25,42,.18)}
.rw-menu [role=menuitem]{padding:.45rem .7rem;border-radius:4px;cursor:pointer}
.rw-menu [role=menuitem]:hover,.rw-menu [role=menuitem]:focus{background:var(--sel);outline:none}
.rw-scrim{position:fixed;inset:0;background:rgba(8,25,42,.5);display:flex;align-items:flex-start;justify-content:center;padding:10vh 1rem 1rem;z-index:100}
.rw-dialog{background:var(--panel);border-radius:var(--radius);width:100%;max-width:28rem;padding:1.25rem 1.3rem 1.1rem;box-shadow:0 24px 60px rgba(0,0,0,.3)}
.rw-dialog h2{font-size:1.1rem;margin:0 0 .75rem}
.rw-dialog-actions{display:flex;justify-content:flex-end;gap:.5rem;margin-top:1.1rem}
.rw-dialog-error{margin:.75rem 0 0;color:var(--danger);font-weight:600}
.rw-choices{border:0;margin:0;padding:0}
.rw-choices legend{font-weight:600;font-size:.85rem;margin-bottom:.4rem}
.rw-choice{display:flex;align-items:center;gap:.5rem;padding:.3rem 0}
.rw-choice label{margin:0;font-weight:500}
.rw-change{display:flex;align-items:center;gap:.4rem}
.rw-field{margin-bottom:.8rem}
.rw-toast{position:fixed;left:50%;bottom:1.25rem;transform:translateX(-50%);background:var(--bar);color:#fff;padding:.55rem 1rem;border-radius:999px;font-weight:600;box-shadow:0 10px 25px rgba(0,0,0,.25);z-index:200}
.rw-toast:empty{display:none}
.rw-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.rw-signin{min-height:100vh;display:grid;place-items:center;padding:2rem;background:radial-gradient(60rem 30rem at 20% 0,#cfe8f2,transparent 60%),var(--bg)}
.rw-signin-card{width:100%;max-width:23rem;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:1.75rem;box-shadow:0 20px 50px rgba(8,25,42,.12)}
.rw-signin-card h1{font-size:1.35rem;margin:1.1rem 0 .3rem}
.rw-signin-card form{margin-top:1.2rem}
.rw-wide{width:100%;padding:.55rem}
.rw-who{margin:0 0 .9rem;font-size:.9rem;display:flex;gap:.4rem;flex-wrap:wrap;align-items:baseline}
.rw-error{color:var(--danger);font-weight:600;margin:.8rem 0 0}
.rw-message-page{max-width:36rem;margin:12vh auto;padding:0 1.5rem}
@media (max-width:900px){.rw-body.rw-has-detail{grid-template-columns:minmax(0,1fr)}.rw-detail{position:static;border-left:0;border-top:1px solid var(--line);max-height:none}}
body.theme-dense{--fs:13px;--pad:.6rem;--gap:.5rem}
body.theme-dense .rw-row{padding:.28rem .6rem}
body.theme-dense .rw-fields{gap:.3rem .8rem}
body.theme-contrast{--bg:#fff;--panel:#fff;--ink:#000;--ink-strong:#000;--muted:#222;--line:#000;--line-strong:#000;--accent:#000;--accent-ink:#fff;--accent-soft:#fff3a6;--bar:#000;--bar-ink:#fff;--bar-muted:#fff;--sel:#fffbcc;--focus:#ffb000}
body.theme-contrast a{text-decoration:underline}
body.theme-contrast .rw-pill{background:#000!important;color:#fff!important}
body.theme-contrast button,body.theme-contrast input,body.theme-contrast select,body.theme-contrast textarea{border-width:2px}
`;

export const CLIENT_JS = String.raw`(function () {
"use strict";
var root = document.getElementById("rw-root");
var CFG = null;
var L = null;
var uid = 0;
var VIEWS = [{ id: "specimens", label: "Specimens" }, { id: "participants", label: "Participants" }, { id: "storage", label: "Storage" }];
var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ---------- helpers
function t(s) { var m = (CFG && CFG.t) || {}; return Object.prototype.hasOwnProperty.call(m, s) ? m[s] : s; }
function append(e, kids) {
  if (kids === null || kids === undefined || kids === false) return;
  if (!Array.isArray(kids)) kids = [kids];
  kids.forEach(function (c) {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) append(e, c);
    else e.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
  });
}
function h(tag, attrs, kids) {
  var e = document.createElement(tag);
  if (attrs) for (var k in attrs) {
    var v = attrs[k];
    if (v === null || v === undefined || v === false) continue;
    if (k === "text") e.textContent = v;
    else if (k === "cls") e.className = v;
    else if (k.slice(0, 2) === "on" && typeof v === "function") e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, "");
    else e.setAttribute(k, String(v));
  }
  append(e, kids);
  return e;
}
function clear(e) { while (e.firstChild) e.removeChild(e.firstChild); }
function enc(s) { return encodeURIComponent(s); }
function lbl(group, v) { return (L && L[group] && L[group][v]) || v; }
function pad2(n) { return n < 10 ? "0" + n : String(n); }
function when(iso) {
  var d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso);
  return MONTHS[d.getUTCMonth()] + " " + d.getUTCDate() + ", " + d.getUTCFullYear() + ", " + pad2(d.getUTCHours()) + ":" + pad2(d.getUTCMinutes()) + " UTC";
}
function timeEl(iso) { return h("time", { datetime: iso, text: when(iso) }); }
function temp(c) { return Number(c).toFixed(1) + " °C"; }
function qs(o) { var p = []; for (var k in o) if (o[k] !== "" && o[k] !== null && o[k] !== undefined) p.push(enc(k) + "=" + enc(o[k])); return p.length ? "?" + p.join("&") : ""; }
function pill(group, v) { return h("span", { cls: "rw-pill " + group.charAt(0) + "-" + v, text: lbl(group, v) }); }
function button(text, o) {
  o = o || {};
  return h("button", { type: "button", cls: o.primary ? "rw-primary" : (o.cls || null), "aria-label": o.label || null, disabled: o.disabled ? true : null, onclick: o.onclick || null, text: t(text) });
}
function mulberry(seed) {
  var s = (seed >>> 0) ^ 0x9e3779b9;
  return function () { var x = (s = (s + 0x6d2b79f5) >>> 0); x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
}
function shuffled(xs, seed) {
  if (!seed || xs.length < 2) return xs.slice();
  var r = mulberry(seed), a = xs.slice();
  for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(r() * (i + 1)); var tmp = a[i]; a[i] = a[j]; a[j] = tmp; }
  if (a.every(function (x, i) { return x === xs[i]; })) a.push(a.shift());
  return a;
}

// ---------- network
var refreshing = null;
function api(method, path, body) {
  var init = { method: method, headers: { accept: "application/json" }, credentials: "same-origin" };
  if (body !== undefined) { init.headers["content-type"] = "application/json"; init.body = JSON.stringify(body); }
  return fetch(path, init).then(function (r) {
    var version = r.headers.get("x-rw-ui");
    return r.text().then(function (txt) {
      var data = null;
      try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = null; }
      function finish() {
        if (r.status === 401) { location.assign("/signin" + qs({ next: "/" + location.hash })); }
        if (!r.ok) {
          var err = new Error((data && data.message) || ("The request failed (" + r.status + ")."));
          err.status = r.status;
          throw err;
        }
        return data;
      }
      // Workspace settings changed since this page loaded: re-render with them before continuing.
      if (CFG && version && version !== CFG.version && path !== "/svc/boot") return refreshConfig().then(finish, finish);
      return finish();
    });
  }, function () { throw new Error("The registry could not be reached. Check your connection and try again."); });
}
function refreshConfig() {
  if (!refreshing) {
    refreshing = api("GET", "/svc/boot").then(function (cfg) { refreshing = null; applyConfig(cfg); }, function () { refreshing = null; });
  }
  return refreshing;
}

// ---------- status messages
var toastEl = null, alertEl = null, alertText = null, toastTimer = null;
function toast(msg) {
  if (!toastEl) return;
  toastEl.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { toastEl.textContent = ""; }, 6000);
}
function showError(err) { if (!alertEl) return; alertText.textContent = (err && err.message) || String(err); alertEl.hidden = false; }
function clearError() { if (alertEl) alertEl.hidden = true; }

// ---------- dialogs (stacked; everything underneath is inert)
var layers = [];
var frameEl = null;
function syncInert() {
  if (frameEl) frameEl.inert = layers.length > 0;
  layers.forEach(function (l, i) { l.scrim.inert = i < layers.length - 1; });
}
function dialog(title, onCancel) {
  var titleId = "rw-dlg-" + (++uid);
  var heading = h("h2", { id: titleId, text: title });
  var body = h("div", { cls: "rw-dialog-body" });
  var err = h("p", { cls: "rw-dialog-error", role: "alert", hidden: true });
  var actions = h("div", { cls: "rw-dialog-actions" });
  var box = h("div", { cls: "rw-dialog", role: "dialog", "aria-modal": "true", "aria-labelledby": titleId }, [heading, body, err, actions]);
  var scrim = h("div", { cls: "rw-scrim" }, [box]);
  var opener = document.activeElement;
  var layer = { scrim: scrim };
  layers.push(layer);
  document.body.appendChild(scrim);
  syncInert();
  var closed = false;
  function close() {
    if (closed) return;
    closed = true;
    var i = layers.indexOf(layer);
    if (i >= 0) layers.splice(i, 1);
    if (scrim.parentNode) scrim.parentNode.removeChild(scrim);
    syncInert();
    if (opener && opener.focus && document.body.contains(opener)) opener.focus();
  }
  scrim.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    e.preventDefault(); e.stopPropagation();
    close();
    if (onCancel) onCancel();
  });
  return {
    body: body, actions: actions, close: close,
    title: function (s) { heading.textContent = s; },
    error: function (m) { err.hidden = !m; err.textContent = m || ""; },
    reset: function () { clear(body); clear(actions); err.hidden = true; }
  };
}

function confirmWrite(summary) {
  if (!CFG.confirm) return Promise.resolve(true);
  return new Promise(function (resolve) {
    var d = dialog("Are you sure?", function () { resolve(false); });
    d.body.appendChild(h("p", { text: summary }));
    d.actions.appendChild(button("Go back", { onclick: function () { d.close(); resolve(false); } }));
    var yes = button("Yes, continue", { primary: true, onclick: function () { d.close(); resolve(true); } });
    d.actions.appendChild(yes);
    yes.focus();
  });
}

/** Confirm (when required), call, then report. Resolves true when the write succeeded. */
function perform(summary, call, done, dlg) {
  return confirmWrite(summary).then(function (ok) {
    if (!ok) return false;
    clearError();
    if (dlg) dlg.error("");
    return call().then(function (res) { if (done) done(res); return true; }, function (err) {
      if (dlg) dlg.error(err.message); else showError(err);
      return false;
    });
  });
}

// ---------- menus
var openMenu = null;
function closeMenu(focusButton) {
  if (!openMenu) return;
  var m = openMenu;
  openMenu = null;
  if (m.el.parentNode) m.el.parentNode.removeChild(m.el);
  m.btn.setAttribute("aria-expanded", "false");
  if (focusButton) m.btn.focus();
}
function toggleMenu(btn, items) {
  if (openMenu && openMenu.btn === btn) { closeMenu(true); return; }
  closeMenu(false);
  var id = "rw-menu-" + (++uid);
  var el = h("ul", { cls: "rw-menu", role: "menu", id: id, "aria-label": btn.getAttribute("aria-label") || btn.textContent });
  var els = items.map(function (it) {
    var li = h("li", { role: "menuitem", tabindex: "-1", text: t(it.label) });
    li.addEventListener("click", function () { closeMenu(false); if (it.href) location.assign(it.href); else it.run(); });
    el.appendChild(li);
    return li;
  });
  el.addEventListener("keydown", function (e) {
    var i = els.indexOf(document.activeElement);
    if (e.key === "ArrowDown") { e.preventDefault(); els[(i + 1) % els.length].focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); els[(i - 1 + els.length) % els.length].focus(); }
    else if (e.key === "Escape") { e.preventDefault(); closeMenu(true); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (i >= 0) els[i].click(); }
    else if (e.key === "Tab") closeMenu(false);
  });
  btn.setAttribute("aria-expanded", "true");
  btn.setAttribute("aria-controls", id);
  var r = btn.getBoundingClientRect();
  el.style.top = (r.bottom + window.scrollY + 4) + "px";
  el.style.left = Math.max(8, r.right + window.scrollX - 224) + "px";
  document.body.appendChild(el);
  openMenu = { el: el, btn: btn };
  if (els[0]) els[0].focus();
}
document.addEventListener("click", function (e) {
  if (openMenu && !openMenu.el.contains(e.target) && !openMenu.btn.contains(e.target)) closeMenu(false);
});

// ---------- frame and routing
var tabs = {}, paneEl = null, detailEl = null, bodyEl = null;
var current = { view: null, id: null };
var detailSeq = 0;

function renderFrame() {
  document.body.className = "theme-" + CFG.theme;
  var nav = h("div", { cls: "rw-nav", role: "tablist", "aria-label": "Registry sections" });
  VIEWS.forEach(function (v, i) {
    var tab = h("a", { role: "tab", id: "rw-tab-" + v.id, href: "#/" + v.id, "aria-controls": "rw-pane", "aria-selected": "false", tabindex: "-1", text: t(v.label) });
    tab.addEventListener("keydown", function (e) {
      var d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      var n = VIEWS[(i + d + VIEWS.length) % VIEWS.length];
      location.hash = "#/" + n.id;
      tabs[n.id].focus();
    });
    tabs[v.id] = tab;
    nav.appendChild(tab);
  });
  var acct = h("button", { type: "button", cls: "rw-account-btn", "aria-haspopup": "menu", "aria-expanded": "false", "aria-label": "Account menu for " + CFG.user, text: CFG.user + " ▾" });
  acct.addEventListener("click", function () { toggleMenu(acct, [{ label: "Sign out", href: "/logout" }]); });
  var bar = h("header", { cls: "rw-bar" }, [h("p", { cls: "rw-wordmark" }, [h("span", { cls: "rw-glyph", "aria-hidden": "true" }), "Rimewell"]), nav, h("div", { cls: "rw-account" }, [acct])]);
  alertText = h("p");
  alertEl = h("div", { cls: "rw-alert", role: "alert", hidden: true }, [alertText, button("Dismiss", { label: "Dismiss message", onclick: clearError })]);
  paneEl = h("section", { id: "rw-pane", cls: "rw-pane", role: "tabpanel" });
  detailEl = h("aside", { id: "rw-detail", cls: "rw-detail", hidden: true });
  bodyEl = h("div", { cls: "rw-body" }, [h("main", { cls: "rw-pane-wrap" }, [paneEl]), detailEl]);
  frameEl = h("div", { cls: "rw-frame" }, [bar, alertEl, bodyEl]);
  toastEl = h("div", { cls: "rw-toast", role: "status", "aria-live": "polite" });
  clear(root);
  root.removeAttribute("aria-busy");
  root.appendChild(frameEl);
  root.appendChild(toastEl);
}

function parseRoute() {
  var parts = location.hash.replace(/^#\/?/, "").split("/").map(function (p) { try { return decodeURIComponent(p); } catch (e) { return p; } });
  var view = parts[0] || "specimens";
  if (!VIEWS.some(function (v) { return v.id === view; })) view = "specimens";
  return { view: view, id: parts[1] || "" };
}

function route() {
  closeMenu(false);
  var r = parseRoute();
  VIEWS.forEach(function (v) { var on = v.id === r.view; tabs[v.id].setAttribute("aria-selected", on ? "true" : "false"); tabs[v.id].tabIndex = on ? 0 : -1; });
  paneEl.setAttribute("aria-labelledby", "rw-tab-" + r.view);
  if (r.view !== current.view) { current.view = r.view; LISTS[r.view].render(); }
  current.id = r.id;
  if (r.id) DETAILS[r.view](r.id); else closeDetail();
  markCurrent();
}

function markCurrent() {
  var nodes = paneEl.querySelectorAll("[data-key]");
  for (var i = 0; i < nodes.length; i++) nodes[i].classList.toggle("rw-current", nodes[i].getAttribute("data-key") === current.id);
}

function closeDetail() {
  detailSeq++;
  if (!detailEl) return;
  clear(detailEl);
  detailEl.hidden = true;
  bodyEl.classList.remove("rw-has-detail");
}

function detailShell(kind, title) {
  clear(detailEl);
  detailEl.hidden = false;
  bodyEl.classList.add("rw-has-detail");
  detailEl.setAttribute("aria-labelledby", "rw-detail-title");
  var close = h("button", { type: "button", cls: "rw-close", "aria-label": "Close details", text: "×" });
  close.addEventListener("click", function () { location.hash = "#/" + current.view; });
  detailEl.appendChild(h("header", { cls: "rw-detail-head" }, [h("div", null, [h("p", { cls: "rw-eyebrow", text: kind }), h("h2", { id: "rw-detail-title", text: title })]), close]));
}

function detailMessage(kind, title, msg) {
  detailShell(kind, title);
  detailEl.appendChild(h("p", { cls: "rw-muted", role: "status", text: msg }));
}

function fieldList(defs) {
  var dl = h("dl", { cls: "rw-fields" });
  defs.forEach(function (d) { dl.appendChild(h("dt", { text: d.label })); dl.appendChild(d.dd || h("dd", null, d.value)); });
  return dl;
}

function sections(defs, extras) {
  // extras: { summary: [nodes], handling: [nodes] }
  if (!CFG.tabs) {
    detailEl.appendChild(h("div", null, extras.actions || []));
    detailEl.appendChild(fieldList(defs));
    append(detailEl, extras.handling || []);
    return;
  }
  var panels = [
    { id: "summary", label: "Summary", nodes: [fieldList(defs.filter(function (d) { return d.panel !== "handling"; }))] },
    { id: "handling", label: "Handling", nodes: [h("div", null, extras.actions || []), fieldList(defs.filter(function (d) { return d.panel === "handling"; }))].concat(extras.handling || []) }
  ];
  var list = h("div", { cls: "rw-subtabs", role: "tablist", "aria-label": "Detail sections" });
  var tabEls = [], panelEls = [];
  panels.forEach(function (p, i) {
    var tab = h("button", { type: "button", role: "tab", id: "rw-dt-" + p.id, "aria-controls": "rw-dp-" + p.id, "aria-selected": i === 0 ? "true" : "false", tabindex: i === 0 ? "0" : "-1", text: t(p.label) });
    var panel = h("div", { role: "tabpanel", id: "rw-dp-" + p.id, "aria-labelledby": "rw-dt-" + p.id, hidden: i !== 0 }, p.nodes);
    tabEls.push(tab); panelEls.push(panel);
    list.appendChild(tab);
  });
  function select(i) { tabEls.forEach(function (tb, j) { tb.setAttribute("aria-selected", i === j ? "true" : "false"); tb.tabIndex = i === j ? 0 : -1; panelEls[j].hidden = i !== j; }); }
  tabEls.forEach(function (tb, i) {
    tb.addEventListener("click", function () { select(i); });
    tb.addEventListener("keydown", function (e) { var d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0; if (!d) return; e.preventDefault(); var n = (i + d + tabEls.length) % tabEls.length; select(n); tabEls[n].focus(); });
  });
  detailEl.appendChild(list);
  panelEls.forEach(function (p) { detailEl.appendChild(p); });
}

/** A value with an inline editor: Edit -> control + Save/Cancel. save(value) resolves true on success. */
function editable(label, value, display, control, save) {
  var dd = h("dd", { cls: "rw-editable" });
  function view() {
    clear(dd);
    dd.appendChild(h("span", { cls: "rw-value" }, display));
    dd.appendChild(h("button", { type: "button", cls: "rw-edit", "aria-label": "Edit " + label.toLowerCase(), text: t("Edit"), onclick: edit }));
  }
  function edit() {
    clear(dd);
    var input = control();
    input.setAttribute("aria-label", label);
    input.value = value;
    var save1 = button("Save", { primary: true, onclick: function () {
      save1.disabled = true;
      save(input.value).then(function (ok) { if (!ok) save1.disabled = false; });
    } });
    dd.appendChild(h("div", { cls: "rw-inline" }, [input, h("div", { cls: "rw-btns" }, [save1, button("Cancel", { onclick: view })])]));
    input.focus();
  }
  view();
  return dd;
}

// ---------- specimens
var STATES = ["available", "reserved", "quarantined", "discard_pending", "consumed"];

function specimenRow(s) {
  var li = h("li", { cls: "rw-row", "data-key": s.accession });
  var main = h("a", { cls: "rw-row-main", href: "#/specimens/" + enc(s.accession) }, [h("span", { cls: "rw-key", text: s.accession }), h("span", { cls: "rw-sub", text: s.label_code + " · " + lbl("material", s.material) + " · " + s.unit_id })]);
  var more = h("button", { type: "button", cls: "rw-more", "aria-haspopup": "menu", "aria-expanded": "false", "aria-label": "Actions for " + s.accession, text: "⋯" });
  more.addEventListener("click", function () {
    var items = [{ label: "Open", run: function () { location.hash = "#/specimens/" + enc(s.accession); } }, { label: "Change state…", run: function () { stateWizard(s); } }];
    if (s.hold) items.push({ label: "Release review hold", run: function () { releaseHold(s); } });
    else items.push({ label: "Place review hold…", run: function () { holdDialog(s); } });
    toggleMenu(more, items);
  });
  append(li, [main, pill("state", s.state), s.hold ? h("span", { cls: "rw-flag", text: "Hold" }) : h("span"), more]);
  return li;
}

function listController(o) {
  // o: { title, search, filter?, path, row(item), container: "ul"|"grid", empty }
  var st = { q: "", filter: "", items: 0, next: 0, seq: 0 };
  var ul, count, more;
  function fetchPage() {
    var seq = ++st.seq;
    more.disabled = true;
    var params = { q: st.q, offset: st.next, limit: CFG.pageSize };
    if (o.filter) params.state = st.filter;
    api("GET", o.path + qs(params)).then(function (res) {
      if (seq !== st.seq) return;
      res.items.forEach(function (it) { ul.appendChild(o.row(it)); });
      st.items += res.items.length;
      st.next = res.nextOffset;
      count.textContent = res.total ? "Showing " + st.items + " of " + res.total : "";
      if (!res.total) ul.appendChild(h("li", { cls: "rw-empty", text: o.empty }));
      more.hidden = res.nextOffset === null;
      more.disabled = false;
      markCurrent();
    }, function (err) { if (seq === st.seq) { more.disabled = false; showError(err); } });
  }
  function reload() { clear(ul); st.items = 0; st.next = 0; more.hidden = true; count.textContent = ""; fetchPage(); }
  return {
    render: function () {
      clear(paneEl);
      var search = h("input", { type: "search", "aria-label": o.search, placeholder: o.placeholder });
      search.value = st.q;
      var timer = null;
      search.addEventListener("input", function () { clearTimeout(timer); timer = setTimeout(function () { st.q = search.value.trim(); reload(); }, 250); });
      search.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); clearTimeout(timer); st.q = search.value.trim(); reload(); } });
      var tools = h("div", { cls: "rw-tools", role: "search" }, [search]);
      if (o.filter) {
        var chips = h("div", { cls: "rw-chips", role: "group", "aria-label": "Filter by state" });
        var all = [""].concat(STATES);
        var btns = all.map(function (v) {
          var b = h("button", { type: "button", "aria-pressed": st.filter === v ? "true" : "false", text: v ? lbl("state", v) : "All states" });
          b.addEventListener("click", function () { st.filter = v; btns.forEach(function (x, i) { x.setAttribute("aria-pressed", all[i] === v ? "true" : "false"); }); reload(); });
          chips.appendChild(b);
          return b;
        });
        tools.appendChild(chips);
      }
      ul = h("ul", { cls: "rw-rows", role: "list" });
      count = h("p", { cls: "rw-count", "aria-live": "polite" });
      more = button("Load more", { cls: "rw-load", onclick: fetchPage });
      append(paneEl, [h("div", { cls: "rw-pane-head" }, [h("h1", { text: o.title })]), tools, count, ul, more]);
      reload();
    },
    replaceRow: function (key, item) {
      var old = ul && ul.querySelector('[data-key="' + (window.CSS && CSS.escape ? CSS.escape(key) : key) + '"]');
      if (old) { old.parentNode.replaceChild(o.row(item), old); markCurrent(); }
    }
  };
}

var specimenList = listController({ title: "Specimens", search: "Search specimens", placeholder: "Accession, tube label, or participant", filter: true, path: "/svc/specimens", row: specimenRow, empty: "No specimens match." });

function afterSpecimenWrite(acc) {
  return api("GET", "/svc/specimens/" + enc(acc)).then(function (res) {
    specimenList.replaceRow(acc, res.specimen);
    if (current.view === "specimens" && current.id === acc) renderSpecimen(res);
  }, showError);
}

function openSpecimen(acc) {
  var seq = ++detailSeq;
  detailMessage("Specimen", acc, "Loading…");
  api("GET", "/svc/specimens/" + enc(acc)).then(function (res) { if (seq === detailSeq) renderSpecimen(res); }, function (err) { if (seq === detailSeq) detailMessage("Specimen", acc, err.message); });
}

function patchSpecimen(s, field, label, value) {
  return perform("Change " + label.toLowerCase() + " of " + s.accession + " to “" + value + "”", function () {
    return api("PATCH", "/svc/specimens/" + enc(s.accession), { field: field, value: value, version: s.version });
  }, function () { toast(label + " saved"); afterSpecimenWrite(s.accession); });
}

function renderSpecimen(res) {
  var s = res.specimen;
  detailShell("Specimen", s.accession);
  var defs = [
    { key: "label_code", label: "Tube label", panel: "summary", value: h("span", { cls: "rw-mono", text: s.label_code }) },
    { key: "material", label: "Material", panel: "summary", value: lbl("material", s.material) },
    { key: "participant", label: "Participant", panel: "summary", value: h("a", { href: "#/participants/" + enc(s.participant_code), text: s.participant_code }) },
    { key: "unit", label: "Storage unit", panel: "summary", value: h("a", { href: "#/storage/" + enc(s.unit_id), text: s.unit_id }) },
    { key: "position", label: "Position", panel: "handling", dd: editable("Position", s.position, s.position, function () { return h("input", { type: "text" }); }, function (v) { return patchSpecimen(s, "position", "Position", v.trim()); }) },
    { key: "stored", label: "Stored", panel: "summary", value: timeEl(s.stored_at) },
    { key: "state", label: "State", panel: "handling", value: pill("state", s.state) },
    { key: "hold", label: "Review hold", panel: "handling", value: s.hold ? [h("span", { cls: "rw-flag", text: "On hold" }), " ", s.hold_reason] : "None" },
    { key: "note", label: "Handling note", panel: "handling", dd: editable("Handling note", s.handling_note, s.handling_note || "—", function () { return h("textarea", { rows: "3" }); }, function (v) { return patchSpecimen(s, "handling_note", "Handling note", v.trim()); }) },
    { key: "updated", label: "Last changed", panel: "summary", value: timeEl(s.updated_at) },
    { key: "revision", label: "Revision", panel: "summary", value: String(s.version) }
  ];
  var actions = [h("div", { cls: "rw-detail-actions" }, [button("Change state…", { onclick: function () { stateWizard(s); } })])];
  sections(shuffled(defs, CFG.shuffle), { actions: actions, handling: [custodySection(s, res.custody)] });
}

function custodyItem(e) {
  return h("li", null, [h("p", { cls: "rw-entry-text", text: e.text }), h("p", { cls: "rw-entry-meta" }, [e.actor + " · ", timeEl(e.at)])]);
}

function custodySection(s, page) {
  var sec = h("section", { cls: "rw-custody", "aria-labelledby": "rw-custody-h" });
  var list = h("ol", { cls: "rw-log" });
  var oldest = null;
  function add(entries) { entries.forEach(function (e) { list.appendChild(custodyItem(e)); oldest = e.id; }); }
  add(page.entries);
  var earlier = button("Show earlier entries", { onclick: function () {
    earlier.disabled = true;
    api("GET", "/svc/specimens/" + enc(s.accession) + "/custody" + qs({ before: oldest })).then(function (p) { add(p.entries); earlier.hidden = !p.more; earlier.disabled = false; }, function (err) { earlier.disabled = false; showError(err); });
  } });
  earlier.hidden = !page.more;
  var taId = "rw-entry-" + (++uid);
  var ta = h("textarea", { id: taId, rows: "3", maxlength: "500" });
  var form = h("div", { cls: "rw-entry-form", hidden: true });
  var addBtn = button("Add entry", { onclick: function () { form.hidden = false; addBtn.hidden = true; ta.focus(); } });
  var record = button("Record entry", { primary: true, onclick: function () {
    var text = ta.value.trim();
    if (!text) { showError(new Error("Write the entry before recording it.")); ta.focus(); return; }
    record.disabled = true;
    perform("Add this custody entry to " + s.accession + ": “" + text + "”", function () {
      return api("POST", "/svc/specimens/" + enc(s.accession) + "/custody", { text: text });
    }, function () { toast("Entry recorded"); afterSpecimenWrite(s.accession); }).then(function (ok) { if (!ok) record.disabled = false; });
  } });
  append(form, [h("label", { for: taId, text: "New entry" }), ta, h("p", { cls: "rw-hint", text: "Entries are permanent once recorded." }), h("div", { cls: "rw-btns" }, [record, button("Cancel", { onclick: function () { form.hidden = true; addBtn.hidden = false; ta.value = ""; } })])]);
  append(sec, [h("h3", { id: "rw-custody-h", text: "Chain of custody" }), addBtn, form, page.entries.length ? list : h("p", { cls: "rw-muted", text: "No entries yet." }), earlier]);
  return sec;
}

function stateWizard(s) {
  var choice = null;
  var d = dialog("Change state");
  function step1() {
    d.reset();
    d.title("Change state · Step 1 of 2");
    d.body.appendChild(h("p", { cls: "rw-muted", text: s.accession + " is " + lbl("state", s.state) + "." }));
    var fs = h("fieldset", { cls: "rw-choices" }, [h("legend", { text: "New state" })]);
    var next = button("Continue", { primary: true, disabled: !choice, onclick: step2 });
    STATES.forEach(function (st) {
      if (st === s.state) return;
      var id = "rw-st-" + (++uid);
      var input = h("input", { type: "radio", name: "rw-state-choice", id: id, value: st });
      if (choice === st) input.checked = true;
      input.addEventListener("change", function () { choice = st; next.disabled = false; });
      fs.appendChild(h("div", { cls: "rw-choice" }, [input, h("label", { for: id, text: lbl("state", st) })]));
    });
    d.body.appendChild(fs);
    d.actions.appendChild(button("Cancel", { onclick: d.close }));
    d.actions.appendChild(next);
    var first = fs.querySelector("input:checked") || fs.querySelector("input");
    if (first) first.focus();
  }
  function step2() {
    d.reset();
    d.title("Change state · Step 2 of 2");
    d.body.appendChild(h("p", null, ["Review the change for ", h("strong", { text: s.accession }), "."]));
    d.body.appendChild(h("p", { cls: "rw-change" }, [pill("state", s.state), h("span", { "aria-hidden": "true", text: "→" }), h("span", { cls: "rw-sr", text: "becomes" }), pill("state", choice)]));
    var apply = button("Apply change", { primary: true, onclick: function () {
      apply.disabled = true;
      perform(s.accession + ": " + lbl("state", s.state) + " → " + lbl("state", choice), function () {
        return api("POST", "/svc/specimens/" + enc(s.accession) + "/state", { to: choice, version: s.version });
      }, function () { d.close(); toast("State updated"); afterSpecimenWrite(s.accession); }, d).then(function (ok) { if (!ok) apply.disabled = false; });
    } });
    d.actions.appendChild(button("Back", { onclick: step1 }));
    d.actions.appendChild(apply);
    apply.focus();
  }
  step1();
}

function holdDialog(s) {
  var d = dialog("Place review hold");
  var id = "rw-reason-" + (++uid);
  var input = h("input", { type: "text", id: id, maxlength: "120" });
  d.body.appendChild(h("p", null, [h("strong", { text: s.accession }), " stays where it is, but no one can use it until the hold is released."]));
  d.body.appendChild(h("div", { cls: "rw-field" }, [h("label", { for: id, text: "Reason" }), input]));
  var place = button("Place hold", { primary: true, onclick: function () {
    var reason = input.value.trim();
    if (!reason) { d.error("Enter a reason for the hold."); input.focus(); return; }
    place.disabled = true;
    perform("Place a review hold on " + s.accession + " (" + reason + ")", function () {
      return api("POST", "/svc/specimens/" + enc(s.accession) + "/hold", { action: "place", reason: reason, version: s.version });
    }, function () { d.close(); toast("Review hold placed"); afterSpecimenWrite(s.accession); }, d).then(function (ok) { if (!ok) place.disabled = false; });
  } });
  input.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); place.click(); } });
  d.actions.appendChild(button("Cancel", { onclick: d.close }));
  d.actions.appendChild(place);
  input.focus();
}

function releaseHold(s) {
  perform("Release the review hold on " + s.accession, function () {
    return api("POST", "/svc/specimens/" + enc(s.accession) + "/hold", { action: "release", version: s.version });
  }, function () { toast("Review hold released"); afterSpecimenWrite(s.accession); });
}

// ---------- participants
function participantRow(p) {
  return h("li", { cls: "rw-row", "data-key": p.code }, [
    h("a", { cls: "rw-row-main", href: "#/participants/" + enc(p.code) }, [h("span", { cls: "rw-key", text: p.code }), h("span", { cls: "rw-sub", text: p.site + " · " + p.specimens + (p.specimens === 1 ? " specimen" : " specimens") })]),
    pill("consent", p.consent), h("span"), h("span")
  ]);
}
var participantList = listController({ title: "Participants", search: "Search participants", placeholder: "Participant code or site", filter: false, path: "/svc/participants", row: participantRow, empty: "No participants match." });

function openParticipant(code) {
  var seq = ++detailSeq;
  detailMessage("Participant", code, "Loading…");
  api("GET", "/svc/participants/" + enc(code)).then(function (res) {
    if (seq !== detailSeq) return;
    var p = res.participant;
    detailShell("Participant", p.code);
    detailEl.appendChild(fieldList([
      { label: "Consent", value: pill("consent", p.consent) },
      { label: "Consent updated", value: timeEl(p.consent_updated_at) },
      { label: "Enrollment site", value: p.site }
    ]));
    detailEl.appendChild(h("h3", { text: "Specimens" }));
    var ul = h("ul", { cls: "rw-rows", role: "list" });
    res.specimens.forEach(function (s) { ul.appendChild(h("li", { cls: "rw-row" }, [h("a", { cls: "rw-row-main", href: "#/specimens/" + enc(s.accession) }, [h("span", { cls: "rw-key", text: s.accession }), h("span", { cls: "rw-sub", text: lbl("material", s.material) + " · " + s.unit_id })]), pill("state", s.state), h("span"), h("span")])); });
    detailEl.appendChild(res.specimens.length ? ul : h("p", { cls: "rw-muted", text: "No specimens from this participant." }));
  }, function (err) { if (seq === detailSeq) detailMessage("Participant", code, err.message); });
}

// ---------- storage
var storageList = {
  render: function () {
    clear(paneEl);
    var grid = h("ul", { cls: "rw-units", role: "list" });
    append(paneEl, [h("div", { cls: "rw-pane-head" }, [h("h1", { text: "Storage units" })]), grid]);
    api("GET", "/svc/units").then(function (res) {
      res.items.forEach(function (u) {
        grid.appendChild(h("li", null, [h("a", { href: "#/storage/" + enc(u.id), "data-key": u.id }, [h("span", { cls: "rw-key", text: u.id }), h("span", { cls: "rw-sub", text: u.name + " · " + u.location }), pill("service", u.service), " ", h("span", { cls: "rw-muted", text: u.specimens + " specimens" })])]));
      });
      if (!res.items.length) grid.appendChild(h("li", { cls: "rw-empty", text: "No storage units yet." }));
      markCurrent();
    }, showError);
  },
  replaceRow: function () { if (current.view === "storage") storageList.render(); }
};

function excursionItem(e) {
  return h("li", null, [h("span", { cls: "rw-key", text: e.id }), h("span", null, ["Started ", timeEl(e.started_at)]), h("span", { cls: "rw-exc-meta", text: "Peak " + temp(e.peak_c) + " · " + e.duration_min + " min" })]);
}

function openUnit(id) {
  var seq = ++detailSeq;
  detailMessage("Storage unit", id, "Loading…");
  api("GET", "/svc/units/" + enc(id)).then(function (res) { if (seq === detailSeq) renderUnit(res); }, function (err) { if (seq === detailSeq) detailMessage("Storage unit", id, err.message); });
}

function renderUnit(res) {
  var u = res.unit;
  detailShell("Storage unit", u.id);
  var service = editable("Service status", u.service, pill("service", u.service), function () {
    var sel = h("select");
    ["normal", "service_requested"].forEach(function (v) { sel.appendChild(h("option", { value: v, text: lbl("service", v) })); });
    return sel;
  }, function (v) {
    return perform("Set the service status of " + u.id + " to " + lbl("service", v), function () {
      return api("PATCH", "/svc/units/" + enc(u.id), { field: "service", value: v, version: u.version });
    }, function () {
      toast("Service status updated");
      storageList.replaceRow();
      api("GET", "/svc/units/" + enc(u.id)).then(function (r) { if (current.view === "storage" && current.id === u.id) renderUnit(r); }, showError);
    });
  });
  var defs = [
    { key: "name", label: "Name", panel: "summary", value: u.name },
    { key: "location", label: "Location", panel: "summary", value: u.location },
    { key: "setpoint", label: "Setpoint", panel: "summary", value: temp(u.setpoint_c) },
    { key: "count", label: "Specimens stored", panel: "summary", value: String(res.specimens) },
    { key: "service", label: "Service status", panel: "handling", dd: service },
    { key: "updated", label: "Last changed", panel: "summary", value: timeEl(u.updated_at) }
  ];
  var log = h("ol", { cls: "rw-excursions" });
  var next = res.excursions.nextOffset;
  res.excursions.items.forEach(function (e) { log.appendChild(excursionItem(e)); });
  var more = button("Load more excursions", { onclick: function () {
    more.disabled = true;
    api("GET", "/svc/units/" + enc(u.id) + "/excursions" + qs({ offset: next })).then(function (p) { p.items.forEach(function (e) { log.appendChild(excursionItem(e)); }); next = p.nextOffset; more.hidden = next === null; more.disabled = false; }, function (err) { more.disabled = false; showError(err); });
  } });
  more.hidden = next === null;
  var excursions = h("section", { "aria-labelledby": "rw-exc-h" }, [h("h3", { id: "rw-exc-h", text: "Excursion log" }), h("p", { cls: "rw-hint", text: res.excursions.total + " recorded excursions, newest first." }), res.excursions.total ? log : h("p", { cls: "rw-muted", text: "No excursions recorded." }), more]);
  sections(shuffled(defs, CFG.shuffle), { actions: [], handling: [excursions] });
}

var LISTS = { specimens: specimenList, participants: participantList, storage: storageList };
var DETAILS = { specimens: openSpecimen, participants: openParticipant, storage: openUnit };

function applyConfig(cfg) {
  CFG = cfg;
  L = cfg.labels;
  current.view = null;
  renderFrame();
  route();
  syncInert();
  announce();
}

var announcing = false;
function announce() {
  var a = CFG.announce;
  if (!a || announcing) return;
  announcing = true;
  var d = dialog("What's new in Rimewell", function () { announcing = false; });
  d.body.appendChild(h("p", { text: a.text }));
  var ok = button("Got it", { primary: true, onclick: function () {
    document.cookie = a.cookie + "=" + enc(a.key) + "; path=/; SameSite=Lax";
    announcing = false;
    d.close();
  } });
  d.actions.appendChild(ok);
  ok.focus();
}

api("GET", "/svc/boot").then(function (cfg) {
  CFG = cfg;
  L = cfg.labels;
  renderFrame();
  window.addEventListener("hashchange", route);
  route();
  announce();
}, function (err) {
  clear(root);
  root.removeAttribute("aria-busy");
  root.appendChild(h("p", { cls: "rw-boot", role: "alert", text: err.message }));
});
})();
`;

export const SIGNIN_JS = String.raw`(function () {
"use strict";
var form = document.getElementById("rw-signin");
if (!form) return;
var stepA = document.getElementById("rw-step-account");
var stepB = document.getElementById("rw-step-secret");
var account = document.getElementById("rw-account");
var secret = document.getElementById("rw-secret");
var who = document.getElementById("rw-who");
var err = document.getElementById("rw-signin-error");
var btn = document.getElementById("rw-signin-btn");
var step = 1;
function show(n) { step = n; stepA.hidden = n !== 1; stepB.hidden = n !== 2; (n === 1 ? account : secret).focus(); }
function fail(m) { err.textContent = m; err.hidden = false; }
document.getElementById("rw-change").addEventListener("click", function () { err.hidden = true; secret.value = ""; show(1); });
form.addEventListener("submit", function (e) {
  e.preventDefault();
  err.hidden = true;
  if (step === 1) {
    var name = account.value.trim();
    if (!name) { fail("Enter your account name."); return; }
    who.textContent = name;
    show(2);
    return;
  }
  if (!secret.value) { fail("Enter your passphrase."); return; }
  var next = form.getAttribute("data-next") || "/";
  if (next === "/" && location.hash) next = "/" + location.hash;
  btn.disabled = true;
  fetch("/signin", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ account: account.value.trim(), passphrase: secret.value, next: next }) })
    .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { ok: r.ok, d: d }; }); })
    .then(function (res) {
      if (res.ok) { location.replace((res.d && res.d.next) || "/"); return; }
      btn.disabled = false;
      fail((res.d && res.d.message) || "Sign-in failed. Try again.");
      secret.select();
    }, function () { btn.disabled = false; fail("The registry could not be reached. Try again."); });
});
account.focus();
})();
`;
