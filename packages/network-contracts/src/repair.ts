import { z } from "zod";

/** Sanitized failure signature: identifies *what* broke, never *whose data* was involved. */
export const FailureSignature = z.object({
  capabilityId: z.string(),
  version: z.number(),
  category: z.enum(["control-missing", "control-ambiguous", "dialog", "hidden-control", "fingerprint-drift", "verification-mismatch", "precondition", "other"]),
  /** Portable control key or page route family that failed. */
  subject: z.string(),
  /** Hash of the observed (sanitized) region structure at failure time. */
  observedFingerprint: z.string().optional(),
});
export type FailureSignature = z.infer<typeof FailureSignature>;

export const RepairJobStatus = z.enum(["open", "leased", "proposed", "validated", "promoted", "failed", "abandoned"]);
export type RepairJobStatus = z.infer<typeof RepairJobStatus>;

export const RepairLease = z.object({
  jobId: z.string(),
  ok: z.boolean(),
  /** Monotonically increasing per job; every write by the holder must present the latest token. */
  fencingToken: z.number().int().optional(),
  holder: z.string().optional(),
  expiresAt: z.number().optional(),
});
export type RepairLease = z.infer<typeof RepairLease>;

export const RepairJobView = z.object({
  jobId: z.string(),
  capabilityId: z.string(),
  version: z.number(),
  signatureKey: z.string(),
  category: z.string(),
  status: RepairJobStatus,
  holder: z.string().optional(),
  leaseExpiresAt: z.number().optional(),
  fencingToken: z.number(),
  attempts: z.number(),
  proposedVersionId: z.string().optional(),
  reporters: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type RepairJobView = z.infer<typeof RepairJobView>;
