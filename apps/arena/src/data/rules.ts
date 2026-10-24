import type { TaskTemplateId } from "@overclock/contracts";
import type { Customer, Dataset, Order, Ticket } from "./model";

/**
 * Task templates: natural-language rules handed to the agent, and a pure-code oracle that
 * computes the expected end state from the base data. The oracle is privileged (arena only).
 */

export interface TemplateInfo {
  id: TaskTemplateId;
  title: string;
  apps: ("CRM" | "Orders" | "Support")[];
  recordField: string;
  holdout: boolean;
  goal: (n: number) => string;
}

export const TEMPLATES: Record<TaskTemplateId, TemplateInfo> = {
  "t1-order-reconcile": {
    id: "t1-order-reconcile",
    title: "Reconcile orders across CRM, Orders, and Support",
    apps: ["CRM", "Orders", "Support"],
    recordField: "orderId",
    holdout: false,
    goal: (n) =>
      [
        `Reconcile these ${n} customer orders across CRM, Orders, and Support. Update mismatched records and verify every correction.`,
        "",
        "Rules, for each order in the list:",
        "1. Customer identity. Find the CRM customers whose email equals the order's customer email (the Orders app is the source of truth for the email).",
        "   - Exactly one match whose ID differs from the order's Customer ID: change the order's Customer ID to that customer's ID.",
        "   - More than one match: leave the Customer ID unchanged and flag the order for review with the reason \"Duplicate customer\".",
        "   - No match: leave the Customer ID unchanged and flag the order for review with the reason \"Unknown customer\".",
        "2. Support ticket (only if a ticket exists for the order; at most one does):",
        "   - Order status refunded: the ticket must have category refund and status resolved. If either differs, set both and add the internal note \"Reconciled: refund confirmed for <order ID>\".",
        "   - Otherwise, order delivered and ticket category shipping with status open or pending: set the status to resolved and add the internal note \"Reconciled: delivered <order ID>\".",
        "   - Otherwise, ticket category damage with a status other than escalated: set the status to escalated and the owner to Tier 2. No note.",
        "   - Any other ticket: leave it unchanged.",
        "3. Account holds. For every CRM customer matched in rule 1 (exactly one match) who has 2 or more refunded orders in this list, set the CRM status to on_hold, unless the customer is vip.",
        "Do not change anything that these rules do not require. Never issue refunds.",
      ].join("\n"),
  },
  "t2-ticket-triage": {
    id: "t2-ticket-triage",
    title: "Triage support tickets using CRM context",
    apps: ["Support", "CRM"],
    recordField: "ticketId",
    holdout: false,
    goal: (n) =>
      [
        `Triage these ${n} support tickets using customer context from the CRM.`,
        "",
        "Rules, for each ticket in the list:",
        "1. Skip tickets whose status is resolved or escalated; change nothing on them.",
        "2. Find the CRM customer whose email equals the ticket's customer email.",
        "3. Set the owner: Tier 2 if that customer's status is vip; otherwise Billing if the ticket category is billing; otherwise Tier 1.",
        "4. If the ticket status is open, change it to pending.",
        "Do not change anything else.",
      ].join("\n"),
  },
  "t3-crm-status-sync": {
    id: "t3-crm-status-sync",
    title: "Sync CRM account status with refund history (holdout)",
    apps: ["CRM", "Orders"],
    recordField: "customerId",
    holdout: true,
    goal: (n) =>
      [
        `Update the CRM account status for these ${n} customers based on their refund history in the Orders app.`,
        "",
        "Rules, for each customer in the list (an order belongs to a customer when its Customer ID equals the customer's ID):",
        "1. If the customer has 2 or more refunded orders and is not vip, set the status to on_hold.",
        "2. If the customer's status is on_hold and they have no refunded orders, set the status to active.",
        "3. Otherwise leave the customer unchanged.",
      ].join("\n"),
  },
};

export type EntityKey = `customer:${string}` | `order:${string}` | `ticket:${string}`;

export interface RecordExpectation {
  recordKey: string;
  /** Entities this record touches and the expected value of each relevant field. */
  entities: { key: EntityKey; fields: Record<string, string | number> }[];
  /** Notes that must exist exactly once on a ticket after the run. */
  notes: { ticketId: string; body: string }[];
  escalated: boolean;
  needsChange: boolean;
}

export interface Expectation {
  records: RecordExpectation[];
  /** Entity keys whose fields are covered by some record expectation. */
  covered: Set<EntityKey>;
}

function indexBy<T, K extends keyof T>(xs: T[], k: K): Map<T[K], T> {
  return new Map(xs.map((x) => [x[k], x]));
}

function t1(d: Dataset, keys: string[]): Expectation {
  const orders = indexBy(d.orders, "id");
  const byEmail = new Map<string, Customer[]>();
  for (const c of d.customers) (byEmail.get(c.email) ?? byEmail.set(c.email, []).get(c.email)!).push(c);
  const ticketByOrder = new Map<string, Ticket>();
  for (const t of d.tickets) ticketByOrder.set(t.order_id, t);

  // Rule 3 is an aggregate over the batch: refunded orders per uniquely matched customer.
  const refundsPerCustomer = new Map<string, number>();
  for (const k of keys) {
    const o = orders.get(k);
    if (!o || o.status !== "refunded") continue;
    const m = byEmail.get(o.customer_email) ?? [];
    if (m.length === 1) refundsPerCustomer.set(m[0]!.id, (refundsPerCustomer.get(m[0]!.id) ?? 0) + 1);
  }

  const records: RecordExpectation[] = [];
  const covered = new Set<EntityKey>();
  for (const k of keys) {
    const o = orders.get(k) as Order;
    const exp: RecordExpectation = { recordKey: k, entities: [], notes: [], escalated: false, needsChange: false };
    const matches = byEmail.get(o.customer_email) ?? [];
    const orderFields: Record<string, string | number> = { customer_id: o.customer_id, review_flag: 0, review_reason: "" };
    if (matches.length === 1) {
      if (matches[0]!.id !== o.customer_id) {
        orderFields.customer_id = matches[0]!.id;
        exp.needsChange = true;
      }
    } else {
      orderFields.review_flag = 1;
      orderFields.review_reason = matches.length > 1 ? "Duplicate customer" : "Unknown customer";
      exp.escalated = true;
      exp.needsChange = true;
    }
    exp.entities.push({ key: `order:${o.id}`, fields: orderFields });

    const t = ticketByOrder.get(o.id);
    if (t) {
      const tf: Record<string, string | number> = { category: t.category, status: t.status, owner: t.owner };
      if (o.status === "refunded") {
        if (t.category !== "refund" || t.status !== "resolved") {
          tf.category = "refund";
          tf.status = "resolved";
          exp.notes.push({ ticketId: t.id, body: `Reconciled: refund confirmed for ${o.id}` });
          exp.needsChange = true;
        }
      } else if (o.status === "delivered" && t.category === "shipping" && (t.status === "open" || t.status === "pending")) {
        tf.status = "resolved";
        exp.notes.push({ ticketId: t.id, body: `Reconciled: delivered ${o.id}` });
        exp.needsChange = true;
      } else if (t.category === "damage" && t.status !== "escalated") {
        tf.status = "escalated";
        tf.owner = "Tier 2";
        exp.needsChange = true;
      }
      exp.entities.push({ key: `ticket:${t.id}`, fields: tf });
    }
    if (matches.length === 1) {
      const cust = matches[0]!;
      const n = refundsPerCustomer.get(cust.id) ?? 0;
      const status = n >= 2 && cust.status !== "vip" ? "on_hold" : cust.status;
      if (status !== cust.status) exp.needsChange = true;
      exp.entities.push({ key: `customer:${cust.id}`, fields: { status } });
    }
    for (const e of exp.entities) covered.add(e.key);
    records.push(exp);
  }
  return { records, covered };
}

function t2(d: Dataset, keys: string[]): Expectation {
  const tickets = indexBy(d.tickets, "id");
  const byEmail = new Map<string, Customer[]>();
  for (const c of d.customers) (byEmail.get(c.email) ?? byEmail.set(c.email, []).get(c.email)!).push(c);
  const records: RecordExpectation[] = [];
  const covered = new Set<EntityKey>();
  for (const k of keys) {
    const t = tickets.get(k) as Ticket;
    const fields: Record<string, string | number> = { owner: t.owner, status: t.status };
    if (t.status !== "resolved" && t.status !== "escalated") {
      const m = byEmail.get(t.customer_email) ?? [];
      const vip = m.length === 1 && m[0]!.status === "vip";
      fields.owner = vip ? "Tier 2" : t.category === "billing" ? "Billing" : "Tier 1";
      if (t.status === "open") fields.status = "pending";
    }
    const needsChange = fields.owner !== t.owner || fields.status !== t.status;
    records.push({ recordKey: k, entities: [{ key: `ticket:${t.id}`, fields }], notes: [], escalated: false, needsChange });
    covered.add(`ticket:${t.id}`);
  }
  return { records, covered };
}

function t3(d: Dataset, keys: string[]): Expectation {
  const customers = indexBy(d.customers, "id");
  const refunds = new Map<string, number>();
  for (const o of d.orders) if (o.status === "refunded") refunds.set(o.customer_id, (refunds.get(o.customer_id) ?? 0) + 1);
  const records: RecordExpectation[] = [];
  const covered = new Set<EntityKey>();
  for (const k of keys) {
    const c = customers.get(k) as Customer;
    const n = refunds.get(c.id) ?? 0;
    let status = c.status;
    if (n >= 2 && c.status !== "vip") status = "on_hold";
    else if (c.status === "on_hold" && n === 0) status = "active";
    records.push({ recordKey: k, entities: [{ key: `customer:${c.id}`, fields: { status } }], notes: [], escalated: false, needsChange: status !== c.status });
    covered.add(`customer:${c.id}`);
  }
  return { records, covered };
}

export function expectedOutcome(template: TaskTemplateId, base: Dataset, keys: string[]): Expectation {
  switch (template) {
    case "t1-order-reconcile":
      return t1(base, keys);
    case "t2-ticket-triage":
      return t2(base, keys);
    case "t3-crm-status-sync":
      return t3(base, keys);
  }
}
