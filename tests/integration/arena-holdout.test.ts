// HOLDOUT FIXTURE — engine/prompt developers must not read this file.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOLDOUT_APP, startArena, type Arena } from "@overclock/arena";
import { VariationConfig, type CheckResult, type PublicScenario } from "@overclock/contracts";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generate } from "../../apps/arena/src/data/generate";
import { expectedOutcome } from "../../apps/arena/src/data/rules";
import { ScenarioManager } from "../../apps/arena/src/data/scenario";
import { ArenaStore } from "../../apps/arena/src/data/store";
import type { HoldoutStore } from "../../apps/arena/src/holdout/store";

/**
 * The fourth (holdout) app: generation, oracle and checker, the read-only viewer role, a real
 * browser session through its client-rendered UI, and the judge's variations applied to it.
 */

const APP = HOLDOUT_APP;
const USERNAME = process.env.ARENA_USERNAME || "operator";
const PASSWORD = process.env.ARENA_PASSWORD || "overclock-arena";
const VIEWER = process.env.ARENA_VIEWER_USERNAME || "viewer";
const VIEWER_PASSWORD = process.env.ARENA_VIEWER_PASSWORD || "overclock-viewer";

// ---------------------------------------------------------------------------------------------
// Reference solver: implements the task text directly against the store (independent of the oracle).

function solve(db: HoldoutStore, keys: readonly string[]): void {
  const all = db.dump();
  const labels = new Map<string, number>();
  for (const s of all.specimens) labels.set(s.label_code, (labels.get(s.label_code) ?? 0) + 1);
  const quarantinedIn = new Map<string, number>();
  for (const acc of keys) {
    const s = db.getSpecimen(acc)!;
    if (s.hold === 1) continue;
    if ((labels.get(s.label_code) ?? 0) > 1) {
      db.updateSpecimen(acc, { hold: 1, hold_reason: "Duplicate label" });
      continue;
    }
    const p = db.getParticipant(s.participant_code);
    if (!p) {
      db.updateSpecimen(acc, { hold: 1, hold_reason: "Unknown participant" });
      continue;
    }
    if (p.consent === "withdrawn") {
      if (s.state !== "discard_pending" && s.state !== "consumed") {
        db.updateSpecimen(acc, { state: "discard_pending" });
        db.addCustody(acc, "Discard requested: consent withdrawn", "solver");
      }
      continue;
    }
    if (s.state !== "available" && s.state !== "reserved") continue;
    const newestFirst = db.excursions(s.unit_id, 0, 10_000).rows;
    const hit = newestFirst.find((e) => e.peak_c > -60 && Date.parse(e.started_at) > Date.parse(s.stored_at));
    if (!hit) continue;
    db.updateSpecimen(acc, { state: "quarantined" });
    db.addCustody(acc, `Quarantined: excursion ${hit.id}`, "solver");
    quarantinedIn.set(s.unit_id, (quarantinedIn.get(s.unit_id) ?? 0) + 1);
  }
  for (const [unit, n] of quarantinedIn) if (n >= 3 && db.getUnit(unit)!.service !== "service_requested") db.updateUnit(unit, { service: "service_requested" });
}

const tempDirs: string[] = [];
function tempManager(): { store: ArenaStore; mgr: ScenarioManager } {
  const d = mkdtempSync(join(tmpdir(), "oc-holdout-"));
  tempDirs.push(d);
  const store = new ArenaStore(d);
  return { store, mgr: new ScenarioManager(store, { CRM: "a", Orders: "b", Support: "c", [APP]: "d" }, d) };
}

describe("t4 generation, oracle, and checker", () => {
  afterEach(() => {
    for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("is deterministic per seed and sized exactly", () => {
    const a = generate("t4-holdout", 42, 80);
    expect(generate("t4-holdout", 42, 80)).toEqual(a);
    const c = generate("t4-holdout", 43, 80);
    expect(c.recordKeys).not.toEqual(a.recordKeys);
    expect(new Set(a.recordKeys).size).toBe(80);
    const accessions = new Set(a.dataset.holdout.specimens.map((s) => s.accession));
    expect(a.recordKeys.every((k) => accessions.has(k))).toBe(true);
    expect(a.dataset.holdout.specimens.length).toBeGreaterThan(80); // distractors exist
    expect([a.dataset.customers, a.dataset.orders, a.dataset.tickets, a.dataset.notes].every((x) => x.length === 0)).toBe(true);
    for (const n of [1, 2, 5, 13, 500]) expect(generate("t4-holdout", 9, n).recordKeys).toHaveLength(n);
    // Classic templates leave the fourth app empty.
    expect(generate("t1-order-reconcile", 42, 20).dataset.holdout.specimens).toHaveLength(0);
  });

  it("exercises every rule, both escalation kinds, append-only entries, and the batch rule", () => {
    const g = generate("t4-holdout", 7, 100);
    const exp = expectedOutcome("t4-holdout", g.dataset, g.recordKeys);
    const reasons = new Set(exp.records.filter((r) => r.escalated).map((r) => r.entities[0]!.fields.hold_reason));
    expect(reasons).toEqual(new Set(["Duplicate label", "Unknown participant"]));
    const bodies = exp.records.flatMap((r) => r.appends ?? []).map((a) => a.body);
    expect(bodies.some((b) => b.startsWith("Quarantined: excursion EXC-"))).toBe(true);
    expect(bodies).toContain("Discard requested: consent withdrawn");
    const units = g.dataset.holdout.units;
    const raised = new Set(exp.records.flatMap((r) => r.entities.filter((e) => e.key.startsWith("unit:") && e.fields.service === "service_requested").map((e) => e.key)));
    expect([...raised].some((k) => units.find((u) => `unit:${u.id}` === k)!.service === "normal")).toBe(true);
    const need = exp.records.filter((r) => r.needsChange).length;
    expect(need).toBeGreaterThan(20);
    expect(need).toBeLessThan(90);
  });

  for (const [seed, n] of [
    [3, 40],
    [11, 120],
    [9001, 60],
    [5, 6],
  ] as const) {
    it(`a reference solution done through the store scores 100% (seed ${seed}, ${n} records)`, () => {
      const { store, mgr } = tempManager();
      mgr.load({ seed, template: "t4-holdout", records: n });
      const before = mgr.check()!;
      expect(before.accuracy).toBeLessThan(1);
      solve(store.holdout, mgr.current!.recordKeys);
      const after = mgr.check()!;
      expect(after.mismatches).toEqual([]);
      expect(after.accuracy).toBe(1);
      expect(after.duplicateWrites).toBe(0);
      expect(after.collateralWrites).toBe(0);
      expect(after.escalationExpected).toBe(before.escalationExpected);
      store.close();
    });
  }

  it("detects duplicate entries, collateral writes, and guessed escalations", () => {
    const { store, mgr } = tempManager();
    mgr.load({ seed: 21, template: "t4-holdout", records: 60 });
    const keys = mgr.current!.recordKeys;
    solve(store.holdout, keys);
    expect(mgr.check()!.accuracy).toBe(1);
    const exp = expectedOutcome("t4-holdout", mgr.current!.base, keys);

    const withEntry = exp.records.find((r) => r.appends?.length)!;
    store.holdout.addCustody(withEntry.recordKey, withEntry.appends![0]!.body, "retry"); // a retried append
    let r = mgr.check()!;
    expect(r.duplicateWrites).toBe(1);
    expect(r.correctRecords).toBe(r.totalRecords - 1);
    expect(r.mismatches.some((m) => m.recordKey === withEntry.recordKey && m.actual === "2 copies")).toBe(true);

    const listed = new Set(keys);
    const d = store.holdout.dump();
    const stray = d.specimens.find((s) => !listed.has(s.accession) && s.state === "available")!;
    store.holdout.updateSpecimen(stray.accession, { state: "quarantined" });
    store.holdout.addCustody(stray.accession, "Quarantined: excursion EXC-0000", "agent");
    const coveredUnits = new Set(exp.records.flatMap((x) => x.entities.filter((e) => e.key.startsWith("unit:")).map((e) => e.key)));
    const strayUnit = d.units.find((u) => !coveredUnits.has(`unit:${u.id}`) && u.service === "normal");
    if (strayUnit) store.holdout.updateUnit(strayUnit.id, { service: "service_requested" });
    const p = d.participants[0]!;
    store.holdout.updateParticipant(p.code, { consent: p.consent === "withdrawn" ? "active" : "withdrawn" });
    r = mgr.check()!;
    expect(r.collateralWrites).toBeGreaterThanOrEqual(3 + (strayUnit ? 1 : 0));

    const esc = exp.records.find((x) => x.escalated)!;
    store.holdout.updateSpecimen(esc.recordKey, { hold: 0, hold_reason: "", state: "quarantined" }); // guessed instead of escalating
    r = mgr.check()!;
    expect(r.mismatches.some((m) => m.recordKey === esc.recordKey && m.field === "hold")).toBe(true);
    store.close();
  });

  it("reset restores the snapshot exactly", () => {
    const { store, mgr } = tempManager();
    mgr.load({ seed: 2, template: "t4-holdout", records: 30 });
    const snap = store.dump();
    solve(store.holdout, mgr.current!.recordKeys);
    expect(store.dump()).not.toEqual(snap);
    mgr.reset();
    expect(store.dump()).toEqual(snap);
    store.close();
  });
});

// ---------------------------------------------------------------------------------------------
// The running app.

let arena: Arena;
let dir: string;
let browser: Browser;
let ctx: BrowserContext;
let page: Page;
let origin: string;

const defaults = () => VariationConfig.parse({});
const vary = (patch: Partial<VariationConfig>) => arena.setVariations({ ...defaults(), ...patch });
const db = () => arena.store.holdout;

async function api<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(arena.adminOrigin + path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as T };
}

async function signIn(p: Page, username = USERNAME, password = PASSWORD, hash = ""): Promise<void> {
  await p.goto(`${origin}/${hash}`);
  expect(new URL(p.url()).pathname).toBe("/signin");
  await p.getByLabel("Account name").fill(username);
  await p.getByRole("button", { name: "Continue" }).click();
  await p.getByLabel("Passphrase").fill(password);
  await p.getByRole("button", { name: "Sign in" }).click();
  await p.waitForURL((u) => u.pathname === "/");
  await p.getByRole("tab", { name: "Specimens" }).waitFor();
}

async function cookieFor(username: string, password: string): Promise<string> {
  const res = await fetch(`${origin}/signin`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ account: username, passphrase: password }) });
  expect(res.status).toBe(200);
  return res.headers.getSetCookie().map((c) => c.split(";")[0]!).join("; ");
}

async function svc(cookie: string, method: string, path: string, body?: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  const res = await fetch(origin + path, {
    method,
    headers: { cookie, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

/** A listed specimen that is not on hold and is Available (a safe target for UI edits). */
function freeSpecimen(skip: ReadonlySet<string> = new Set()) {
  const keys = arena.manager.current!.recordKeys;
  const acc = keys.find((k) => !skip.has(k) && db().getSpecimen(k)!.hold === 0 && db().getSpecimen(k)!.state === "available")!;
  return db().getSpecimen(acc)!;
}

async function openSpecimen(p: Page, accession: string): Promise<void> {
  await p.goto(`${origin}/#/specimens/${encodeURIComponent(accession)}`);
  await p.getByRole("heading", { level: 2, name: accession }).waitFor();
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "oc-arena-holdout-"));
  arena = await startArena({ adminPort: 0, ports: { CRM: 0, Orders: 0, Support: 0, [APP]: 0 }, dataDir: dir, defaultScenario: { seed: 31, template: "t4-holdout", records: 40 } });
  origin = arena.origins[APP];
  browser = await chromium.launch({ headless: true });
  ctx = await browser.newContext();
  ctx.setDefaultTimeout(10_000);
  page = await ctx.newPage();
  await signIn(page);
});

afterAll(async () => {
  await browser?.close();
  await arena?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  arena.setVariations(defaults());
});

describe("scenario API for t4", () => {
  it("loads t4 by seed and record count, lists only the fourth app, and caps the size", async () => {
    const loaded = await api<PublicScenario>("POST", "/api/scenario", { seed: 9101, template: "t4-holdout", records: 25 });
    expect(loaded.status).toBe(200);
    expect(loaded.data.scenarioId).toBe("t4-holdout-s9101-n25");
    expect(loaded.data.holdout).toBe(true);
    expect(loaded.data.applications).toEqual([{ name: APP, origin }]);
    expect(loaded.data.records).toHaveLength(25);
    expect(loaded.data.records.every((r) => Object.keys(r).join() === "accession")).toBe(true);
    expect(loaded.data.goal).toContain("25 specimens");

    const byDefault = await api<PublicScenario>("POST", "/api/scenario", { seed: 9102, template: "t4-holdout" });
    expect(byDefault.data.records).toHaveLength(100);
    const max = await api<PublicScenario>("POST", "/api/scenario", { seed: 9103, template: "t4-holdout", records: 500 });
    expect(max.data.records).toHaveLength(500);
    expect((await api<unknown>("POST", "/api/scenario", { seed: 9104, template: "t4-holdout", records: 501 })).status).toBe(400);

    const check = await api<CheckResult>("GET", "/api/check");
    expect(check.data.totalRecords).toBe(500);
    expect(check.data.escalationExpected).toBeGreaterThan(0);
    const st = (await api<{ apps: Record<string, { deniedWrites: number; writes: number }> }>("GET", "/api/stats")).data;
    expect(st.apps[APP]).toMatchObject({ writes: 0, deniedWrites: 0 });

    // Back to the suite's scenario.
    await api("POST", "/api/scenario", { seed: 31, template: "t4-holdout", records: 40 });
  });

  it("edits an unprocessed record for the judge, and reset discards it", async () => {
    const edit = await api<{ recordKey: string; entity: string; id: string; patch: Record<string, string> }>("POST", "/api/judge/edit-unprocessed");
    expect(edit.status).toBe(200);
    expect(["participant", "specimen"]).toContain(edit.data.entity);
    const row = edit.data.entity === "participant" ? db().getParticipant(edit.data.id) : db().getSpecimen(edit.data.id);
    for (const [k, v] of Object.entries(edit.data.patch)) expect((row as unknown as Record<string, unknown>)[k]).toBe(v);
    const direct = await api<{ ok: boolean }>("POST", "/api/edit-record", { entity: "unit", id: db().listUnits()[0]!.id, patch: { service: "service_requested" } });
    expect(direct.data.ok).toBe(true);
    expect((await api<{ error: string }>("POST", "/api/edit-record", { entity: "unit", id: db().listUnits()[0]!.id, patch: { service: "broken" } })).status).toBe(400);
    expect((await api<PublicScenario>("POST", "/api/reset")).status).toBe(200);
    expect(arena.manager.check()!.collateralWrites).toBe(0);
  });
});

describe("browser session", () => {
  it("serves an empty shell and renders data client-side after load", async () => {
    const cookie = await cookieFor(USERNAME, PASSWORD);
    const shell = await (await fetch(origin + "/", { headers: { cookie } })).text();
    const acc = arena.manager.current!.recordKeys[0]!;
    expect(shell).toContain('id="rw-root"');
    expect(shell).not.toContain(acc);
    const p = await ctx.newPage();
    await p.goto(origin + "/");
    await p.locator('[data-key]').first().waitFor();
    expect(await p.locator('[data-key]').count()).toBeGreaterThan(0);
    await p.close();
  });

  it("rejects a wrong passphrase and keeps sessions per app", async () => {
    const fresh = await browser.newContext();
    const p = await fresh.newPage();
    await p.goto(origin + "/");
    await p.getByLabel("Account name").fill(USERNAME);
    await p.getByRole("button", { name: "Continue" }).click();
    await p.getByLabel("Passphrase").fill("wrong");
    await p.getByRole("button", { name: "Sign in" }).click();
    await expect(p.getByRole("alert").textContent()).resolves.toContain("don't match");
    expect(new URL(p.url()).pathname).toBe("/signin");
    await fresh.close();
    expect((await fetch(origin + "/svc/boot", { headers: { accept: "application/json" } })).status).toBe(401);
  });

  it("changes a state through the multi-step dialog and records a custody entry", async () => {
    const s = freeSpecimen();
    const entries = db().custody(s.accession, { limit: 100 }).entries.length;
    const writes = arena.stats().apps[APP].writes;
    await openSpecimen(page, s.accession);
    await page.getByRole("button", { name: "Change state…" }).click();
    const dialog = page.getByRole("dialog", { name: /Change state/ });
    await dialog.getByRole("radio", { name: "Reserved" }).check();
    await dialog.getByRole("button", { name: "Continue" }).click();
    await dialog.getByRole("button", { name: "Apply change" }).click();
    await dialog.waitFor({ state: "detached" });
    await expect.poll(() => db().getSpecimen(s.accession)!.state).toBe("reserved");
    expect(db().getSpecimen(s.accession)!.version).toBe(s.version + 1);

    await page.getByRole("button", { name: "Add entry" }).click();
    await page.getByLabel("New entry").fill(`Checked by browser test <b>${s.accession}</b>`);
    await page.getByRole("button", { name: "Record entry" }).click();
    await expect.poll(() => db().custody(s.accession, { limit: 100 }).entries.length).toBe(entries + 1);
    await page.locator(".rw-entry-text", { hasText: "Checked by browser test" }).waitFor();
    expect(await page.locator(".rw-log b").count()).toBe(0);
    expect(arena.stats().apps[APP].writes - writes).toBe(2);
  });

  it("places a review hold through the row menu and edits a storage unit per field", async () => {
    const s = freeSpecimen();
    await page.goto(`${origin}/#/specimens`);
    await page.getByRole("searchbox", { name: "Search specimens" }).fill(s.label_code);
    const row = page.locator(`[data-key="${s.accession}"]`);
    await row.waitFor();
    await row.getByRole("button", { name: `Actions for ${s.accession}` }).click();
    await page.getByRole("menuitem", { name: "Place review hold…" }).click();
    const dialog = page.getByRole("dialog", { name: "Place review hold" });
    await dialog.getByLabel("Reason").fill("Duplicate label");
    await dialog.getByRole("button", { name: "Place hold" }).click();
    await expect.poll(() => db().getSpecimen(s.accession)!.hold_reason).toBe("Duplicate label");

    const u = db().listUnits().find((x) => x.service === "normal")!;
    await page.getByRole("tab", { name: "Storage" }).click();
    await page.locator(`a[data-key="${u.id}"]`).click();
    await page.getByRole("heading", { name: "Excursion log" }).waitFor();
    await page.getByRole("button", { name: "Edit service status" }).click();
    await page.getByLabel("Service status").selectOption("service_requested");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect.poll(() => db().getUnit(u.id)!.service).toBe("service_requested");
  });
});

describe("viewer role", () => {
  it("sees the same UI, but every write is refused with 403, shown, and counted", async () => {
    const vctx = await browser.newContext();
    vctx.setDefaultTimeout(10_000);
    const p = await vctx.newPage();
    await signIn(p, VIEWER, VIEWER_PASSWORD);
    const s = freeSpecimen();
    const denied = arena.stats().apps[APP].deniedWrites;
    await openSpecimen(p, s.accession);
    await p.getByRole("button", { name: "Change state…" }).click();
    const dialog = p.getByRole("dialog", { name: /Change state/ });
    await dialog.getByRole("radio", { name: "Consumed" }).check();
    await dialog.getByRole("button", { name: "Continue" }).click();
    await dialog.getByRole("button", { name: "Apply change" }).click();
    await expect(dialog.getByRole("alert").textContent()).resolves.toContain("view-only access");
    expect(db().getSpecimen(s.accession)!).toEqual(s);

    const cookie = await cookieFor(VIEWER, VIEWER_PASSWORD);
    const u = db().listUnits()[0]!;
    const attempts = [
      await svc(cookie, "POST", `/svc/specimens/${s.accession}/custody`, { text: "viewer entry" }),
      await svc(cookie, "POST", `/svc/specimens/${s.accession}/hold`, { action: "place", reason: "x", version: s.version }),
      await svc(cookie, "PATCH", `/svc/specimens/${s.accession}`, { field: "position", value: "R1-B1-01", version: s.version }),
      await svc(cookie, "PATCH", `/svc/units/${u.id}`, { field: "service", value: "service_requested", version: u.version }),
      await svc(cookie, "DELETE", `/svc/specimens/${s.accession}`),
    ];
    for (const a of attempts) expect(a).toMatchObject({ status: 403, data: { error: "read_only" } });
    expect(arena.stats().apps[APP].deniedWrites - denied).toBe(1 + attempts.length);
    expect(db().getSpecimen(s.accession)!).toEqual(s);
    expect(db().getUnit(u.id)!).toEqual(u);
    // Reads are fine.
    expect((await svc(cookie, "GET", `/svc/specimens/${s.accession}`)).status).toBe(200);
    await vctx.close();
  });
});

describe("variations on the fourth app", () => {
  it("renames the apply button and asks for confirmation before writing", async () => {
    vary({ renameButtons: { [APP]: { "Apply change": "Commit change" } }, confirmModal: { [APP]: true } });
    const s = freeSpecimen();
    await openSpecimen(page, s.accession);
    await page.getByRole("button", { name: "Change state…" }).click();
    const wizard = page.getByRole("dialog", { name: /Change state/ });
    await wizard.getByRole("radio", { name: "Reserved" }).check();
    await wizard.getByRole("button", { name: "Continue" }).click();
    expect(await wizard.getByRole("button", { name: "Apply change" }).count()).toBe(0);
    await wizard.getByRole("button", { name: "Commit change" }).click();
    const confirm = page.getByRole("dialog", { name: "Are you sure?" });
    await confirm.getByRole("button", { name: "Go back" }).click();
    await confirm.waitFor({ state: "detached" });
    expect(db().getSpecimen(s.accession)!.state).toBe("available");
    await wizard.getByRole("button", { name: "Commit change" }).click();
    await confirm.getByRole("button", { name: "Yes, continue" }).click();
    await expect.poll(() => db().getSpecimen(s.accession)!.state).toBe("reserved");
  });

  it("injects failures: 500 after commit still writes (so a retry duplicates); 503 before commit does not", async () => {
    const s = freeSpecimen();
    const count = () => db().custody(s.accession, { limit: 100 }).entries.filter((e) => e.text === "Failure test entry").length;
    const st0 = arena.stats().apps[APP];
    vary({ failures: { [APP]: { beforeCommitRate: 0, afterCommitRate: 1 } } });
    await openSpecimen(page, s.accession);
    await page.getByRole("button", { name: "Add entry" }).click();
    await page.getByLabel("New entry").fill("Failure test entry");
    const [r500] = await Promise.all([page.waitForResponse((r) => r.request().method() === "POST"), page.getByRole("button", { name: "Record entry" }).click()]);
    expect(r500.status()).toBe(500);
    await expect(page.locator(".rw-alert").textContent()).resolves.toContain("Something went wrong");
    expect(count()).toBe(1);

    vary({ failures: { [APP]: { beforeCommitRate: 1, afterCommitRate: 0 } } });
    const [r503] = await Promise.all([page.waitForResponse((r) => r.request().method() === "POST"), page.getByRole("button", { name: "Record entry" }).click()]);
    expect(r503.status()).toBe(503);
    expect(r503.headers()["retry-after"]).toBe("1");
    expect(count()).toBe(1);
    const st1 = arena.stats().apps[APP];
    expect(st1.injectedAfterCommit - st0.injectedAfterCommit).toBe(1);
    expect(st1.injectedBeforeCommit - st0.injectedBeforeCommit).toBe(1);
  });

  it("applies latency and the concurrency limit (429 with Retry-After, JSON for JSON callers)", async () => {
    const cookie = await cookieFor(USERNAME, PASSWORD);
    vary({ concurrencyLimit: { [APP]: 2 }, latency: { [APP]: { baseMs: 300, jitterMs: 0, slowRate: 0, slowMs: 0 } } });
    const before = arena.stats().apps[APP].throttled429;
    const t0 = Date.now();
    const responses = await Promise.all(Array.from({ length: 6 }, () => fetch(origin + "/svc/boot", { headers: { cookie, accept: "application/json" } })));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    const statuses = responses.map((r) => r.status);
    expect(statuses.filter((x) => x === 429).length).toBeGreaterThanOrEqual(1);
    expect(statuses.filter((x) => x === 200).length).toBeGreaterThanOrEqual(1);
    const limited = responses.find((r) => r.status === 429)!;
    expect(limited.headers.get("retry-after")).toBe("1");
    expect(await limited.json()).toMatchObject({ error: "too_many_requests" });
    await Promise.all(responses.filter((r) => r !== limited).map((r) => r.text()));
    expect(arena.stats().apps[APP].throttled429 - before).toBe(statuses.filter((x) => x === 429).length);
  });

  it("applies page size, tabs, field shuffling, and the announcement overlay", async () => {
    vary({ pageSize: { [APP]: 5 } });
    await page.goto(`${origin}/#/specimens`);
    await page.reload();
    const rows = page.locator("ul.rw-rows > li[data-key]");
    await expect.poll(() => rows.count()).toBe(5);
    await page.getByRole("button", { name: "Load more" }).click();
    await expect.poll(() => rows.count()).toBe(10);

    const s = freeSpecimen();
    const labels = () => page.locator(".rw-detail .rw-fields dt").allTextContents();
    arena.setVariations(defaults());
    await openSpecimen(page, s.accession);
    await page.reload();
    await page.getByRole("heading", { level: 2, name: s.accession }).waitFor();
    const original = await labels();
    vary({ shuffleFields: { [APP]: 777 } });
    await page.reload();
    await page.getByRole("heading", { level: 2, name: s.accession }).waitFor();
    const shuffled = await labels();
    expect(shuffled).not.toEqual(original);
    expect([...shuffled].sort()).toEqual([...original].sort());

    vary({ editInTab: { [APP]: true } });
    await page.reload();
    const change = page.getByRole("button", { name: "Change state…" });
    await page.getByRole("tab", { name: "Summary" }).waitFor();
    expect(await change.isVisible()).toBe(false);
    await page.getByRole("tab", { name: "Handling" }).click();
    expect(await change.isVisible()).toBe(true);

    vary({ announcementModal: { [APP]: true } });
    await page.reload();
    const news = page.getByRole("dialog", { name: "What's new in Rimewell" });
    await news.waitFor();
    await news.getByRole("button", { name: "Got it" }).click();
    await news.waitFor({ state: "detached" });
    await page.reload();
    await page.getByRole("tab", { name: "Specimens" }).waitFor();
    await page.locator('[data-key]').first().waitFor();
    expect(await news.count()).toBe(0);
  });

  it("is targeted by the judge surprises", async () => {
    const renamed = await api<VariationConfig>("POST", "/api/judge/surprise", { kind: "rename-save", app: APP });
    expect(renamed.data.renameButtons).toEqual({ [APP]: { "Apply change": "Commit change" } });
    const all = await api<VariationConfig>("POST", "/api/judge/surprise", { kind: "partial-failure", app: "all" });
    expect(all.data.failures[APP]).toEqual({ beforeCommitRate: 0.1, afterCommitRate: 0.1 });
    const cleared = await api<VariationConfig>("POST", "/api/judge/surprise", { kind: "clear", app: APP });
    expect(cleared.data.failures[APP]).toBeUndefined();
    expect(cleared.data.failures.CRM).toBeDefined();
  });
});

describe("read-only audit", () => {
  it("no GET route of the fourth app changes business data (/logout only ends the session)", async () => {
    const cookie = await cookieFor(USERNAME, PASSWORD);
    const d0 = arena.store.dump();
    const writes0 = arena.stats().apps[APP].writes;
    const ids = [d0.holdout.specimens[0]!.accession, d0.holdout.participants[0]!.code, d0.holdout.units[0]!.id, "missing-id"];
    const gets = arena.routes()[APP].filter((r) => r.method === "GET").sort((a, b) => Number(a.url === "/logout") - Number(b.url === "/logout"));
    expect(gets.length).toBeGreaterThan(10);
    for (const r of gets) {
      const urls = r.url.includes(":") ? ids.map((id) => r.url.replace(/:[^/]+/g, encodeURIComponent(id))) : [r.url];
      for (const u of urls) {
        const res = await fetch(`${origin}${u}?offset=1&before=999&q=a&next=/`, { redirect: "manual", headers: { cookie, accept: "application/json" } });
        expect(res.status, `GET ${u}`).toBeLessThan(500);
        await res.text();
      }
    }
    expect(arena.store.dump()).toEqual(d0);
    expect(arena.stats().apps[APP].writes).toBe(writes0);
  });
});
