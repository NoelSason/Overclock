import type { FastifyInstance } from "fastify";
import { field, hasField, parsePage, type AppKit } from "./app-server";
import { dateTimeEl, html } from "./html";
import { isEnum, labelOf, TICKET_CATEGORY, TICKET_OWNER, TICKET_STATUS } from "./labels";
import { badge, editForm, enumOptions, facts, flash, pager, searchForm, selectField, type FormField } from "./ui";

/** Helpwell Desk: ticket queue, ticket view with internal notes, and ticket edit form. */
export function registerSupport(f: FastifyInstance, kit: AppKit): void {
  const { store } = kit.ctx;

  f.get("/", async (_req, reply) => reply.redirect("/tickets", 302));

  f.get("/tickets", async (req, reply) => {
    const ui = kit.ui(req);
    const q = field(req.query, "q").trim();
    const statusParam = field(req.query, "status");
    const categoryParam = field(req.query, "category");
    const status = isEnum(TICKET_STATUS, statusParam) ? statusParam : "";
    const category = isEnum(TICKET_CATEGORY, categoryParam) ? categoryParam : "";
    const pageSize = kit.pageSize(ui);
    const res = store.support.list({ q: q || undefined, status: status || undefined, category: category || undefined, page: parsePage(field(req.query, "page")), pageSize });
    const from = res.total ? (res.page - 1) * pageSize + 1 : 0;
    const to = from + res.rows.length - (res.total ? 1 : 0);
    const rows = res.rows.length
      ? res.rows.map(
          (t) =>
            html`<tr><td><a class="id" href="/tickets/${encodeURIComponent(t.id)}">${t.id}</a></td><td class="id">${t.order_id}</td><td>${t.subject}</td><td>${labelOf(TICKET_CATEGORY, t.category)}</td><td>${badge(TICKET_STATUS, t.status)}</td><td>${t.owner}</td></tr>`,
        )
      : html`<tr><td colspan="6" class="empty">No tickets match these filters.</td></tr>`;
    const body = html`<div class="header-row"><div><h1>Tickets</h1><p class="lede">Customer conversations, most recently updated first.</p></div></div>
<div class="card">
${searchForm(ui, {
  action: "/tickets",
  searchLabel: "Search tickets",
  q,
  button: "Search",
  filters: [
    { id: "status", name: "status", label: "Status", allLabel: "All statuses", options: enumOptions(TICKET_STATUS), selected: status },
    { id: "category", name: "category", label: "Category", allLabel: "All categories", options: enumOptions(TICKET_CATEGORY), selected: category },
  ],
})}
<table><caption>${res.total} tickets${res.total ? ` · showing ${from}–${to}` : ""}</caption>
<thead><tr><th scope="col">Ticket</th><th scope="col">Order</th><th scope="col">Subject</th><th scope="col">Category</th><th scope="col">Status</th><th scope="col">Owner</th></tr></thead>
<tbody>${rows}</tbody></table>
${pager(ui, "/tickets", { q, status, category }, res.page, res.pages)}
</div>`;
    return kit.page(reply, ui, 200, { title: "Tickets", section: "/tickets", body });
  });

  f.get<{ Params: { id: string } }>("/tickets/:id", async (req, reply) => {
    const ui = kit.ui(req);
    const t = store.support.get(req.params.id);
    if (!t) return kit.error(reply, ui, 404, { title: "Ticket not found", message: `No ticket has the ID ${req.params.id}.`, links: [{ href: "/tickets", label: "All tickets" }] });
    const id = encodeURIComponent(t.id);
    const notes = store.support.notes(t.id);
    const flashText = field(req.query, "saved") === "1" ? "Ticket saved" : field(req.query, "noted") === "1" ? "Note added" : null;
    const noteList = notes.length
      ? html`<ul class="notes">${notes.map((n) => html`<li><p class="note-body">${n.body}</p>${dateTimeEl(n.created_at)}</li>`)}</ul>`
      : html`<p class="muted">No internal notes yet.</p>`;
    const body = html`<a class="back" href="/tickets"><span aria-hidden="true">← </span>${ui.t("All tickets")}</a>
${flash(flashText)}
<div class="header-row"><div><p class="eyebrow">Ticket ${t.id}</p><h1>${t.subject}</h1></div>
<a class="button-link" href="/tickets/${id}/edit">${ui.t("Edit ticket")}</a></div>
<div class="ticket-grid">
<div>
<section class="card" aria-labelledby="h-message"><h2 id="h-message" style="margin-top:0">Customer message</h2><blockquote class="message">${t.body}</blockquote></section>
<section class="card" aria-labelledby="h-notes"><h2 id="h-notes" style="margin-top:0">Internal notes</h2>${noteList}
<form method="post" action="/tickets/${id}/notes">
<h3 class="eyebrow">Add internal note</h3>
<div class="field"><label for="note">Note</label><textarea id="note" name="body" rows="3" required></textarea></div>
<button type="submit" class="primary">${ui.t("Add note")}</button>
</form></section>
</div>
<section class="card ticket-side" aria-labelledby="h-details"><h2 id="h-details" style="margin-top:0">Ticket details</h2>${facts([
      ["Ticket ID", t.id],
      ["Order ID", t.order_id],
      ["Customer email", t.customer_email],
      ["Category", labelOf(TICKET_CATEGORY, t.category)],
      ["Status", labelOf(TICKET_STATUS, t.status)],
      ["Owner", t.owner],
    ])}</section>
</div>`;
    return kit.page(reply, ui, 200, { title: `${t.id} · ${t.subject}`, section: "/tickets", body });
  });

  f.post<{ Params: { id: string } }>("/tickets/:id/notes", async (req, reply) => {
    const ui = kit.ui(req);
    const t = store.support.get(req.params.id);
    if (!t) return kit.error(reply, ui, 404, { title: "Ticket not found", message: `No ticket has the ID ${req.params.id}.`, links: [{ href: "/tickets", label: "All tickets" }] });
    const id = encodeURIComponent(t.id);
    const text = field(req.body, "body").trim();
    if (!text) return kit.error(reply, ui, 400, { title: "Note is empty", message: "Write a note before adding it.", links: [{ href: `/tickets/${id}`, label: "Back to ticket" }] });
    // Notes are append-only: no version check, so a retried POST adds a second copy.
    if (!kit.guardedWrite(reply, ui, () => void store.support.addNote(t.id, text))) return reply;
    return reply.redirect(`/tickets/${id}?noted=1`, 303);
  });

  f.get<{ Params: { id: string } }>("/tickets/:id/edit", async (req, reply) => {
    const ui = kit.ui(req);
    const t = store.support.get(req.params.id);
    if (!t) return kit.error(reply, ui, 404, { title: "Ticket not found", message: `No ticket has the ID ${req.params.id}.`, links: [{ href: "/tickets", label: "All tickets" }] });
    const id = encodeURIComponent(t.id);
    const fields: FormField[] = [
      { name: "category", panel: "status", html: selectField("category", "Category", TICKET_CATEGORY, t.category) },
      { name: "status", panel: "status", html: selectField("status", "Status", TICKET_STATUS, t.status) },
      { name: "owner", panel: "status", html: selectField("owner", "Owner", TICKET_OWNER, t.owner) },
    ];
    const form = editForm(ui, {
      action: `/tickets/${id}/edit`,
      version: t.version,
      fields,
      submit: "Save ticket",
      cancelHref: `/tickets/${id}`,
      summary: `Ticket ${t.id} will be updated with the values you entered.`,
      detailsIntro: facts([
        ["Ticket ID", t.id],
        ["Subject", t.subject],
        ["Customer email", t.customer_email],
      ]),
    });
    const body = html`<div class="header-row"><div><p class="eyebrow">Ticket ${t.id}</p><h1>Edit ticket</h1><p class="lede">${t.subject}</p></div></div>
<div class="card">${form.body}</div>`;
    return kit.page(reply, ui, 200, { title: `Edit ${t.id}`, section: "/tickets", body, modals: form.modals, scripts: form.scripts });
  });

  f.post<{ Params: { id: string } }>("/tickets/:id/edit", async (req, reply) => {
    const ui = kit.ui(req);
    const cur = store.support.get(req.params.id);
    if (!cur) return kit.error(reply, ui, 404, { title: "Ticket not found", message: `No ticket has the ID ${req.params.id}.`, links: [{ href: "/tickets", label: "All tickets" }] });
    const id = encodeURIComponent(cur.id);
    const editHref = `/tickets/${id}/edit`;
    const b = req.body;
    const category = hasField(b, "category") ? field(b, "category") : cur.category;
    const status = hasField(b, "status") ? field(b, "status") : cur.status;
    const owner = hasField(b, "owner") ? field(b, "owner") : cur.owner;
    const back = [{ href: editHref, label: "Back to edit form" }];
    if (!isEnum(TICKET_CATEGORY, category)) return kit.error(reply, ui, 400, { title: "Invalid category", message: `“${category}” is not a valid category.`, links: back });
    if (!isEnum(TICKET_STATUS, status)) return kit.error(reply, ui, 400, { title: "Invalid status", message: `“${status}” is not a valid ticket status.`, links: back });
    if (!isEnum(TICKET_OWNER, owner)) return kit.error(reply, ui, 400, { title: "Invalid owner", message: `“${owner}” is not a valid owner.`, links: back });
    const version = Number(field(b, "version"));
    if (!Number.isInteger(version) || version !== cur.version) {
      return kit.conflict(reply, ui, "This ticket changed since you opened it. Reload and try again.", editHref);
    }
    if (!kit.guardedWrite(reply, ui, () => void store.support.update(cur.id, { category, status, owner }))) return reply;
    return reply.redirect(`/tickets/${id}?saved=1`, 303);
  });
}
