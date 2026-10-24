// HOLDOUT FIXTURE — engine/prompt developers must not read this file.
import type { EntityKey, Expectation, RecordExpectation, TemplateInfo } from "../data/rules";
import { HOLDOUT_APP } from "./meta";
import { CONSENTS, SERVICE_STATUSES, SPECIMEN_STATES, type Excursion, type HoldoutData } from "./model";
import type { HoldoutStore } from "./store";

/**
 * The holdout task template: natural-language rules for the agent, the pure-code oracle that
 * computes the expected end state, and the hooks the shared checker and judge tools need.
 */

export type HoldoutEntityKind = "specimen" | "participant" | "unit";
export const HOLDOUT_ENTITY_KINDS: readonly HoldoutEntityKind[] = ["specimen", "participant", "unit"];

export function isHoldoutEntityKind(v: unknown): v is HoldoutEntityKind {
  return typeof v === "string" && (HOLDOUT_ENTITY_KINDS as readonly string[]).includes(v);
}

export const HOLD_DUPLICATE = "Duplicate label";
export const HOLD_UNKNOWN = "Unknown participant";
export const ENTRY_WITHDRAWN = "Discard requested: consent withdrawn";
export const entryQuarantine = (excursionId: string) => `Quarantined: excursion ${excursionId}`;
const PEAK_LIMIT_C = -60;
const BATCH_THRESHOLD = 3;

export const HOLDOUT_TEMPLATE: TemplateInfo = {
  id: "t4-holdout",
  title: "Quarterly specimen audit (holdout)",
  apps: [HOLDOUT_APP],
  recordField: "accession",
  holdout: true,
  goal: (n) =>
    [
      `Audit these ${n} specimens in the Rimewell sample registry. Each specimen is identified by its accession number.`,
      "",
      "Rules, for each specimen in the list. Apply them in order and stop at the first rule that applies:",
      "1. Already on review hold: leave the specimen unchanged.",
      `2. Duplicate tube label: if any other specimen in the registry has the same tube label, place a review hold with the reason "${HOLD_DUPLICATE}". Change nothing else.`,
      `3. Unknown participant: if the specimen's participant is not registered, place a review hold with the reason "${HOLD_UNKNOWN}". Change nothing else.`,
      `4. Withdrawn consent: if the participant's consent is Withdrawn, set the state to Discard pending and add the custody entry "${ENTRY_WITHDRAWN}". If the state is already Discard pending or Consumed, leave the specimen unchanged.`,
      `5. Temperature excursion: if the state is Available or Reserved and the specimen's storage unit logged an excursion with a peak warmer than ${PEAK_LIMIT_C} °C that started after the specimen was stored, set the state to Quarantined and add the custody entry "Quarantined: excursion <excursion ID>", naming the most recent such excursion.`,
      "6. Otherwise leave the specimen unchanged.",
      "",
      `Batch rule: if ${BATCH_THRESHOLD} or more specimens from this list were quarantined under rule 5 in the same storage unit, set that unit's service status to Service requested.`,
      "",
      "Do not change anything that these rules do not require. Never release a hold or delete anything.",
    ].join("\n"),
};

/** Expected end state for the batch. Pure function of the base data. */
export function holdoutExpectation(d: HoldoutData, keys: string[]): Expectation {
  const specimens = new Map(d.specimens.map((s) => [s.accession, s]));
  const participants = new Map(d.participants.map((p) => [p.code, p]));
  const units = new Map(d.units.map((u) => [u.id, u]));
  const labelCount = new Map<string, number>();
  for (const s of d.specimens) labelCount.set(s.label_code, (labelCount.get(s.label_code) ?? 0) + 1);
  const excursions = new Map<string, Excursion[]>();
  for (const e of d.excursions) (excursions.get(e.unit_id) ?? excursions.set(e.unit_id, []).get(e.unit_id)!).push(e);

  const records: RecordExpectation[] = [];
  const unitOf = new Map<RecordExpectation, string>();
  const quarantined = new Map<string, number>();
  for (const k of keys) {
    const exp: RecordExpectation = { recordKey: k, entities: [], notes: [], appends: [], escalated: false, needsChange: false };
    records.push(exp);
    const s = specimens.get(k);
    if (!s) {
      exp.entities.push({ key: `specimen:${k}`, fields: {} });
      continue;
    }
    const key: EntityKey = `specimen:${s.accession}`;
    const fields: Record<string, string | number> = { state: s.state, hold: s.hold, hold_reason: s.hold_reason };
    const p = participants.get(s.participant_code);
    if (s.hold === 1) {
      // Rule 1: already on hold.
    } else if ((labelCount.get(s.label_code) ?? 0) > 1) {
      fields.hold = 1;
      fields.hold_reason = HOLD_DUPLICATE;
      exp.escalated = true;
    } else if (!p) {
      fields.hold = 1;
      fields.hold_reason = HOLD_UNKNOWN;
      exp.escalated = true;
    } else if (p.consent === "withdrawn") {
      if (s.state !== "discard_pending" && s.state !== "consumed") {
        fields.state = "discard_pending";
        exp.appends!.push({ key, body: ENTRY_WITHDRAWN });
      }
    } else if (s.state === "available" || s.state === "reserved") {
      const stored = Date.parse(s.stored_at);
      const latest = (excursions.get(s.unit_id) ?? [])
        .filter((e) => e.peak_c > PEAK_LIMIT_C && Date.parse(e.started_at) > stored)
        .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at) || (a.id < b.id ? 1 : -1))[0];
      if (latest) {
        fields.state = "quarantined";
        exp.appends!.push({ key, body: entryQuarantine(latest.id) });
        quarantined.set(s.unit_id, (quarantined.get(s.unit_id) ?? 0) + 1);
      }
    }
    exp.needsChange = fields.state !== s.state || fields.hold !== s.hold || fields.hold_reason !== s.hold_reason || exp.appends!.length > 0;
    exp.entities.push({ key, fields });
    unitOf.set(exp, s.unit_id);
  }
  // Batch rule: a cross-record aggregate over the whole list.
  for (const [exp, unitId] of unitOf) {
    const u = units.get(unitId);
    if (!u) continue;
    const service = (quarantined.get(unitId) ?? 0) >= BATCH_THRESHOLD ? "service_requested" : u.service;
    if (service !== u.service) exp.needsChange = true;
    exp.entities.push({ key: `unit:${unitId}`, fields: { service } });
  }
  const covered = new Set<EntityKey>();
  for (const r of records) for (const e of r.entities) covered.add(e.key);
  return { records, covered };
}

// Checker hooks ------------------------------------------------------------------------------

/** Fields compared by the checker (expected value = oracle value, else the base value). */
export const HOLDOUT_TRACKED: Record<HoldoutEntityKind, string[]> = {
  specimen: ["label_code", "material", "participant_code", "unit_id", "position", "stored_at", "state", "hold", "hold_reason", "handling_note"],
  participant: ["consent", "site"],
  unit: ["name", "location", "service"],
};

export function holdoutEntities(d: HoldoutData): [EntityKey, Record<string, unknown>][] {
  const out: [EntityKey, Record<string, unknown>][] = [];
  for (const s of d.specimens) out.push([`specimen:${s.accession}`, s as unknown as Record<string, unknown>]);
  for (const p of d.participants) out.push([`participant:${p.code}`, p as unknown as Record<string, unknown>]);
  for (const u of d.units) out.push([`unit:${u.id}`, u as unknown as Record<string, unknown>]);
  return out;
}

/** Append-only entries, keyed by the entity they belong to. */
export function holdoutAppends(d: HoldoutData): { id: string; key: EntityKey; body: string }[] {
  return d.custody.map((c) => ({ id: `custody:${c.id}`, key: `specimen:${c.accession}`, body: c.text }));
}

// Judge tools --------------------------------------------------------------------------------

export type HoldoutFieldRule = "text" | "flag" | { values: readonly string[] };

export const HOLDOUT_EDITABLE: Record<HoldoutEntityKind, Record<string, HoldoutFieldRule>> = {
  specimen: { state: { values: SPECIMEN_STATES }, hold: "flag", hold_reason: "text", position: "text", handling_note: "text", label_code: "text", participant_code: "text" },
  participant: { consent: { values: CONSENTS }, site: "text" },
  unit: { service: { values: SERVICE_STATUSES } },
};

export function holdoutEntityExists(store: HoldoutStore, kind: HoldoutEntityKind, id: string): boolean {
  if (kind === "specimen") return !!store.getSpecimen(id);
  if (kind === "participant") return !!store.getParticipant(id);
  return !!store.getUnit(id);
}

/** Apply a judge edit to the live database and to the scenario's base snapshot. */
export function applyHoldoutEdit(store: HoldoutStore, base: HoldoutData, kind: HoldoutEntityKind, id: string, patch: Record<string, string | number>): boolean {
  if (kind === "specimen") {
    const ok = !!store.updateSpecimen(id, patch);
    const b = base.specimens.find((x) => x.accession === id);
    if (b) Object.assign(b, patch, { version: b.version + 1 });
    return ok;
  }
  if (kind === "participant") {
    const ok = !!store.updateParticipant(id, patch);
    const b = base.participants.find((x) => x.code === id);
    if (b) Object.assign(b, patch, { version: b.version + 1 });
    return ok;
  }
  const ok = !!store.updateUnit(id, patch);
  const b = base.units.find((x) => x.id === id);
  if (b) Object.assign(b, patch, { version: b.version + 1 });
  return ok;
}

/** Source-data changes for one unprocessed record that change what the rules require. */
export function planHoldoutJudgeEdits(
  store: HoldoutStore,
  recordKey: string,
  untouched: ReadonlySet<string>,
  listed: readonly string[],
): { entity: HoldoutEntityKind; id: string; patch: Record<string, string | number> }[] {
  const s = store.getSpecimen(recordKey);
  if (!s) return [];
  const options: { entity: HoldoutEntityKind; id: string; patch: Record<string, string | number> }[] = [];
  const p = store.getParticipant(s.participant_code);
  // Flip consent only when no processed record shares the participant.
  if (p) {
    const listedSet = new Set(listed);
    const shared = store.specimensOfParticipant(p.code).filter((x) => listedSet.has(x.accession));
    if (shared.every((x) => untouched.has(x.accession))) options.push({ entity: "participant", id: p.code, patch: { consent: p.consent === "withdrawn" ? "active" : "withdrawn" } });
  }
  if (s.hold === 0 && (s.state === "available" || s.state === "reserved")) options.push({ entity: "specimen", id: s.accession, patch: { state: "consumed" } });
  return options;
}
