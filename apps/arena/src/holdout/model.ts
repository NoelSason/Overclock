// HOLDOUT FIXTURE — engine/prompt developers must not read this file.

/** Data model of the holdout application (its own database; nothing joins with the other apps). */

export type SpecimenState = "available" | "reserved" | "quarantined" | "discard_pending" | "consumed";
export type Material = "plasma" | "serum" | "whole_blood" | "dna" | "tissue";
export type Consent = "active" | "limited" | "withdrawn";
export type ServiceStatus = "normal" | "service_requested";

export interface Specimen {
  accession: string;
  label_code: string;
  material: Material;
  participant_code: string;
  unit_id: string;
  position: string;
  stored_at: string;
  state: SpecimenState;
  hold: 0 | 1;
  hold_reason: string;
  handling_note: string;
  updated_at: string;
  version: number;
}

export interface Participant {
  code: string;
  consent: Consent;
  consent_updated_at: string;
  site: string;
  version: number;
}

export interface Unit {
  id: string;
  name: string;
  location: string;
  setpoint_c: number;
  service: ServiceStatus;
  updated_at: string;
  version: number;
}

export interface Excursion {
  id: string;
  unit_id: string;
  started_at: string;
  peak_c: number;
  duration_min: number;
}

export interface CustodyEntry {
  id: number;
  accession: string;
  text: string;
  at: string;
  actor: string;
}

export interface HoldoutData {
  specimens: Specimen[];
  participants: Participant[];
  units: Unit[];
  excursions: Excursion[];
  custody: CustodyEntry[];
}

export const SPECIMEN_STATES: readonly SpecimenState[] = ["available", "reserved", "quarantined", "discard_pending", "consumed"];
export const MATERIALS: readonly Material[] = ["plasma", "serum", "whole_blood", "dna", "tissue"];
export const CONSENTS: readonly Consent[] = ["active", "limited", "withdrawn"];
export const SERVICE_STATUSES: readonly ServiceStatus[] = ["normal", "service_requested"];

export const LABELS = {
  state: { available: "Available", reserved: "Reserved", quarantined: "Quarantined", discard_pending: "Discard pending", consumed: "Consumed" } satisfies Record<SpecimenState, string>,
  material: { plasma: "Plasma", serum: "Serum", whole_blood: "Whole blood", dna: "DNA", tissue: "Tissue" } satisfies Record<Material, string>,
  consent: { active: "Active", limited: "Limited use", withdrawn: "Withdrawn" } satisfies Record<Consent, string>,
  service: { normal: "Normal", service_requested: "Service requested" } satisfies Record<ServiceStatus, string>,
};

export function emptyHoldout(): HoldoutData {
  return { specimens: [], participants: [], units: [], excursions: [], custody: [] };
}

export function oneOf<T extends string>(values: readonly T[], v: unknown): v is T {
  return typeof v === "string" && (values as readonly string[]).includes(v);
}
