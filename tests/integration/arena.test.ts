import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startArena, type Arena } from "@overclock/arena";
import { VariationConfig, type CheckResult, type PublicScenario } from "@overclock/contracts";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * Arena web layer: three apps plus the judge API, started in-process on ephemeral ports and
 * driven with a real browser. Labels and button texts used here are test-only knowledge.
 */

const USERNAME = process.env.ARENA_USERNAME || "operator";
const PASSWORD = process.env.ARENA_PASSWORD || "overclock-arena";

let arena: Arena;
let dir: string;
let browser: Browser;
let ctx: BrowserContext;
let page: Page;

const defaults = () => VariationConfig.parse({});
const vary = (patch: Partial<VariationConfig>) => arena.setVariations({ ...defaults(), ...patch });

async function login(p: Page, origin: string, path = "/"): Promise<void> {
  await p.goto(origin + path);
  expect(new URL(p.url()).pathname).toBe("/login");
  await p.getByLabel("Username").fill(USERNAME);
  await p.getByLabel("Password").fill(PASSWORD);
  await p.getByRole("button", { name: "Sign in" }).click();
  await p.waitForURL((u) => u.pathname !== "/login");
}

const fact = (p: Page, label: string) => p.locator(`dl.facts dt:text-is("${label}") + dd`).first();

function postResponse(p: Page) {
  return p.waitForResponse((r) => r.request().method() === "POST");
}

async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(arena.adminOrigin + path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as T };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "oc-arena-it-"));
  arena = await startArena({ adminPort: 0, ports: { CRM: 0, Orders: 0, Support: 0 }, dataDir: dir, defaultScenario: { seed: 7, template: "t1-order-reconcile", records: 40 } });
  browser = await chromium.launch({ headless: true });
  ctx = await browser.newContext();
  ctx.setDefaultTimeout(10_000);
  page = await ctx.newPage();
  for (const origin of [arena.origins.CRM, arena.origins.Orders, arena.origins.Support]) await login(page, origin);
});

afterAll(async () => {
  await browser?.close();
  await arena?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  arena.setVariations(defaults());
});

describe("auth", () => {
  it("redirects to login, rejects wrong credentials, and honours next", async () => {
    const res = await fetch(arena.origins.CRM + "/customers", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login?next=%2Fcustomers");

    const fresh = await browser.newContext();
    const p = await fresh.newPage();
    await p.goto(arena.origins.Orders + "/orders");
    await p.getByLabel("Username").fill(USERNAME);
    await p.getByLabel("Password").fill("wrong-password");
    const [bad] = await Promise.all([postResponse(p), p.getByRole("button", { name: "Sign in" }).click()]);
    expect(bad.status()).toBe(401);
    await expect(p.getByRole("alert").textContent()).resolves.toContain("Incorrect username or password.");

    const id = arena.store.crm.all()[0]!.id;
    await login(p, arena.origins.CRM, `/customers/${id}`);
    expect(new URL(p.url()).pathname).toBe(`/customers/${id}`);
    // Sessions are per app: the CRM session does not unlock Support.
    await p.goto(arena.origins.Support + "/tickets");
    expect(new URL(p.url()).pathname).toBe("/login");
    await fresh.close();
  });

  it("logged in to each app (shared context)", async () => {
    for (const [origin, h1] of [
      [arena.origins.CRM, "Customers"],
      [arena.origins.Orders, "Orders"],
      [arena.origins.Support, "Tickets"],
    ] as const) {
      await page.goto(origin + "/");
      await expect(page.getByRole("heading", { level: 1 }).textContent()).resolves.toBe(h1);
      expect(await page.getByRole("link", { name: "Sign out" }).count()).toBe(1);
    }
  });
});

describe("lists", () => {
  it("searches, filters, and paginates customers", async () => {
    const all = arena.store.crm.all();
    vary({ pageSize: { CRM: 10 } });
    await page.goto(arena.origins.CRM + "/customers");
    const pages = Math.ceil(all.length / 10);
    expect(await page.locator("table tbody tr").count()).toBe(10);
    const pager = page.getByRole("navigation", { name: "Pagination" });
    await expect(pager.textContent()).resolves.toContain(`Page 1 of ${pages}`);
    expect(await pager.locator('span[aria-disabled="true"]', { hasText: "Previous" }).count()).toBe(1);
    await pager.getByRole("link", { name: "Next" }).click();
    await expect(pager.textContent()).resolves.toContain(`Page 2 of ${pages}`);
    await pager.getByRole("link", { name: "Previous" }).click();
    await expect(pager.textContent()).resolves.toContain(`Page 1 of ${pages}`);

    arena.setVariations(defaults());
    await page.goto(arena.origins.CRM + "/customers");
    expect(await page.locator("table tbody tr").count()).toBe(Math.min(25, all.length));

    const unique = all.find((c) => all.filter((x) => x.email === c.email).length === 1)!;
    await page.getByLabel("Search customers").fill(unique.email);
    await page.getByRole("button", { name: "Search" }).click();
    await page.waitForURL(/q=/);
    const rows = page.locator("table tbody tr");
    expect(await rows.count()).toBe(1);
    await expect(rows.first().textContent()).resolves.toContain(unique.id);

    await page.goto(arena.origins.CRM + "/customers");
    await page.getByLabel("Status").selectOption("vip");
    await page.getByRole("button", { name: "Search" }).click();
    await page.waitForURL(/status=vip/);
    const statuses = await page.locator("table tbody tr td:nth-child(4)").allTextContents();
    expect(statuses.length).toBe(all.filter((c) => c.status === "vip").length);
    expect(new Set(statuses)).toEqual(new Set(["VIP"]));
  });

  it("filters orders by customer and tickets by category", async () => {
    const o = arena.store.orders.all()[0]!;
    await page.goto(`${arena.origins.Orders}/orders?customer=${encodeURIComponent(o.customer_id)}`);
    const ids = await page.locator("table tbody tr td:nth-child(2)").allTextContents();
    expect(ids.length).toBe(arena.store.orders.all().filter((x) => x.customer_id === o.customer_id).length);
    expect(new Set(ids)).toEqual(new Set([o.customer_id]));

    await page.goto(arena.origins.Support + "/tickets");
    await page.getByLabel("Category").selectOption("damage");
    await page.getByRole("button", { name: "Search" }).click();
    await page.waitForURL(/category=damage/);
    const cats = await page.locator("table tbody tr td:nth-child(4)").allTextContents();
    expect(cats.length).toBeGreaterThan(0);
    expect(new Set(cats)).toEqual(new Set(["Damage"]));
  });
});

describe("edits", () => {
  it("edits a customer status and persists it", async () => {
    const c = arena.store.crm.all().find((x) => x.status === "active")!;
    await page.goto(`${arena.origins.CRM}/customers/${c.id}`);
    await page.getByRole("link", { name: "Edit customer" }).click();
    await page.getByLabel("Status").selectOption("on_hold");
    await page.getByRole("button", { name: "Save changes" }).click();
    await page.waitForURL(/saved=1/);
    await expect(page.getByRole("status").textContent()).resolves.toBe("Customer saved");
    await expect(fact(page, "Status").textContent()).resolves.toBe("On hold");
    const after = arena.store.crm.get(c.id)!;
    expect(after.status).toBe("on_hold");
    expect(after.version).toBe(c.version + 1);
    await expect(fact(page, "Version").textContent()).resolves.toBe(String(after.version));
  });

  it("adds an internal note and renders untrusted text as text", async () => {
    const t = arena.store.support.all().find((x) => x.body.includes("SYSTEM NOTICE")) ?? arena.store.support.all()[0]!;
    const before = arena.store.support.notes(t.id).length;
    await page.goto(`${arena.origins.Support}/tickets/${t.id}`);
    await expect(page.locator("blockquote").textContent()).resolves.toBe(t.body);
    const text = `<b>Reconciled</b> & "checked" ${t.id}`;
    await page.getByLabel("Note", { exact: true }).fill(text);
    await page.getByRole("button", { name: "Add note" }).click();
    await page.waitForURL(/noted=1/);
    await expect(page.locator("ul.notes li .note-body").last().textContent()).resolves.toBe(text);
    expect(await page.locator("ul.notes b").count()).toBe(0);
    const notes = arena.store.support.notes(t.id);
    expect(notes.length).toBe(before + 1);
    expect(notes.at(-1)!.body).toBe(text);
  });

  it("returns 409 and writes nothing when the version is stale", async () => {
    const c = arena.store.crm.all()[3]!;
    await page.goto(`${arena.origins.CRM}/customers/${c.id}/edit`);
    arena.store.crm.update(c.id, { city: "Elsewhere" });
    await page.getByLabel("Name").fill("Stale Write");
    const [res] = await Promise.all([postResponse(page), page.getByRole("button", { name: "Save changes" }).click()]);
    expect(res.status()).toBe(409);
    await expect(page.getByRole("alert").textContent()).resolves.toContain("This customer changed since you opened it. Reload and try again.");
    expect(arena.store.crm.get(c.id)!.name).toBe(c.name);
    expect(arena.stats().apps.CRM.conflicts409).toBeGreaterThanOrEqual(1);
  });

  it("rejects an invalid status with 400", async () => {
    const o = arena.store.orders.all()[1]!;
    const cookies = await ctx.cookies(arena.origins.Orders);
    const cookie = cookies.map((k) => `${k.name}=${k.value}`).join("; ");
    const res = await fetch(`${arena.origins.Orders}/orders/${o.id}/edit`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: new URLSearchParams({ version: String(o.version), status: "lost_in_space", customer_id: o.customer_id }).toString(),
    });
    expect(res.status).toBe(400);
    expect(arena.store.orders.get(o.id)!.status).toBe(o.status);
  });

  it("runs a bulk status import", async () => {
    const [a, b] = arena.store.crm.all().filter((c) => c.status !== "vip");
    await page.goto(arena.origins.CRM + "/customers");
    await page.getByRole("navigation", { name: "Primary" }).getByRole("link", { name: "Bulk status import" }).click();
    await page.getByLabel("CSV rows").fill(`customer_id,status\n${a!.id},VIP\nC-0000,active\n${b!.id},nope`);
    await page.getByRole("button", { name: "Run import" }).click();
    const results = await page.locator("table tbody tr").evaluateAll((trs) => trs.map((tr) => Array.from(tr.querySelectorAll("td")).map((td) => td.textContent?.trim())));
    expect(results).toEqual([
      [a!.id, "Updated"],
      ["C-0000", "Unknown customer"],
      [b!.id, "Unknown status “nope”"],
    ]);
    expect(arena.store.crm.get(a!.id)!.status).toBe("vip");
    expect(arena.store.crm.get(b!.id)!.status).toBe(b!.status);
  });
});

describe("variations", () => {
  it("renames buttons", async () => {
    vary({ renameButtons: { CRM: { "Save changes": "Update record" } } });
    const c = arena.store.crm.all()[4]!;
    await page.goto(`${arena.origins.CRM}/customers/${c.id}/edit`);
    expect(await page.getByRole("button", { name: "Save changes" }).count()).toBe(0);
    await page.getByLabel("City").fill("Renamedville");
    await page.getByRole("button", { name: "Update record" }).click();
    await page.waitForURL(/saved=1/);
    expect(arena.store.crm.get(c.id)!.city).toBe("Renamedville");
  });

  it("confirm modal: Cancel keeps the record, Confirm saves it", async () => {
    vary({ confirmModal: { Orders: true } });
    const o = arena.store.orders.all()[2]!;
    await page.goto(`${arena.origins.Orders}/orders/${o.id}/edit`);
    await page.getByLabel("Tracking number").fill("1ZCONFIRM01");
    await page.getByRole("button", { name: "Update order" }).click();
    const dialog = page.getByRole("dialog", { name: "Confirm changes" });
    await dialog.waitFor({ state: "visible" });
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await dialog.waitFor({ state: "hidden" });
    expect(arena.store.orders.get(o.id)!.tracking).toBe(o.tracking);

    await page.getByRole("button", { name: "Update order" }).click();
    await dialog.getByRole("button", { name: "Confirm" }).click();
    await page.waitForURL(/saved=1/);
    expect(arena.store.orders.get(o.id)!.tracking).toBe("1ZCONFIRM01");
    await expect(fact(page, "Tracking").textContent()).resolves.toBe("1ZCONFIRM01");
  });

  it("edit in tab: status controls are hidden until the tab is opened", async () => {
    vary({ editInTab: { Support: true } });
    const t = arena.store.support.all().find((x) => x.status !== "escalated")!;
    await page.goto(`${arena.origins.Support}/tickets/${t.id}/edit`);
    const status = page.getByLabel("Status", { exact: true });
    expect(await status.isVisible()).toBe(false);
    expect(await page.getByRole("button", { name: "Save ticket" }).isVisible()).toBe(true);
    await page.getByRole("tab", { name: "Status & ownership" }).click();
    await expect(page.getByRole("tab", { name: "Status & ownership" }).getAttribute("aria-selected")).resolves.toBe("true");
    expect(await status.isVisible()).toBe(true);
    await status.selectOption("escalated");
    await page.getByLabel("Owner", { exact: true }).selectOption("Tier 2");
    await page.getByRole("button", { name: "Save ticket" }).click();
    await page.waitForURL(/saved=1/);
    const after = arena.store.support.get(t.id)!;
    expect([after.status, after.owner]).toEqual(["escalated", "Tier 2"]);
  });

  it("shuffles edit fields deterministically", async () => {
    const c = arena.store.crm.all()[5]!;
    const labels = () => page.locator("#edit-form label").allTextContents();
    await page.goto(`${arena.origins.CRM}/customers/${c.id}/edit`);
    const original = await labels();
    expect(original).toEqual(["Name", "Email", "Phone", "City", "Status"]);
    vary({ shuffleFields: { CRM: 12345 } });
    await page.reload();
    const shuffled = await labels();
    expect(shuffled).not.toEqual(original);
    expect([...shuffled].sort()).toEqual([...original].sort());
    await page.reload();
    expect(await labels()).toEqual(shuffled);
  });

  it("announcement overlay blocks the page until dismissed, once per session", async () => {
    vary({ announcementModal: { CRM: true } });
    await page.goto(arena.origins.CRM + "/customers");
    const dialog = page.getByRole("dialog", { name: "What's new" });
    await dialog.waitFor({ state: "visible" });
    expect(await page.locator("#page").getAttribute("inert")).not.toBeNull();
    await dialog.getByRole("button", { name: "Dismiss" }).click();
    await dialog.waitFor({ state: "hidden" });
    expect(await page.locator("#page").getAttribute("inert")).toBeNull();
    await page.reload();
    expect(await dialog.count()).toBe(0);
    // Switching it off and on again shows it to existing sessions once more.
    arena.setVariations(defaults());
    vary({ announcementModal: { CRM: true } });
    await page.reload();
    await dialog.waitFor({ state: "visible" });
    await dialog.getByRole("button", { name: "Dismiss" }).click();
  });

  it("failure injection: after-commit 500 still writes; before-commit 503 does not", async () => {
    const c = arena.store.crm.all()[6]!;
    vary({ failures: { CRM: { beforeCommitRate: 0, afterCommitRate: 1 } } });
    const s0 = arena.stats().apps.CRM;
    await page.goto(`${arena.origins.CRM}/customers/${c.id}/edit`);
    await page.getByLabel("Phone").fill("(555) 000-0500");
    const [r500] = await Promise.all([postResponse(page), page.getByRole("button", { name: "Save changes" }).click()]);
    expect(r500.status()).toBe(500);
    expect(arena.store.crm.get(c.id)!.phone).toBe("(555) 000-0500");

    vary({ failures: { CRM: { beforeCommitRate: 1, afterCommitRate: 0 } } });
    await page.goto(`${arena.origins.CRM}/customers/${c.id}/edit`);
    await page.getByLabel("Phone").fill("(555) 000-0503");
    const [r503] = await Promise.all([postResponse(page), page.getByRole("button", { name: "Save changes" }).click()]);
    expect(r503.status()).toBe(503);
    expect(arena.store.crm.get(c.id)!.phone).toBe("(555) 000-0500");

    const s1 = arena.stats().apps.CRM;
    expect(s1.injectedAfterCommit - s0.injectedAfterCommit).toBe(1);
    expect(s1.injectedBeforeCommit - s0.injectedBeforeCommit).toBe(1);
    expect(s1.writes - s0.writes).toBe(1);
  });

  it("concurrency limit answers 429 with Retry-After", async () => {
    vary({ concurrencyLimit: { Orders: 2 }, latency: { Orders: { baseMs: 300, jitterMs: 0, slowRate: 0, slowMs: 0 } } });
    const before = arena.stats().apps.Orders.throttled429;
    const responses = await Promise.all(Array.from({ length: 6 }, () => fetch(arena.origins.Orders + "/login")));
    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(1);
    expect(statuses.filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
    expect(responses.find((r) => r.status === 429)!.headers.get("retry-after")).toBe("1");
    await Promise.all(responses.map((r) => r.text()));
    const st = arena.stats().apps.Orders;
    expect(st.throttled429 - before).toBe(statuses.filter((s) => s === 429).length);
    expect(st.maxInFlight).toBeGreaterThanOrEqual(2);
  });
});

describe("admin API", () => {
  it("serves health, scenario, CORS, and the judge console", async () => {
    const health = await api<{ ok: boolean; origins: Arena["origins"]; adminOrigin: string }>("GET", "/api/health");
    expect(health.data).toEqual({ ok: true, origins: arena.origins, adminOrigin: arena.adminOrigin });

    const scn = await api<PublicScenario>("GET", "/api/scenario");
    expect(scn.data.records).toHaveLength(40);
    expect(scn.data.applications.find((a) => a.name === "Support")!.origin).toBe(arena.origins.Support);

    const allowed = await fetch(arena.adminOrigin + "/api/health", { headers: { origin: "http://localhost:3000" } });
    expect(allowed.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    const denied = await fetch(arena.adminOrigin + "/api/health", { headers: { origin: "http://evil.test" } });
    expect(denied.headers.get("access-control-allow-origin")).toBeNull();
    const preflight = await fetch(arena.adminOrigin + "/api/variations", { method: "OPTIONS", headers: { origin: "http://127.0.0.1:5173", "access-control-request-method": "PUT" } });
    expect(preflight.status).toBe(204);

    const p = await ctx.newPage();
    await p.goto(arena.adminOrigin + "/");
    await p.getByText("Live", { exact: true }).waitFor();
    await p.close();
  });

  it("applies surprises and validates variation edits", async () => {
    const renamed = await api<VariationConfig>("POST", "/api/judge/surprise", { kind: "rename-save", app: "all" });
    expect(renamed.data.renameButtons).toEqual({ CRM: { "Save changes": "Update record" }, Orders: { "Update order": "Apply changes" }, Support: { "Save ticket": "Commit ticket" } });
    const lat = await api<VariationConfig>("POST", "/api/judge/surprise", { kind: "latency", app: "Orders" });
    expect(lat.data.latency).toEqual({ Orders: { baseMs: 250, jitterMs: 250, slowRate: 0.1, slowMs: 2000 } });
    const patched = await api<VariationConfig>("PATCH", "/api/variations", { confirmModal: { CRM: true }, latency: { Orders: null } });
    expect(patched.data.confirmModal).toEqual({ CRM: true });
    expect(patched.data.latency).toEqual({});
    expect(patched.data.renameButtons.CRM).toEqual({ "Save changes": "Update record" });
    const bad = await api<{ error: string }>("PUT", "/api/variations", { theme: "neon" });
    expect(bad.status).toBe(400);
    const cleared = await api<VariationConfig>("POST", "/api/judge/surprise", { kind: "clear" });
    expect(cleared.data).toEqual(defaults());
    const badKind = await api<{ error: string }>("POST", "/api/judge/surprise", { kind: "meteor" });
    expect(badKind.status).toBe(400);
  });

  it("checks, edits an unprocessed record, and resets", async () => {
    const check = await api<CheckResult>("GET", "/api/check");
    expect(check.status).toBe(200);
    expect(check.data.totalRecords).toBe(40);
    expect(check.data.accuracy).toBeGreaterThanOrEqual(0);
    expect(check.data.accuracy).toBeLessThanOrEqual(1);
    const summary = await api<{ records: number }>("GET", "/api/expectation-summary");
    expect(summary.data.records).toBe(40);

    const badEdit = await api<{ error: string }>("POST", "/api/edit-record", { entity: "customer", id: arena.store.crm.all()[0]!.id, patch: { status: "bogus" } });
    expect(badEdit.status).toBe(400);

    const untouched = arena.manager.untouchedRecords();
    const edit = await api<{ recordKey: string; entity: "order" | "ticket" | "customer"; id: string; patch: Record<string, string> }>("POST", "/api/judge/edit-unprocessed");
    expect(edit.status).toBe(200);
    expect(untouched).toContain(edit.data.recordKey);
    const row = edit.data.entity === "order" ? arena.store.orders.get(edit.data.id) : edit.data.entity === "ticket" ? arena.store.support.get(edit.data.id) : arena.store.crm.get(edit.data.id);
    for (const [k, v] of Object.entries(edit.data.patch)) expect((row as unknown as Record<string, unknown>)[k]).toBe(v);

    // Earlier tests changed data and stats; reset restores the snapshot and clears both.
    vary({ confirmModal: { CRM: true } });
    const reset = await api<PublicScenario>("POST", "/api/reset");
    expect(reset.status).toBe(200);
    expect(arena.getVariations()).toEqual(defaults());
    const st = (await api<{ apps: Record<string, { requests: number; writes: number }> }>("GET", "/api/stats")).data;
    expect(st.apps.CRM!.writes).toBe(0);
    const after = (await api<CheckResult>("GET", "/api/check")).data;
    expect(after.collateralWrites).toBe(0);
    expect(after.duplicateWrites).toBe(0);
    const noteCount = arena.store.support.allNotes().filter((n) => n.body.includes("<b>Reconciled</b>")).length;
    expect(noteCount).toBe(0);
  });
});
