import type { CheckResult, FieldMismatch } from "@overclock/contracts";
import type { Dataset } from "./model";
import type { EntityKey, Expectation } from "./rules";

/**
 * Independent ground-truth checker. Reads the arena databases directly (privileged access the
 * agent never has) and compares them with the oracle's expected end state.
 */

const TRACKED: Record<"customer" | "order" | "ticket", string[]> = {
  customer: ["name", "email", "phone", "city", "status"],
  order: ["customer_id", "customer_email", "status", "tracking", "review_flag", "review_reason"],
  ticket: ["category", "status", "owner", "subject"],
};

function norm(v: unknown): string {
  return String(v ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function entityMap(d: Dataset): Map<EntityKey, Record<string, unknown>> {
  const m = new Map<EntityKey, Record<string, unknown>>();
  for (const c of d.customers) m.set(`customer:${c.id}`, c as unknown as Record<string, unknown>);
  for (const o of d.orders) m.set(`order:${o.id}`, o as unknown as Record<string, unknown>);
  for (const t of d.tickets) m.set(`ticket:${t.id}`, t as unknown as Record<string, unknown>);
  return m;
}

export function check(scenarioId: string, base: Dataset, current: Dataset, exp: Expectation): CheckResult {
  const baseE = entityMap(base);
  const curE = entityMap(current);
  const baseNoteIds = new Set(base.notes.map((n) => n.id));
  const newNotes = current.notes.filter((n) => !baseNoteIds.has(n.id));
  const newNotesByTicket = new Map<string, string[]>();
  for (const n of newNotes) (newNotesByTicket.get(n.ticket_id) ?? newNotesByTicket.set(n.ticket_id, []).get(n.ticket_id)!).push(norm(n.body));

  const mismatches: FieldMismatch[] = [];
  let correct = 0;
  let duplicateWrites = 0;
  const explainedNotes = new Map<string, number>();

  for (const r of exp.records) {
    let ok = true;
    for (const e of r.entities) {
      const kind = e.key.split(":")[0] as "customer" | "order" | "ticket";
      const b = baseE.get(e.key);
      const c = curE.get(e.key);
      if (!b || !c) {
        ok = false;
        mismatches.push({ recordKey: r.recordKey, entity: e.key, field: "*", expected: "exists", actual: "missing" });
        continue;
      }
      for (const field of TRACKED[kind]) {
        const expected = field in e.fields ? e.fields[field] : b[field];
        if (norm(c[field]) !== norm(expected)) {
          ok = false;
          mismatches.push({ recordKey: r.recordKey, entity: e.key, field, expected, actual: c[field] });
        }
      }
    }
    for (const n of r.notes) {
      const bodies = newNotesByTicket.get(n.ticketId) ?? [];
      const count = bodies.filter((b) => b === norm(n.body)).length;
      explainedNotes.set(`${n.ticketId}|${norm(n.body)}`, count);
      if (count !== 1) {
        ok = false;
        mismatches.push({ recordKey: r.recordKey, entity: `ticket:${n.ticketId}`, field: "note", expected: `${n.body} (exactly once)`, actual: `${count} copies` });
      }
      if (count > 1) duplicateWrites += count - 1;
    }
    // Notes added to this record's tickets that no rule asked for.
    for (const e of r.entities.filter((x) => x.key.startsWith("ticket:"))) {
      const tid = e.key.slice("ticket:".length);
      const unexpected = (newNotesByTicket.get(tid) ?? []).filter((b) => !r.notes.some((n) => n.ticketId === tid && norm(n.body) === b));
      if (unexpected.length) {
        ok = false;
        mismatches.push({ recordKey: r.recordKey, entity: e.key, field: "note", expected: "no extra notes", actual: unexpected.slice(0, 3) });
      }
    }
    if (ok) correct++;
  }

  // Collateral: any change to an entity no record covers, or notes on uncovered tickets.
  let collateral = 0;
  for (const [key, c] of curE) {
    if (exp.covered.has(key)) continue;
    const b = baseE.get(key);
    const kind = key.split(":")[0] as "customer" | "order" | "ticket";
    if (!b) {
      collateral++;
      continue;
    }
    if (TRACKED[kind].some((f) => norm(c[f]) !== norm(b[f]))) collateral++;
  }
  for (const [tid, bodies] of newNotesByTicket) if (!exp.covered.has(`ticket:${tid}`)) collateral += bodies.length;

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
