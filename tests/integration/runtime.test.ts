import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BrowserManager, BrowserWorker, runSegment, VerificationFailedError, WriteUncertainError, type RecordScope } from "@overclock/browser-runtime";
import { startMiniApp, type MiniApp } from "../fixtures/mini-app";
import { loc, node } from "../fixtures/ir";

let app: MiniApp;
let browser: BrowserManager;

beforeAll(async () => {
  app = await startMiniApp();
  browser = new BrowserManager({ headless: true });
});
afterAll(async () => {
  await browser.close();
  await app.close();
});

async function worker(opts: { blockMutations?: boolean } = {}) {
  const ctx = await browser.newContext({ allowedOrigins: [app.origin], ...opts });
  return new BrowserWorker("w-test", ctx, new Map([["mini", app.origin]]), () => undefined);
}

function scope(rec: Record<string, unknown>): RecordScope {
  return { key: String(rec.id ?? "x"), rec, input: {}, out: {}, phase: {} };
}

// Hand-written IR, test-only: exercises the executor without a planner.
const editProgram = [
  node({ id: "open_edit", type: "navigate", app: "mini", url: { template: "/items/{$rec.id}/edit" } }),
  node({ id: "set_status", type: "select", app: "mini", target: loc({ kind: "label", text: "Status" }), input: { expr: "$rec.status" } }),
  node({ id: "add_note", type: "fill", app: "mini", target: loc({ kind: "label", text: "Add note" }), input: { template: "Reconciled {$rec.id}" } }),
  node({
    id: "save",
    type: "click",
    app: "mini",
    effect: "remote-write",
    retryPolicy: "verify-before-retry",
    target: loc({ kind: "role", role: "button", name: "Save" }),
    verify: {
      url: { template: "/items/{$rec.id}" },
      fields: [
        { name: "status", target: loc({ kind: "testId", id: "status" }), equals: { expr: "$rec.status" }, attr: "text" },
        { name: "notes", target: loc({ kind: "testId", id: "notes" }), equals: { template: "Reconciled {$rec.id}" }, attr: "text" },
      ],
    },
  }),
];

describe("browser runtime (hand-written IR)", () => {
  it("executes a write segment and verifies it by fresh read-back", async () => {
    const w = await worker();
    const s = scope({ id: "I-2", status: "closed" });
    const r = await runSegment(w, { taskId: "t1", app: "mini", nodes: editProgram, scope: s, allowedOrigins: new Set([app.origin]), locatorOverrides: new Map() });
    expect(r.receipts).toHaveLength(1);
    expect(r.receipts[0]!.readBack.ok).toBe(true);
    expect(app.items.get("I-2")!.status).toBe("closed");
    expect(app.items.get("I-2")!.notes).toEqual(["Reconciled I-2"]);
    expect(r.modelCalls).toBe(0);
    await w.close();
  });

  it("extracts a paginated table into keyed rows", async () => {
    const w = await worker();
    const s = scope({});
    const r = await runSegment(w, {
      taskId: "t2",
      app: "mini",
      scope: s,
      allowedOrigins: new Set([app.origin]),
      locatorOverrides: new Map(),
      nodes: [
        node({ id: "list", type: "navigate", app: "mini", url: { value: "/items" } }),
        node({
          id: "scan",
          type: "extract",
          app: "mini",
          table: { target: loc({ kind: "role", role: "table" }), columns: { id: "ID", status: "Status" }, key: "id", linkColumns: ["id"], pagination: { next: loc({ kind: "role", role: "link", name: "Next page" }), maxPages: 10 } },
        }),
      ],
    });
    const rows = (r.outputs.scan as { rows: { id: string; status: string; idHref: string }[]; pages: number }).rows;
    expect(rows).toHaveLength(23);
    expect((r.outputs.scan as { pages: number }).pages).toBe(3);
    expect(rows[0]).toMatchObject({ id: "I-1", idHref: "/items/I-1" });
    await w.close();
  });

  it("reports an after-commit 500 as uncertain, and read-back shows it committed", async () => {
    const w = await worker();
    app.failNextWrite = "after-commit-500";
    const s = scope({ id: "I-4", status: "closed" });
    const err = await runSegment(w, { taskId: "t3", app: "mini", nodes: editProgram, scope: s, allowedOrigins: new Set([app.origin]), locatorOverrides: new Map() }).catch((e) => e);
    expect(err).toBeInstanceOf(WriteUncertainError);
    expect(app.items.get("I-4")!.notes).toEqual(["Reconciled I-4"]); // the write did commit
    await w.close();
  });

  it("fails verification when the write did not take effect", async () => {
    const w = await worker();
    const s = scope({ id: "I-5", status: "closed" });
    // Verify against a value we never wrote: read-back must catch it.
    const bad = editProgram.map((n) => (n.id === "save" ? { ...n, verify: { ...n.verify!, fields: [{ ...n.verify!.fields[0]!, equals: { value: "archived" } }] } } : n));
    const err = await runSegment(w, { taskId: "t4", app: "mini", nodes: bad, scope: s, allowedOrigins: new Set([app.origin]), locatorOverrides: new Map() }).catch((e) => e);
    expect(err).toBeInstanceOf(VerificationFailedError);
    await w.close();
  });

  it("blocks mutations in exploration contexts and off-allowlist origins", async () => {
    const w = await worker({ blockMutations: true });
    const s = scope({ id: "I-7", status: "closed" });
    const before = app.writes;
    await runSegment(w, { taskId: "t5", app: "mini", nodes: editProgram, scope: s, allowedOrigins: new Set([app.origin]), locatorOverrides: new Map() }).catch(() => undefined);
    expect(app.writes).toBe(before);
    expect(browser.guardStats.get(w.context)!.blockedMutations).toBeGreaterThan(0);
    const offList = await runSegment(w, {
      taskId: "t6",
      app: "mini",
      scope: s,
      allowedOrigins: new Set([app.origin]),
      locatorOverrides: new Map(),
      nodes: [node({ id: "evil", type: "navigate", app: "mini", url: { value: "https://example.com/" } })],
    }).catch((e) => e);
    expect(String(offList)).toMatch(/outside the allowlist/);
    await w.close();
  });
});
