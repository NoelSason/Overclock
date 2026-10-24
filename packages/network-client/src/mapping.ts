import type { CapabilityCandidate, NetworkActivity, RepairJobView } from "@overclock/network-contracts";
import { RepairJobStatus } from "@overclock/network-contracts";
import type { Timestamp } from "spacetimedb";
import type { Activity, CapabilityVersions, RepairJobs } from "./generated/types";

/** Server timestamp (microseconds) as fractional epoch milliseconds. */
export function tsMs(t: Timestamp): number {
  return Number(t.microsSinceUnixEpoch) / 1000;
}

/** Local wall clock with sub-millisecond resolution (same epoch as Date.now()). */
export function nowMs(): number {
  return performance.timeOrigin + performance.now();
}

export function toCandidate(v: CapabilityVersions, successfulReuses: number): CapabilityCandidate {
  return {
    capabilityId: v.capabilityId,
    versionId: v.versionId,
    version: v.version,
    canonicalOperation: v.canonicalOperation,
    origins: [...v.origins],
    interfaceFingerprints: [...v.interfaceFingerprints],
    state: v.state,
    contentHash: v.contentHash,
    bytes: v.byteSize,
    publisherId: v.publisher.toHexString(),
    validations: v.passValidations,
    successfulReuses,
    updatedAt: tsMs(v.updatedAt),
  };
}

export function toRepairJobView(j: RepairJobs): RepairJobView {
  const status = RepairJobStatus.safeParse(j.status);
  return {
    jobId: j.jobId,
    capabilityId: j.capabilityId,
    version: j.version,
    signatureKey: j.signatureKey,
    category: j.category,
    status: status.success ? status.data : "open",
    holder: j.holder?.toHexString(),
    leaseExpiresAt: j.leaseExpiresAt ? tsMs(j.leaseExpiresAt) : undefined,
    fencingToken: Number(j.fencingToken),
    attempts: j.attempts,
    proposedVersionId: j.proposedVersionId === "" ? undefined : j.proposedVersionId,
    reporters: j.reporters,
    createdAt: tsMs(j.createdAt),
    updatedAt: tsMs(j.updatedAt),
  };
}

export function toActivity(a: Activity): NetworkActivity {
  return {
    at: tsMs(a.at),
    kind: a.kind,
    actor: a.actorLabel,
    capabilityId: a.capabilityId === "" ? undefined : a.capabilityId,
    version: a.version === 0 ? undefined : a.version,
    detail: a.detail,
  };
}

/** Normalize to scheme://host[:port] (mirrors the module's normalization). */
export function normalizeOrigin(raw: string): string {
  const u = new URL(raw.trim());
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`unsupported origin scheme ${u.protocol}`);
  return u.origin.toLowerCase();
}

/** Median of a bounded sample window. */
export class Samples {
  private readonly values: number[] = [];
  count = 0;

  constructor(private readonly capacity = 1000) {}

  add(v: number): void {
    this.count++;
    this.values.push(v);
    if (this.values.length > this.capacity) this.values.shift();
  }

  p50(): number {
    if (this.values.length === 0) return 0;
    const sorted = [...this.values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
}
