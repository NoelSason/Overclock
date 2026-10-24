import { createServer, type Server } from "node:http";

/**
 * Mini fixture app with switchable UI variants that mirror the arena judge's "surprises":
 * renamed save button, reordered fields, confirmation modal after submit, announcement modal on
 * first view (page made inert), status field moved into a hidden tab, renamed field label, plus
 * deliberately ambiguous or unsafe variants that recovery must refuse to guess at.
 *
 * Copy-and-extend of mini-app.ts (which stays untouched for the runtime tests).
 */
export interface MiniVariants {
  /** Visible text of the edit form's submit button (default "Save"). */
  saveLabel?: string;
  /** Render the edit form's fields in reverse order. */
  reorderFields?: boolean;
  /** "Confirm changes" dialog after submit; the POST happens only after "Confirm". */
  confirmModal?: boolean;
  /** "What's new" dialog on first view per browser context; the page is inert until "Dismiss". */
  announcement?: boolean;
  /** Status select lives in a hidden "Status & ownership" tab panel. */
  statusInTab?: boolean;
  /** Label of the status select (default "Status"). */
  statusLabel?: string;
  /** A second POST form on the edit page whose submit has the same text as the edit form's. */
  duplicateSave?: boolean;
  /** After submit, a dialog whose only action is "Delete". */
  deleteOnlyDialog?: boolean;
  /** Two selects with identical options: "Current state" (the real status) and "State on reopen". */
  ambiguousStatus?: boolean;
}

export interface MiniItem {
  id: string;
  name: string;
  status: string;
  reopenStatus: string;
  notes: string[];
}

export interface MiniVariantApp {
  origin: string;
  items: Map<string, MiniItem>;
  variants: MiniVariants;
  /** Committed edit-form writes. */
  writes: number;
  /** Items removed through the delete dialog (must stay 0: recovery never confirms it). */
  deletes: number;
  setVariants(v: MiniVariants): void;
  reset(): void;
  close(): Promise<void>;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const CONFIRM_JS = `(function(){
var form=document.getElementById('edit-form');var bd=document.getElementById('confirm-backdrop');if(!form||!bd)return;
var page=document.getElementById('page');var ok=bd.querySelector('[data-confirm-ok]');var cancel=bd.querySelector('[data-confirm-cancel]');
var confirmed=false;
form.addEventListener('submit',function(e){if(confirmed)return;e.preventDefault();bd.hidden=false;if(page)page.inert=true;});
if(ok)ok.addEventListener('click',function(){confirmed=true;bd.hidden=true;if(page)page.inert=false;if(bd.getAttribute('data-action')){form.action=bd.getAttribute('data-action');}form.submit();});
if(cancel)cancel.addEventListener('click',function(){bd.hidden=true;if(page)page.inert=false;});
})();`;

const TABS_JS = `(function(){
var tabs=Array.prototype.slice.call(document.querySelectorAll('[role="tab"]'));
function select(tab){tabs.forEach(function(t){var on=t===tab;t.setAttribute('aria-selected',on?'true':'false');var p=document.getElementById(t.getAttribute('aria-controls'));if(p)p.hidden=!on;});}
tabs.forEach(function(tab){tab.addEventListener('click',function(){select(tab);});});
})();`;

const ANNOUNCE_JS = `(function(){
var bd=document.getElementById('news-backdrop');if(!bd)return;var page=document.getElementById('page');
bd.querySelector('[data-dismiss]').addEventListener('click',function(){document.cookie='mini_news=seen; path=/; SameSite=Lax';bd.hidden=true;if(page)page.inert=false;});
})();`;

const STATUS_OPTIONS = ["open", "closed", "archived"] as const;

export async function startMiniVariantApp(initial: MiniVariants = {}): Promise<MiniVariantApp> {
  const items = new Map<string, MiniItem>();
  const seed = () => {
    items.clear();
    for (let i = 1; i <= 12; i++) items.set(`I-${i}`, { id: `I-${i}`, name: `Item ${i}`, status: i % 3 === 0 ? "closed" : "open", reopenStatus: "open", notes: [] });
  };
  seed();
  const app: MiniVariantApp = {
    origin: "",
    items,
    variants: { ...initial },
    writes: 0,
    deletes: 0,
    setVariants: (v) => {
      app.variants = { ...v };
    },
    reset: () => {
      seed();
      app.writes = 0;
      app.deletes = 0;
    },
    close: async () => undefined,
  };

  const page = (v: MiniVariants, cookie: string, title: string, body: string, opts: { modals?: string; scripts?: string[] } = {}) => {
    const announce = v.announcement && !/(?:^|;\s*)mini_news=seen/.test(cookie);
    const news = announce
      ? `<div id="news-backdrop" style="position:fixed;inset:0;background:rgba(0,0,0,.35)"><div role="dialog" aria-modal="true" aria-labelledby="news-title" style="background:#fff;margin:80px auto;width:420px;padding:16px"><h2 id="news-title">What's new</h2><p>Items now show who last changed them.</p><button type="button" data-dismiss>Dismiss</button></div></div>`
      : "";
    const scripts = [...(opts.scripts ?? []), ...(announce ? [ANNOUNCE_JS] : [])].map((s) => `<script>${s}</script>`).join("");
    return `<!doctype html><html><head><title>${esc(title)}</title></head><body><div id="page"${announce ? " inert" : ""}><main><h1>${esc(title)}</h1>${body}</main></div>${opts.modals ?? ""}${news}${scripts}</body></html>`;
  };

  const select = (id: string, name: string, label: string, value: string) =>
    `<div class="field"><label for="${id}">${esc(label)}</label><select id="${id}" name="${name}">${STATUS_OPTIONS.map((o) => `<option value="${o}"${o === value ? " selected" : ""}>${o[0]!.toUpperCase()}${o.slice(1)}</option>`).join("")}</select></div>`;

  const editPage = (v: MiniVariants, cookie: string, item: MiniItem) => {
    const statusFields = v.ambiguousStatus
      ? [select("st", "status", "Current state", item.status), select("rs", "reopen_status", "State on reopen", item.reopenStatus)]
      : [select("st", "status", v.statusLabel ?? "Status", item.status)];
    const noteField = `<div class="field"><label for="nt">Add note</label><input id="nt" name="note" type="text"></div>`;
    let fields: string;
    const scripts: string[] = [];
    if (v.statusInTab) {
      scripts.push(TABS_JS);
      fields = `<div role="tablist" aria-label="Edit sections"><button type="button" role="tab" id="tab-details" aria-controls="panel-details" aria-selected="true">Details</button><button type="button" role="tab" id="tab-status" aria-controls="panel-status" aria-selected="false">Status &amp; ownership</button></div>
<div role="tabpanel" id="panel-details" aria-labelledby="tab-details"><div class="form-grid">${noteField}</div></div>
<div role="tabpanel" id="panel-status" aria-labelledby="tab-status" hidden><div class="form-grid">${statusFields.join("")}</div></div>`;
    } else {
      const ordered = [...statusFields, noteField];
      if (v.reorderFields) ordered.reverse();
      fields = `<div class="form-grid">${ordered.join("")}</div>`;
    }
    let modals = "";
    if (v.confirmModal) {
      scripts.push(CONFIRM_JS);
      modals = `<div id="confirm-backdrop" hidden style="position:fixed;inset:0;background:rgba(0,0,0,.35)"><div role="dialog" aria-modal="true" aria-labelledby="confirm-title" style="background:#fff;margin:80px auto;width:420px;padding:16px"><h2 id="confirm-title">Confirm changes</h2><p>Item ${esc(item.id)} will be updated with the values you entered.</p><button type="button" data-confirm-cancel>Cancel</button> <button type="button" data-confirm-ok>Confirm</button></div></div>`;
    } else if (v.deleteOnlyDialog) {
      scripts.push(CONFIRM_JS);
      modals = `<div id="confirm-backdrop" hidden data-action="/items/${esc(item.id)}/delete" style="position:fixed;inset:0;background:rgba(0,0,0,.35)"><div role="dialog" aria-modal="true" aria-labelledby="confirm-title" style="background:#fff;margin:80px auto;width:420px;padding:16px"><h2 id="confirm-title">Are you sure?</h2><p>Saving archives this item. To continue, remove it permanently.</p><button type="button" data-confirm-ok>Delete</button></div></div>`;
    }
    const quick = v.duplicateSave
      ? `<form method="post" action="/items/${esc(item.id)}/quick-note" id="quick-form"><div class="field"><label for="qn">Quick note</label><input id="qn" name="note" type="text"></div><button type="submit">${esc(v.saveLabel ?? "Save")}</button></form>`
      : "";
    const body = `<form method="post" action="/items/${esc(item.id)}/edit" id="edit-form">${fields}<div class="actions"><button type="submit">${esc(v.saveLabel ?? "Save")}</button> <a href="/items/${esc(item.id)}">Cancel</a></div></form>${quick}`;
    return page(v, cookie, `Edit ${item.id}`, body, { modals, scripts });
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const v = app.variants;
    const cookie = req.headers.cookie ?? "";
    const send = (status: number, html: string) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
      res.end(html);
    };
    const m = /^\/items\/([^/]+)(\/edit|\/quick-note|\/delete)?$/.exec(url.pathname);
    const item = m ? items.get(decodeURIComponent(m[1]!)) : undefined;
    const sub = m?.[2];
    if (req.method === "GET" && item && !sub) {
      const statusLabel = v.ambiguousStatus ? "Current state" : (v.statusLabel ?? "Status");
      send(
        200,
        page(v, cookie, `Item ${item.id}`, `<dl><dt>${esc(statusLabel)}</dt><dd data-testid="status">${item.status}</dd><dt>Notes</dt><dd data-testid="notes">${item.notes.map(esc).join(" | ")}</dd></dl><a href="/items/${item.id}/edit">Edit</a>`),
      );
      return;
    }
    if (req.method === "GET" && item && sub === "/edit") {
      send(200, editPage(v, cookie, item));
      return;
    }
    if (req.method === "POST" && item && sub) {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const form = new URLSearchParams(body);
        if (sub === "/delete") {
          items.delete(item.id);
          app.deletes++;
        } else if (sub === "/quick-note") {
          const note = form.get("note");
          if (note) item.notes.push(`quick: ${note}`);
        } else {
          item.status = form.get("status") ?? item.status;
          item.reopenStatus = form.get("reopen_status") ?? item.reopenStatus;
          const note = form.get("note");
          if (note) item.notes.push(note);
          app.writes++;
        }
        res.writeHead(303, { location: sub === "/delete" ? "/items" : `/items/${item.id}` });
        res.end();
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/items") {
      send(200, page(v, cookie, "Items", `<ul>${[...items.values()].map((i) => `<li><a href="/items/${i.id}">${i.id}</a></li>`).join("")}</ul>`));
      return;
    }
    send(404, page(v, cookie, "Not found", ""));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no address");
  app.origin = `http://127.0.0.1:${addr.port}`;
  app.close = () => new Promise((r) => server.close(() => r()));
  return app;
}
