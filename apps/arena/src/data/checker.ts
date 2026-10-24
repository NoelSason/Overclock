import type { CheckResult, FieldMismatch } from "@overclock/contracts";
import { HOLDOUT_TRACKED, holdoutAppends, holdoutEntities } from "../holdout/task";
import { emptyHoldout } from "../holdout/model";
import type { Dataset } from "./model";
import type { EntityKey, EntityKind, Expectation } from "./rules";

/**
 * Independent ground-truth checker. Reads the arena databases directly (privileged access the
 * agent never has) and compares them with the oracle's expected end state.
 */

const TRACKED: Record<EntityKind, string[]> = {
  customer: ["name", "email", "phone", "city", "status"],
  order: ["customer_id", "customer_email", "status", "tracking", "review_flag", "review_reason"],
  ticket: ["category", "status", "owner", "subject"],
  ...HOLDOUT_TRACKED,
};

function norm(v: unknown): string {
  return String(v ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function kindOf(key: EntityKey): EntityKind {
  return key.slice(0, key.indexOf(":")) as EntityKind;
}

/** Every entity in the dataset, keyed `kind:id`. */
export function entityMap(d: Dataset): Map<EntityKey, Record<string, unknown>> {
  const m = new Map<EntityKey, Record<string, unknown>>();
  for (const c of d.customers) m.set(`customer:${c.id}`, c as unknown as Record<string, unknown>);
  for (const o of d.orders) m.set(`order:${o.id}`, o as unknown as Record<string, unknown>);
  for (const t of d.tickets) m.set(`ticket:${t.id}`, t as unknown as Record<string, unknown>);
  for (const [k, v] of holdoutEntities(d.holdout ?? emptyHoldout())) m.set(k, v);
  return m;
}

/** Every append-only entry (ticket notes, custody entries), keyed by the entity it belongs to. */
export function appendEntries(d: Dataset): { id: string; key: EntityKey; body: string }[] {
  return [...d.notes.map((n) => ({ id: `note:${n.id}`, key: `ticket:${n.ticket_id}` as EntityKey, body: n.body })), ...holdoutAppends(d.holdout ?? emptyHoldout())];
}

export function check(scenarioId: string, base: Dataset, current: Dataset, exp: Expectation): CheckResult {
  const baseE = entityMap(base);
  const curE = entityMap(current);
  const baseAppendIds = new Set(appendEntries(base).map((a) => a.id));
  const newByKey = new Map<EntityKey, string[]>();
  for (const a of appendEntries(current)) if (!baseAppendIds.has(a.id)) (newByKey.get(a.key) ?? newByKey.set(a.key, []).get(a.key)!).push(norm(a.body));

  const mismatches: FieldMismatch[] = [];
  let correct = 0;
  let duplicateWrites = 0;

  for (const r of exp.records) {
    let ok = true;
    for (const e of r.entities) {
      const b = baseE.get(e.key);
      const c = curE.get(e.key);
      if (!b || !c) {
        ok = false;
        mismatches.push({ recordKey: r.recordKey, entity: e.key, field: "*", expected: "exists", actual: "missing" });
        continue;
      }
      for (const field of TRACKED[kindOf(e.key)]) {
        const expected = field in e.fields ? e.fields[field] : b[field];
        if (norm(c[field]) !== norm(expected)) {
          ok = false;
          mismatches.push({ recordKey: r.recordKey, entity: e.key, field, expected, actual: c[field] });
        }
      }
    }
    const appends = [...r.notes.map((n) => ({ key: `ticket:${n.ticketId}` as EntityKey, body: n.body })), ...(r.appends ?? [])];
    for (const n of appends) {
      const count = (newByKey.get(n.key) ?? []).filter((b) => b === norm(n.body)).length;
      if (count !== 1) {
        ok = false;
        mismatches.push({ recordKey: r.recordKey, entity: n.key, field: n.key.startsWith("ticket:") ? "note" : "entry", expected: `${n.body} (exactly once)`, actual: `${count} copies` });
      }
      if (count > 1) duplicateWrites += count - 1;
    }
    // Entries added to this record's entities that no rule asked for.
    for (const e of r.entities) {
      const unexpected = (newByKey.get(e.key) ?? []).filter((b) => !appends.some((n) => n.key === e.key && norm(n.body) === b));
      if (unexpected.length) {
        ok = false;
        const ticket = e.key.startsWith("ticket:");
        mismatches.push({ recordKey: r.recordKey, entity: e.key, field: ticket ? "note" : "entry", expected: ticket ? "no extra notes" : "no extra entries", actual: unexpected.slice(0, 3) });
      }
    }
    if (ok) correct++;
  }

  // Collateral: any change to an entity no record covers, or entries on uncovered entities.
  let collateral = 0;
  for (const [key, c] of curE) {
    if (exp.covered.has(key)) continue;
    const b = baseE.get(key);
    if (!b) {
      collateral++;
      continue;
    }
    if (TRACKED[kindOf(key)].some((f) => norm(c[f]) !== norm(b[f]))) collateral++;
  }
  for (const [key, bodies] of newByKey) if (!exp.covered.has(key)) collateral += bodies.length;

  const total = exp.records.length;
  return {
    scenarioId,
    totalRecords: total,
    correctRecords: correct,
    accuracy: total ? correct / total : 1,
    mismatches,
    duplicateWrites,
    collateralWrites: collateral,
    escalationExpected: exp.records.filter((r) => r.escalated).length,
    checkedAt: Date.now(),
  };
}
