import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generate } from "../../apps/arena/src/data/generate";
import { expectedOutcome, type Expectation } from "../../apps/arena/src/data/rules";
import { ArenaStore } from "../../apps/arena/src/data/store";
import { ScenarioManager } from "../../apps/arena/src/data/scenario";

const dirs: string[] = [];
function tempStore(): { store: ArenaStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "oc-arena-"));
  dirs.push(dir);
  return { store: new ArenaStore(dir), dir };
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Reference solver: applies exactly what the oracle expects (validates the checker, not an agent). */
function applyExpected(store: ArenaStore, exp: Expectation): void {
  const doneNotes = new Set<string>();
  for (const r of exp.records) {
    for (const e of r.entities) {
      const [kind, id] = e.key.split(/:(.+)/) as [string, string];
      if (kind === "order") store.orders.update(id, e.fields as never);
      if (kind === "ticket") store.support.update(id, e.fields as never);
      if (kind === "customer") store.crm.update(id, e.fields as never);
    }
    for (const n of r.notes) {
      const k = `${n.ticketId}|${n.body}`;
      if (!doneNotes.has(k)) store.support.addNote(n.ticketId, n.body);
      doneNotes.add(k);
    }
  }
}

describe("arena scenario generator and oracle", () => {
  it("is deterministic per seed", () => {
    const a = generate("t1-order-reconcile", 42, 60);
    const b = generate("t1-order-reconcile", 42, 60);
    const c = generate("t1-order-reconcile", 43, 60);
    expect(a).toEqual(b);
    expect(a.recordKeys).not.toEqual(c.recordKeys);
    expect(new Set(a.recordKeys).size).toBe(60);
  });

  it("produces a realistic mix of required changes for T1", () => {
    const g = generate("t1-order-reconcile", 7, 100);
    const exp = expectedOutcome("t1-order-reconcile", g.dataset, g.recordKeys);
    const needs = exp.records.filter((r) => r.needsChange).length;
    expect(needs).toBeGreaterThan(30);
    expect(needs).toBeLessThan(95);
    expect(exp.records.some((r) => r.escalated)).toBe(true);
    expect(exp.records.some((r) => r.notes.length > 0)).toBe(true);
    expect(exp.records.some((r) => r.entities.some((e) => e.key.startsWith("customer:") && e.fields.status === "on_hold"))).toBe(true);
  });

  for (const template of ["t1-order-reconcile", "t2-ticket-triage", "t3-crm-status-sync"] as const) {
    it(`checker scores a perfect solution at 100% (${template})`, () => {
      const { store, dir } = tempStore();
      const mgr = new ScenarioManager(store, { CRM: "http://localhost:4101", Orders: "http://localhost:4102", Support: "http://localhost:4103" }, dir);
      mgr.load({ seed: 11, template, records: 50 });
      const before = mgr.check()!;
      expect(before.accuracy).toBeLessThan(1); // untouched data is not already correct
      applyExpected(store, expectedOutcome(template, mgr.current!.base, mgr.current!.recordKeys));
      const after = mgr.check()!;
      expect(after.mismatches).toEqual([]);
      expect(after.accuracy).toBe(1);
      expect(after.collateralWrites).toBe(0);
      expect(after.duplicateWrites).toBe(0);
      store.close();
    });
  }

  it("detects duplicate notes and collateral writes", () => {
    const { store, dir } = tempStore();
    const mgr = new ScenarioManager(store, { CRM: "a", Orders: "b", Support: "c" }, dir);
    mgr.load({ seed: 5, template: "t1-order-reconcile", records: 40 });
    const exp = expectedOutcome("t1-order-reconcile", mgr.current!.base, mgr.current!.recordKeys);
    applyExpected(store, exp);
    const withNote = exp.records.find((r) => r.notes.length)!;
    store.support.addNote(withNote.notes[0]!.ticketId, withNote.notes[0]!.body); // duplicate write
    const listed = new Set(mgr.current!.recordKeys);
    const distractor = store.orders.all().find((o) => !listed.has(o.id))!;
    store.orders.update(distractor.id, { review_flag: 1, review_reason: "oops" }); // collateral
    const r = mgr.check()!;
    expect(r.duplicateWrites).toBe(1);
    expect(r.collateralWrites).toBeGreaterThanOrEqual(1);
    expect(r.correctRecords).toBe(r.totalRecords - 1);
    store.close();
  });

  it("reset restores the snapshot exactly", () => {
    const { store, dir } = tempStore();
    const mgr = new ScenarioManager(store, { CRM: "a", Orders: "b", Support: "c" }, dir);
    mgr.load({ seed: 3, template: "t2-ticket-triage", records: 20 });
    const snap = store.dump();
    applyExpected(store, expectedOutcome("t2-ticket-triage", mgr.current!.base, mgr.current!.recordKeys));
    expect(store.dump()).not.toEqual(snap);
    mgr.reset();
    expect(store.dump()).toEqual(snap);
    store.close();
  });
});
