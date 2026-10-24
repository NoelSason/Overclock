import type { FastifyInstance } from "fastify";
import { field, hasField, parsePage, type AppKit } from "./app-server";
import { dateEl, formatMoney, html } from "./html";
import { isEnum, labelOf, ORDER_STATUS } from "./labels";
import { badge, checkboxField, editForm, enumOptions, facts, flash, pager, searchForm, selectField, textField, type FormField } from "./ui";

const TRUTHY = new Set(["1", "on", "true", "yes"]);

/** Parcelpoint Orders: order list, order detail, and order edit form. */
export function registerOrders(f: FastifyInstance, kit: AppKit): void {
  const { store } = kit.ctx;

  f.get("/", async (_req, reply) => reply.redirect("/orders", 302));

  f.get("/orders", async (req, reply) => {
    const ui = kit.ui(req);
    const q = field(req.query, "q").trim();
    const customer = field(req.query, "customer").trim();
    const statusParam = field(req.query, "status");
    const status = isEnum(ORDER_STATUS, statusParam) ? statusParam : "";
    const pageSize = kit.pageSize(ui);
    const res = store.orders.list({ q: q || undefined, status: status || undefined, customerId: customer || undefined, page: parsePage(field(req.query, "page")), pageSize });
    const from = res.total ? (res.page - 1) * pageSize + 1 : 0;
    const to = from + res.rows.length - (res.total ? 1 : 0);
    const rows = res.rows.length
      ? res.rows.map(
          (o) => html`<tr><td><a class="id" href="/orders/${encodeURIComponent(o.id)}">${o.id}</a></td><td class="id">${o.customer_id}</td><td>${o.customer_email}</td><td>${badge(ORDER_STATUS, o.status)}</td><td class="num">${formatMoney(o.total)}</td><td>${dateEl(o.placed_at)}</td></tr>`,
        )
      : html`<tr><td colspan="6" class="empty">No orders match these filters.</td></tr>`;
    const body = html`<div class="header-row"><div><h1>Orders</h1><p class="lede">All orders, newest first.</p></div></div>
<div class="panel">
${searchForm(ui, {
  action: "/orders",
  searchLabel: "Search orders",
  q,
  button: "Find",
  extra: [{ id: "customer", name: "customer", label: "Customer ID", value: customer }],
  filters: [{ id: "status", name: "status", label: "Status", allLabel: "Any status", options: enumOptions(ORDER_STATUS), selected: status }],
})}
<table><caption>${res.total} orders${res.total ? ` · showing ${from}–${to}` : ""}</caption>
<thead><tr><th scope="col">Order ID</th><th scope="col">Customer ID</th><th scope="col">Customer email</th><th scope="col">Status</th><th scope="col" class="num">Total</th><th scope="col">Placed</th></tr></thead>
<tbody>${rows}</tbody></table>
${pager(ui, "/orders", { q, customer, status }, res.page, res.pages)}
</div>`;
    return kit.page(reply, ui, 200, { title: "Orders", section: "/orders", body });
  });

  f.get<{ Params: { id: string } }>("/orders/:id", async (req, reply) => {
    const ui = kit.ui(req);
    const o = store.orders.get(req.params.id);
    if (!o) return kit.error(reply, ui, 404, { title: "Order not found", message: `No order has the ID ${req.params.id}.`, links: [{ href: "/orders", label: "All orders" }] });
    const id = encodeURIComponent(o.id);
    const body = html`<a class="back" href="/orders"><span aria-hidden="true">← </span>${ui.t("All orders")}</a>
${flash(field(req.query, "saved") === "1" ? "Order updated" : null)}
<div class="header-row"><div><h1>Order ${o.id}</h1><p class="lede">${labelOf(ORDER_STATUS, o.status)} · ${formatMoney(o.total)}</p></div>
<a class="button-link" href="/orders/${id}/edit">${ui.t("Edit order")}</a></div>
<div class="sections">
<section class="panel" aria-labelledby="h-order"><h2 id="h-order">Order</h2>${facts([
      ["Order ID", o.id],
      ["Status", labelOf(ORDER_STATUS, o.status)],
      ["Total", formatMoney(o.total)],
      ["Placed", dateEl(o.placed_at)],
      ["Tracking", o.tracking],
    ])}</section>
<section class="panel" aria-labelledby="h-customer"><h2 id="h-customer">Customer</h2>${facts([
      ["Customer ID", o.customer_id],
      ["Customer email", o.customer_email],
    ])}</section>
<section class="panel" aria-labelledby="h-review"><h2 id="h-review">Review</h2>${facts([
      ["Review flag", o.review_flag ? "Yes" : "No"],
      ["Review reason", o.review_reason],
    ])}</section>
</div>`;
    return kit.page(reply, ui, 200, { title: `Order ${o.id}`, section: "/orders", body });
  });

  f.get<{ Params: { id: string } }>("/orders/:id/edit", async (req, reply) => {
    const ui = kit.ui(req);
    const o = store.orders.get(req.params.id);
    if (!o) return kit.error(reply, ui, 404, { title: "Order not found", message: `No order has the ID ${req.params.id}.`, links: [{ href: "/orders", label: "All orders" }] });
    const id = encodeURIComponent(o.id);
    const fields: FormField[] = [
      { name: "customer_id", panel: "details", html: textField("customer_id", "Customer ID", o.customer_id, { required: true }) },
      { name: "status", panel: "status", html: selectField("status", "Status", ORDER_STATUS, o.status) },
      { name: "tracking", panel: "details", html: textField("tracking", "Tracking number", o.tracking) },
      { name: "review_flag", panel: "status", html: checkboxField("review_flag", "Flag for review", o.review_flag === 1) },
      { name: "review_reason", panel: "status", html: textField("review_reason", "Review reason", o.review_reason) },
    ];
    const form = editForm(ui, {
      action: `/orders/${id}/edit`,
      version: o.version,
      fields,
      submit: "Update order",
      cancelHref: `/orders/${id}`,
      summary: `Order ${o.id} will be updated with the values you entered.`,
    });
    const body = html`<div class="header-row"><div><h1>Edit order ${o.id}</h1><p class="lede">${o.customer_email}</p></div></div>
<div class="panel">${form.body}</div>`;
    return kit.page(reply, ui, 200, { title: `Edit order ${o.id}`, section: "/orders", body, modals: form.modals, scripts: form.scripts });
  });

  f.post<{ Params: { id: string } }>("/orders/:id/edit", async (req, reply) => {
    const ui = kit.ui(req);
    const cur = store.orders.get(req.params.id);
    if (!cur) return kit.error(reply, ui, 404, { title: "Order not found", message: `No order has the ID ${req.params.id}.`, links: [{ href: "/orders", label: "All orders" }] });
    const id = encodeURIComponent(cur.id);
    const editHref = `/orders/${id}/edit`;
    const b = req.body;
    const statusIn = hasField(b, "status") ? field(b, "status") : cur.status;
    if (!isEnum(ORDER_STATUS, statusIn)) {
      return kit.error(reply, ui, 400, { title: "Invalid status", message: `“${statusIn}” is not a valid order status.`, links: [{ href: editHref, label: "Back to edit form" }] });
    }
    const customerId = hasField(b, "customer_id") ? field(b, "customer_id").trim() : cur.customer_id;
    if (!customerId) {
      return kit.error(reply, ui, 400, { title: "Missing information", message: "Customer ID is required.", links: [{ href: editHref, label: "Back to edit form" }] });
    }
    const next = {
      customer_id: customerId,
      status: statusIn,
      tracking: hasField(b, "tracking") ? field(b, "tracking").trim() : cur.tracking,
      // An unchecked checkbox is simply absent from the form body.
      review_flag: (TRUTHY.has(field(b, "review_flag").toLowerCase()) ? 1 : 0) as 0 | 1,
      review_reason: hasField(b, "review_reason") ? field(b, "review_reason").trim() : cur.review_reason,
    };
    const version = Number(field(b, "version"));
    if (!Number.isInteger(version) || version !== cur.version) {
      return kit.conflict(reply, ui, "This order changed since you opened it. Reload and try again.", editHref);
    }
    if (!kit.guardedWrite(reply, ui, () => void store.orders.update(cur.id, next))) return reply;
    return reply.redirect(`/orders/${id}?saved=1`, 303);
  });
}
