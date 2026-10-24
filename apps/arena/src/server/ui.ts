import type { VariationConfig } from "@overclock/contracts";
import { Rng } from "../data/rng";
import { html, raw, SafeHtml, type Interpolation } from "./html";
import type { EnumSpec } from "./labels";
import { appCss, themeClass } from "./themes";
import type { AppName } from "./variations";

/** Product identity for each app. Names are invented; none refer to a real company. */
export interface AppBrand {
  app: AppName;
  name: string;
  home: string;
  cookie: string;
  nav: { href: string; label: string }[];
  whatsNew: string;
  loginTagline: string;
}

export const BRANDS: Record<AppName, AppBrand> = {
  CRM: {
    app: "CRM",
    name: "Ledgerline CRM",
    home: "/customers",
    cookie: "ledgerline_session",
    nav: [
      { href: "/customers", label: "Customers" },
      { href: "/import", label: "Bulk status import" },
    ],
    whatsNew: "Customer profiles now show the last time each account was updated. Bulk status import also accepts status names such as “On hold”.",
    loginTagline: "Every customer relationship, on one ledger.",
  },
  Orders: {
    app: "Orders",
    name: "Parcelpoint Orders",
    home: "/orders",
    cookie: "parcelpoint_session",
    nav: [{ href: "/orders", label: "Orders" }],
    whatsNew: "You can now filter the order list by customer, and review flags are shown on every order page.",
    loginTagline: "Track every parcel from checkout to doorstep.",
  },
  Support: {
    app: "Support",
    name: "Helpwell Desk",
    home: "/tickets",
    cookie: "helpwell_session",
    nav: [{ href: "/tickets", label: "Tickets" }],
    whatsNew: "Internal notes now keep their timestamps, and you can filter tickets by category.",
    loginTagline: "Help every customer feel heard.",
  },
};

/** Per-request rendering context: the variation snapshot and session-specific bits. */
export interface Ui {
  app: AppName;
  brand: AppBrand;
  v: VariationConfig;
  /** Visible text of a button or link, after the renameButtons variation. */
  t: (text: string) => string;
  /** Set when the "What's new" overlay must be shown on this page view. */
  announce: { cookie: string; key: string } | null;
  username: string;
}

// ---------------------------------------------------------------------------------------------
// Inline scripts (constants only; page data reaches them through escaped data-* attributes).

const CONFIRM_JS = `(function(){
var form=document.getElementById('edit-form');var bd=document.getElementById('confirm-backdrop');if(!form||!bd)return;
var page=document.getElementById('page');var ok=bd.querySelector('[data-confirm-ok]');var cancel=bd.querySelector('[data-confirm-cancel]');
var confirmed=false;var opener=null;
function close(){bd.hidden=true;if(page)page.inert=false;if(opener&&opener.focus)opener.focus();}
form.addEventListener('submit',function(e){if(confirmed)return;e.preventDefault();opener=e.submitter||document.activeElement;bd.hidden=false;if(page)page.inert=true;ok.focus();});
ok.addEventListener('click',function(){confirmed=true;ok.disabled=true;bd.hidden=true;if(page)page.inert=false;form.submit();});
cancel.addEventListener('click',close);
bd.addEventListener('keydown',function(e){if(e.key==='Escape'){e.preventDefault();close();}});
})();`;

const TABS_JS = `(function(){
var lists=document.querySelectorAll('[role="tablist"]');
lists.forEach(function(list){
var tabs=Array.prototype.slice.call(list.querySelectorAll('[role="tab"]'));
function select(tab){tabs.forEach(function(t){var on=t===tab;t.setAttribute('aria-selected',on?'true':'false');t.tabIndex=on?0:-1;var p=document.getElementById(t.getAttribute('aria-controls'));if(p)p.hidden=!on;});}
tabs.forEach(function(tab,i){
tab.addEventListener('click',function(){select(tab);});
tab.addEventListener('keydown',function(e){var d=e.key==='ArrowRight'?1:e.key==='ArrowLeft'?-1:0;if(!d)return;e.preventDefault();var n=tabs[(i+d+tabs.length)%tabs.length];select(n);n.focus();});
});
});
})();`;

const ANNOUNCE_JS = `(function(){
var bd=document.getElementById('news-backdrop');if(!bd)return;var page=document.getElementById('page');
var btn=bd.querySelector('[data-dismiss]');if(btn)btn.focus();
btn.addEventListener('click',function(){
document.cookie=bd.getAttribute('data-cookie')+'='+encodeURIComponent(bd.getAttribute('data-key'))+'; path=/; SameSite=Lax';
bd.hidden=true;if(page)page.inert=false;
});
})();`;

export const SCRIPTS = { confirm: CONFIRM_JS, tabs: TABS_JS, announce: ANNOUNCE_JS } as const;
export type ScriptName = keyof typeof SCRIPTS;

// ---------------------------------------------------------------------------------------------
// Document shell and per-app chrome.

function head(ui: Pick<Ui, "app" | "brand">, title: string): SafeHtml {
  return html`<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · ${ui.brand.name}</title><link rel="icon" href="data:,"><style>${raw(appCss(ui.app))}</style></head>`;
}

function navList(ui: Ui, section: string | undefined): SafeHtml {
  return html`<ul>${ui.brand.nav.map((n) => html`<li><a href="${n.href}"${n.href === section ? raw(' aria-current="page"') : ""}>${ui.t(n.label)}</a></li>`)}</ul>`;
}

function initials(name: string): string {
  return name.slice(0, 2).toUpperCase();
}

function chrome(ui: Ui, section: string | undefined, main: SafeHtml): SafeHtml {
  const signOut = html`<a href="/logout">${ui.t("Sign out")}</a>`;
  switch (ui.app) {
    case "CRM":
      return html`<header class="topbar"><div class="topbar-inner">
<a class="brand" href="${ui.brand.home}"><span class="brand-mark" aria-hidden="true">L</span>Ledgerline<span class="brand-sub">CRM</span></a>
<nav aria-label="Primary">${navList(ui, section)}</nav>
<div class="user"><span class="avatar" aria-hidden="true">${initials(ui.username)}</span><span>${ui.username}</span>${signOut}</div>
</div></header>
<main id="main" class="wrap">${main}</main>
<footer class="foot">Ledgerline CRM · Northgate Supply Co. workspace</footer>`;
    case "Orders":
      return html`<div class="pp-shell">
<aside class="sidebar">
<a class="brand" href="${ui.brand.home}"><svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true"><rect x="1" y="1" width="24" height="24" rx="6" fill="#ea580c"/><path d="M7 9.5 13 6l6 3.5v7L13 20l-6-3.5z" fill="none" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"/><path d="M7 9.5 13 13l6-3.5M13 13v7" fill="none" stroke="#fff" stroke-width="1.8"/></svg>Parcelpoint</a>
<nav aria-label="Primary"><p class="nav-heading">Fulfillment</p>${navList(ui, section)}</nav>
<div class="user"><span>Signed in as <strong>${ui.username}</strong></span>${signOut}</div>
</aside>
<div class="pp-content">
<div class="pp-top"><span class="crumb">Parcelpoint Orders</span><span aria-hidden="true">/</span><span>Fulfillment workspace</span></div>
<main id="main" class="pp-main">${main}</main>
</div>
</div>`;
    case "Support":
      return html`<header class="hw-top">
<a class="brand" href="${ui.brand.home}"><span class="brand-dot" aria-hidden="true"></span>Helpwell <small>DESK</small></a>
<nav aria-label="Primary">${navList(ui, section)}</nav>
<div class="user"><span>${ui.username}</span>${signOut}</div>
</header>
<main id="main" class="hw-main">${main}</main>`;
  }
}

function announcement(ui: Ui): SafeHtml {
  if (!ui.announce) return html``;
  return html`<div class="modal-backdrop" id="news-backdrop" data-cookie="${ui.announce.cookie}" data-key="${ui.announce.key}">
<div class="modal" role="dialog" aria-modal="true" aria-labelledby="news-title" aria-describedby="news-desc">
<h2 id="news-title">What's new</h2>
<p id="news-desc">${ui.brand.whatsNew}</p>
<div class="modal-actions"><button type="button" class="primary" data-dismiss>${ui.t("Dismiss")}</button></div>
</div></div>`;
}

export interface PageOptions {
  title: string;
  /** Primary-nav href to mark as current. */
  section?: string;
  body: SafeHtml;
  modals?: SafeHtml;
  scripts?: ScriptName[];
}

export function renderPage(ui: Ui, opts: PageOptions): string {
  const scripts = new Set<ScriptName>(opts.scripts ?? []);
  if (ui.announce) scripts.add("announce");
  const inert = ui.announce ? raw(" inert") : "";
  return html`<!doctype html><html lang="en">${head(ui, opts.title)}<body class="app-${ui.app.toLowerCase()} ${themeClass(ui.v.theme)}">
<div id="page"${inert}>${chrome(ui, opts.section, opts.body)}</div>
${opts.modals ?? ""}${announcement(ui)}
${[...scripts].map((s) => html`<script>${raw(SCRIPTS[s])}</script>`)}
</body></html>`.value;
}

/** Login page (no session yet, so no nav and no announcement). */
export function renderLogin(ui: Ui, opts: { next: string; username: string; error: string | null }): string {
  const err = opts.error ? html`<div class="alert" role="alert"><strong>Sign-in failed</strong>${opts.error}</div>` : "";
  const form = html`<form method="post" class="login-form">
<input type="hidden" name="next" value="${opts.next}">
<div class="field"><label for="username">Username</label><input type="text" id="username" name="username" autocomplete="username" value="${opts.username}" required></div>
<div class="field"><label for="password">Password</label><input type="password" id="password" name="password" autocomplete="current-password" required></div>
<button type="submit" class="primary">${ui.t("Sign in")}</button>
</form>`;
  let body: SafeHtml;
  switch (ui.app) {
    case "CRM":
      body = html`<div class="login-band"></div><main id="main" class="login-card">
<div class="brand"><span class="brand-mark" aria-hidden="true">L</span>Ledgerline<span class="brand-sub">CRM</span></div>
<h1>Sign in</h1><p class="muted">${ui.brand.loginTagline}</p>${err}${form}</main>`;
      break;
    case "Orders":
      body = html`<div class="login-split"><div class="login-art" aria-hidden="true"><div class="brand"><svg width="30" height="30" viewBox="0 0 26 26"><rect x="1" y="1" width="24" height="24" rx="6" fill="#ea580c"/><path d="M7 9.5 13 6l6 3.5v7L13 20l-6-3.5z" fill="none" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"/></svg>Parcelpoint</div><p>${ui.brand.loginTagline}</p></div>
<main id="main" class="login-pane"><div class="inner"><h1>Sign in to Parcelpoint</h1><p class="muted">Use your fulfillment workspace account.</p>${err}${form}</div></main></div>`;
      break;
    case "Support":
      body = html`<div class="login-bg"><main id="main" class="login-card">
<div class="brand"><span class="brand-dot" aria-hidden="true"></span>Helpwell <small>DESK</small></div>
<h1>Welcome back</h1><p class="muted">${ui.brand.loginTagline}</p>${err}${form}</main></div>`;
      break;
  }
  return html`<!doctype html><html lang="en">${head(ui, "Sign in")}<body class="app-${ui.app.toLowerCase()} ${themeClass(ui.v.theme)}"><div id="page">${body}</div></body></html>`.value;
}

// ---------------------------------------------------------------------------------------------
// Components.

export function flash(text: string | null): SafeHtml {
  return text ? html`<div class="flash" role="status">${text}</div>` : html``;
}

/** Read-only facts as `<dt>Label</dt><dd>value</dd>` pairs; empty values render as an em dash. */
export function facts(pairs: readonly (readonly [string, Interpolation])[]): SafeHtml {
  const empty = (v: Interpolation) => v === "" || v === null || v === undefined || (v instanceof SafeHtml && v.value === "");
  return html`<dl class="facts">${pairs.map(([k, v]) => html`<dt>${k}</dt><dd>${empty(v) ? "—" : v}</dd>`)}</dl>`;
}

const TONES: Record<string, string> = {
  active: "good",
  vip: "star",
  on_hold: "warn",
  processing: "info",
  shipped: "info",
  delivered: "good",
  refunded: "warn",
  cancelled: "bad",
  open: "info",
  pending: "warn",
  resolved: "good",
  escalated: "bad",
};

export function badge<T extends string>(spec: EnumSpec<T>, value: string): SafeHtml {
  const label = (spec.labels as Record<string, string>)[value] ?? value;
  const tone = TONES[value];
  return html`<span class="badge${tone ? ` tone-${tone}` : ""}">${label}</span>`;
}

export interface FilterSpec {
  id: string;
  name: string;
  label: string;
  allLabel: string;
  options: readonly { value: string; label: string }[];
  selected: string;
}

export function enumOptions<T extends string>(spec: EnumSpec<T>): { value: string; label: string }[] {
  return spec.values.map((v) => ({ value: v, label: spec.labels[v] }));
}

export function searchForm(
  ui: Ui,
  opts: { action: string; searchLabel: string; q: string; button: string; filters: FilterSpec[]; extra?: { id: string; name: string; label: string; value: string }[] },
): SafeHtml {
  return html`<form method="get" action="${opts.action}" class="toolbar" role="search">
<div class="field grow"><label for="q">${opts.searchLabel}</label><input type="search" id="q" name="q" value="${opts.q}"></div>
${(opts.extra ?? []).map((x) => html`<div class="field"><label for="${x.id}">${x.label}</label><input type="text" id="${x.id}" name="${x.name}" value="${x.value}"></div>`)}
${opts.filters.map(
  (f) => html`<div class="field"><label for="${f.id}">${f.label}</label><select id="${f.id}" name="${f.name}"><option value="">${f.allLabel}</option>${f.options.map(
    (o) => html`<option value="${o.value}"${o.value === f.selected ? raw(" selected") : ""}>${o.label}</option>`,
  )}</select></div>`,
)}
<button type="submit">${ui.t(opts.button)}</button>
</form>`;
}

/** "Previous" / "Next" links (or aria-disabled spans) plus "Page X of Y". */
export function pager(ui: Ui, path: string, params: Record<string, string>, page: number, pages: number): SafeHtml {
  const href = (p: number) => {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) sp.set(k, v);
    if (p > 1) sp.set("page", String(p));
    const qs = sp.toString();
    return qs ? `${path}?${qs}` : path;
  };
  const prev = page > 1 ? html`<a href="${href(page - 1)}" rel="prev">${ui.t("Previous")}</a>` : html`<span aria-disabled="true">${ui.t("Previous")}</span>`;
  const next = page < pages ? html`<a href="${href(page + 1)}" rel="next">${ui.t("Next")}</a>` : html`<span aria-disabled="true">${ui.t("Next")}</span>`;
  return html`<nav aria-label="Pagination" class="pager">${prev}<span class="pageinfo">Page ${page} of ${pages}</span>${next}</nav>`;
}

export function errorBody(ui: Ui, opts: { title: string; message: string; links?: { href: string; label: string }[] }): SafeHtml {
  return html`<h1>${opts.title}</h1><div class="alert" role="alert">${opts.message}</div>
<p>${(opts.links ?? [{ href: ui.brand.home, label: "Go to start page" }]).map((l, i) => html`${i ? " · " : ""}<a href="${l.href}">${ui.t(l.label)}</a>`)}</p>`;
}

// ---------------------------------------------------------------------------------------------
// Edit forms: shuffle, tabs, and confirmation modal variations live here.

export interface FormField {
  name: string;
  /** "status" fields move to the "Status & ownership" tab when editInTab is on. */
  panel: "details" | "status";
  html: SafeHtml;
}

export function textField(name: string, label: string, value: string, opts: { required?: boolean } = {}): SafeHtml {
  return html`<div class="field"><label for="f-${name}">${label}</label><input type="text" id="f-${name}" name="${name}" value="${value}"${opts.required ? raw(" required") : ""}></div>`;
}

export function selectField<T extends string>(name: string, label: string, spec: EnumSpec<T>, selected: string): SafeHtml {
  return html`<div class="field"><label for="f-${name}">${label}</label><select id="f-${name}" name="${name}">${spec.values.map(
    (v) => html`<option value="${v}"${v === selected ? raw(" selected") : ""}>${spec.labels[v]}</option>`,
  )}</select></div>`;
}

export function checkboxField(name: string, label: string, checked: boolean): SafeHtml {
  return html`<div class="field field-check"><input type="checkbox" id="f-${name}" name="${name}" value="1"${checked ? raw(" checked") : ""}><label for="f-${name}">${label}</label></div>`;
}

/** Deterministic, never-identity shuffle for the shuffleFields variation. */
export function shuffleFields<T>(items: readonly T[], seed: number): T[] {
  if (!seed || items.length < 2) return [...items];
  const out = new Rng(seed).shuffle([...items]);
  if (out.every((x, i) => x === items[i])) out.push(out.shift()!);
  return out;
}

export interface EditFormResult {
  body: SafeHtml;
  modals: SafeHtml;
  scripts: ScriptName[];
}

export function editForm(
  ui: Ui,
  opts: { action: string; version: number; fields: FormField[]; submit: string; cancelHref: string; summary: string; detailsIntro?: SafeHtml },
): EditFormResult {
  const fields = shuffleFields(opts.fields, ui.v.shuffleFields[ui.app] ?? 0);
  const inTab = ui.v.editInTab[ui.app] === true;
  const confirm = ui.v.confirmModal[ui.app] === true;
  const scripts: ScriptName[] = [];
  let inner: SafeHtml;
  if (inTab) {
    scripts.push("tabs");
    const details = fields.filter((f) => f.panel === "details");
    const status = fields.filter((f) => f.panel === "status");
    inner = html`<div role="tablist" aria-label="Edit sections">
<button type="button" role="tab" id="tab-details" aria-controls="panel-details" aria-selected="true">${ui.t("Details")}</button>
<button type="button" role="tab" id="tab-status" aria-controls="panel-status" aria-selected="false" tabindex="-1">${ui.t("Status & ownership")}</button>
</div>
<div role="tabpanel" id="panel-details" aria-labelledby="tab-details">${opts.detailsIntro ?? ""}<div class="form-grid">${details.map((f) => f.html)}</div></div>
<div role="tabpanel" id="panel-status" aria-labelledby="tab-status" hidden><div class="form-grid">${status.map((f) => f.html)}</div></div>`;
  } else {
    inner = html`<div class="form-grid">${fields.map((f) => f.html)}</div>`;
  }
  let modals = html``;
  if (confirm) {
    scripts.push("confirm");
    modals = html`<div class="modal-backdrop" id="confirm-backdrop" hidden>
<div class="modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-desc">
<h2 id="confirm-title">Confirm changes</h2>
<p id="confirm-desc">${opts.summary}</p>
<div class="modal-actions"><button type="button" data-confirm-cancel>${ui.t("Cancel")}</button><button type="button" class="primary" data-confirm-ok>${ui.t("Confirm")}</button></div>
</div></div>`;
  }
  const body = html`<form method="post" action="${opts.action}" id="edit-form">
<input type="hidden" name="version" value="${opts.version}">
${inner}
<div class="actions"><button type="submit" class="primary">${ui.t(opts.submit)}</button><a href="${opts.cancelHref}">${ui.t("Cancel")}</a></div>
</form>`;
  return { body, modals, scripts };
}
