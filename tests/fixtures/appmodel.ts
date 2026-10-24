import type { AppControl, AppModel } from "@overclock/contracts";

/** Test-only synthetic app models (the product builds these by observing real pages). */
export function ctrl(app: string, id: string, kind: AppControl["kind"], name: string, extra: Partial<AppControl> = {}): AppControl {
  const role = kind === "button" ? "button" : kind === "link" ? "link" : kind === "table" ? "table" : kind === "select" ? "combobox" : kind === "fact" ? "definition" : "textbox";
  return {
    id,
    app,
    page: extra.page ?? "/",
    role,
    name,
    kind,
    locator: {
      controlId: id,
      strategies: kind === "fact" ? [{ kind: "css", selector: `dd[data-f="${name}"]` }] : [{ kind: "role", role, name }],
      confidence: 0.9,
      evidence: [],
    },
    ...extra,
  };
}

export function model(app: string, origin: string, controls: AppControl[]): AppModel {
  return {
    app,
    origin,
    pages: [],
    controls: Object.fromEntries(controls.map((c) => [c.id, c])),
    operations: [],
    features: { listTables: [], bulkOperations: [], search: [] },
    fingerprint: `${app}-fp`,
    crawl: { pagesVisited: 0, ms: 0, blockedMutations: 0 },
  };
}

export const ordersModel = model("Orders", "http://127.0.0.1:4102", [
  ctrl("Orders", "orders.detail.status", "fact", "Status"),
  ctrl("Orders", "orders.detail.customer_email", "fact", "Customer email"),
  ctrl("Orders", "orders.detail.customer_id", "fact", "Customer ID"),
  ctrl("Orders", "orders.list.table", "table", "Orders", { detail: "Order ID | Customer ID | Customer email | Status | Total | Placed" }),
  ctrl("Orders", "orders.list.next", "link", "Next"),
  ctrl("Orders", "orders.edit.customer_id", "input", "Customer ID"),
  ctrl("Orders", "orders.edit.submit", "button", "Update order", { effectGuess: "remote-write" }),
  ctrl("Orders", "orders.detail.delete", "button", "Delete order", { effectGuess: "irreversible" }),
]);

export const supportModel = model("Support", "http://127.0.0.1:4103", [
  ctrl("Support", "support.list.search", "input", "Search tickets"),
  ctrl("Support", "support.list.table", "table", "Tickets", { detail: "Ticket | Order | Subject | Category | Status | Owner" }),
  ctrl("Support", "support.detail.status", "fact", "Status"),
  ctrl("Support", "support.detail.category", "fact", "Category"),
  ctrl("Support", "support.edit.status", "select", "Status"),
  ctrl("Support", "support.edit.submit", "button", "Save ticket", { effectGuess: "remote-write" }),
]);

export const apps = [
  { name: "Orders", origin: "http://127.0.0.1:4102" },
  { name: "Support", origin: "http://127.0.0.1:4103" },
];
