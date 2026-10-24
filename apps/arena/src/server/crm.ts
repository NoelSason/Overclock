import type { FastifyInstance } from "fastify";
import type { CustomerStatus } from "../data/model";
import { field, hasField, parsePage, type AppKit } from "./app-server";
import { dateTimeEl, html } from "./html";
import { CUSTOMER_STATUS, isEnum, labelOf, parseEnumLenient } from "./labels";
import { badge, editForm, enumOptions, facts, flash, pager, searchForm, selectField, textField, type FormField, type Ui } from "./ui";

/** Ledgerline CRM: customer list, profile, edit form, and bulk status import. */
export function registerCrm(f: FastifyInstance, kit: AppKit): void {
  const { store } = kit.ctx;

  f.get("/", async (_req, reply) => reply.redirect("/customers", 302));

  f.get("/customers", async (req, reply) => {
    const ui = kit.ui(req);
    const q = field(req.query, "q").trim();
    const statusParam = field(req.query, "status");
    const status = isEnum(CUSTOMER_STATUS, statusParam) ? statusParam : "";
    const pageSize = kit.pageSize(ui);
    const res = store.crm.list({ q: q || undefined, status: status || undefined, page: parsePage(field(req.query, "page")), pageSize });
    const from = res.total ? (res.page - 1) * pageSize + 1 : 0;
    const to = from + res.rows.length - (res.total ? 1 : 0);
    const rows = res.rows.length
      ? res.rows.map(
          (c) => html`<tr><td><a class="id" href="/customers/${encodeURIComponent(c.id)}">${c.id}</a></td><td>${c.name}</td><td>${c.email}</td><td>${badge(CUSTOMER_STATUS, c.status)}</td></tr>`,
        )
      : html`<tr><td colspan="4" class="empty">No customers match your search.</td></tr>`;
    const body = html`<div class="header-row"><div><h1>Customers</h1><p class="lede">Every account in the Northgate Supply workspace.</p></div></div>
<section class="card" aria-labelledby="customers-caption">
${searchForm(ui, {
  action: "/customers",
  searchLabel: "Search customers",
  q,
  button: "Search",
  filters: [{ id: "status", name: "status", label: "Status", allLabel: "All statuses", options: enumOptions(CUSTOMER_STATUS), selected: status }],
})}
<table><caption id="customers-caption">${res.total} customers${res.total ? ` · showing ${from}–${to}` : ""}</caption>
<thead><tr><th scope="col">Customer ID</th><th scope="col">Name</th><th scope="col">Email</th><th scope="col">Status</th></tr></thead>
<tbody>${rows}</tbody></table>
${pager(ui, "/customers", { q, status }, res.page, res.pages)}
</section>`;
    return kit.page(reply, ui, 200, { title: "Customers", section: "/customers", body });
  });

  f.get<{ Params: { id: string } }>("/customers/:id", async (req, reply) => {
    const ui = kit.ui(req);
    const c = store.crm.get(req.params.id);
    if (!c) return kit.error(reply, ui, 404, { title: "Customer not found", message: `No customer has the ID ${req.params.id}.`, links: [{ href: "/customers", label: "All customers" }] });
    const id = encodeURIComponent(c.id);
    const body = html`<a class="back" href="/customers"><span aria-hidden="true">← </span>${ui.t("All customers")}</a>
${flash(field(req.query, "saved") === "1" ? "Customer saved" : null)}
<div class="header-row"><div><p class="eyebrow">Customer</p><h1>${c.name}</h1><p class="lede">${c.city} · ${labelOf(CUSTOMER_STATUS, c.status)}</p></div>
<a class="button-link" href="/customers/${id}/edit">${ui.t("Edit customer")}</a></div>
<section class="card" aria-labelledby="profile-heading"><h2 id="profile-heading" style="margin-top:0">Profile</h2>
${facts([
  ["Customer ID", c.id],
  ["Name", c.name],
  ["Email", c.email],
  ["Phone", c.phone],
  ["City", c.city],
  ["Status", labelOf(CUSTOMER_STATUS, c.status)],
  ["Version", c.version],
  ["Last updated", dateTimeEl(c.updated_at)],
])}
</section>`;
    return kit.page(reply, ui, 200, { title: c.name, section: "/customers", body });
  });

  f.get<{ Params: { id: string } }>("/customers/:id/edit", async (req, reply) => {
    const ui = kit.ui(req);
    const c = store.crm.get(req.params.id);
    if (!c) return kit.error(reply, ui, 404, { title: "Customer not found", message: `No customer has the ID ${req.params.id}.`, links: [{ href: "/customers", label: "All customers" }] });
    const id = encodeURIComponent(c.id);
    const fields: FormField[] = [
      { name: "name", panel: "details", html: textField("name", "Name", c.name, { required: true }) },
      { name: "email", panel: "details", html: textField("email", "Email", c.email, { required: true }) },
      { name: "phone", panel: "details", html: textField("phone", "Phone", c.phone) },
      { name: "city", panel: "details", html: textField("city", "City", c.city) },
      { name: "status", panel: "status", html: selectField("status", "Status", CUSTOMER_STATUS, c.status) },
    ];
    const form = editForm(ui, {
      action: `/customers/${id}/edit`,
      version: c.version,
      fields,
      submit: "Save changes",
      cancelHref: `/customers/${id}`,
      summary: `Customer ${c.id} (${c.name}) will be updated with the values you entered.`,
    });
    const body = html`<div class="header-row"><div><p class="eyebrow">Customer ${c.id}</p><h1>Edit customer</h1><p class="lede">${c.name}</p></div></div>
<section class="card">${form.body}</section>`;
    return kit.page(reply, ui, 200, { title: `Edit ${c.name}`, section: "/customers", body, modals: form.modals, scripts: form.scripts });
  });

  f.post<{ Params: { id: string } }>("/customers/:id/edit", async (req, reply) => {
    const ui = kit.ui(req);
    const cur = store.crm.get(req.params.id);
    if (!cur) return kit.error(reply, ui, 404, { title: "Customer not found", message: `No customer has the ID ${req.params.id}.`, links: [{ href: "/customers", label: "All customers" }] });
    const id = encodeURIComponent(cur.id);
    const editHref = `/customers/${id}/edit`;
    const b = req.body;
    const statusIn = hasField(b, "status") ? field(b, "status") : cur.status;
    if (!isEnum(CUSTOMER_STATUS, statusIn)) {
      return kit.error(reply, ui, 400, { title: "Invalid status", message: `“${statusIn}” is not a valid customer status.`, links: [{ href: editHref, label: "Back to edit form" }] });
    }
    const pick = (k: "name" | "email" | "phone" | "city") => (hasField(b, k) ? field(b, k).trim() : cur[k]);
    const next = { name: pick("name"), email: pick("email"), phone: pick("phone"), city: pick("city"), status: statusIn };
    if (!next.name || !next.email) {
      return kit.error(reply, ui, 400, { title: "Missing information", message: "Name and email are required.", links: [{ href: editHref, label: "Back to edit form" }] });
    }
    const version = Number(field(b, "version"));
    if (!Number.isInteger(version) || version !== cur.version) {
      return kit.conflict(reply, ui, "This customer changed since you opened it. Reload and try again.", editHref);
    }
    if (!kit.guardedWrite(reply, ui, () => void store.crm.update(cur.id, next))) return reply;
    return reply.redirect(`/customers/${id}?saved=1`, 303);
  });

  const importForm = (ui: Ui) => html`<form method="post" action="/import">
<div class="field"><label for="csv">CSV rows</label><textarea id="csv" name="csv" class="mono" rows="10" placeholder="C-1001,on_hold" spellcheck="false"></textarea></div>
<div class="actions"><button type="submit" class="primary">${ui.t("Run import")}</button></div>
</form>`;
  const importIntro = html`<div class="header-row"><div><h1>Bulk status import</h1><p class="lede">Paste one <code>customer_id,status</code> pair per line. Status can be written as a value (<code>on_hold</code>) or a name (<code>On hold</code>).</p></div></div>`;

  f.get("/import", async (req, reply) => {
    const ui = kit.ui(req);
    const body = html`${importIntro}<section class="card">${importForm(ui)}</section>`;
    return kit.page(reply, ui, 200, { title: "Bulk status import", section: "/import", body });
  });

  f.post("/import", async (req, reply) => {
    const ui = kit.ui(req);
    const lines = field(req.body, "csv")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    const results: { id: string; result: string }[] = [];
    const valid: { id: string; status: CustomerStatus; row: number }[] = [];
    const unquote = (s: string) => s.trim().replace(/^"(.*)"$/, "$1").trim();
    lines.forEach((line, i) => {
      if (i === 0 && /^customer[_ ]?id\s*,\s*status$/i.test(line)) return;
      const comma = line.indexOf(",");
      if (comma < 0) {
        results.push({ id: line, result: "Expected customer_id,status" });
        return;
      }
      const id = unquote(line.slice(0, comma));
      const statusText = unquote(line.slice(comma + 1));
      const status = parseEnumLenient(CUSTOMER_STATUS, statusText);
      if (!id) results.push({ id: "", result: "Missing customer ID" });
      else if (!status) results.push({ id, result: `Unknown status “${statusText}”` });
      else {
        valid.push({ id, status, row: results.length });
        results.push({ id, result: "" });
      }
    });
    if (valid.length) {
      const ok = kit.guardedWrite(reply, ui, () => {
        const out = store.crm.bulkSetStatus(valid.map(({ id, status }) => ({ id, status })));
        out.forEach((r, i) => {
          const slot = results[valid[i]!.row];
          if (slot) slot.result = r.ok ? "Updated" : (r.error ?? "Failed");
        });
      });
      if (!ok) return reply;
    }
    const updated = results.filter((r) => r.result === "Updated").length;
    const failed = results.length - updated;
    const table = results.length
      ? html`<table><caption>Import results</caption><thead><tr><th scope="col">Customer ID</th><th scope="col">Result</th></tr></thead>
<tbody>${results.map((r) => html`<tr><td class="id">${r.id || "—"}</td><td>${r.result === "Updated" ? html`<span class="badge tone-good">Updated</span>` : r.result}</td></tr>`)}</tbody></table>`
      : html`<p class="muted">No rows to import.</p>`;
    const body = html`${importIntro}
${flash(`Import finished: ${updated} updated, ${failed} failed.`)}
<section class="card">${table}</section>
<section class="card" aria-label="Run another import">${importForm(ui)}</section>`;
    return kit.page(reply, ui, 200, { title: "Import results", section: "/import", body });
  });

}
