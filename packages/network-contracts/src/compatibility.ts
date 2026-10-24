import { z } from "zod";

/** Result of matching a capability against a runtime's live interface. */
export const CompatibilityOutcome = z.enum(["EXACT_COMPATIBLE", "STRUCTURALLY_COMPATIBLE", "REQUIRES_REBINDING", "REQUIRES_REPAIR", "INCOMPATIBLE", "NO_CAPABILITY"]);
export type CompatibilityOutcome = z.infer<typeof CompatibilityOutcome>;

/** Non-sensitive lookup key a runtime computes from a lightweight local observation. */
export const InterfaceSignature = z.object({
  origin: z.string(),
  routeFamily: z.string(),
  pageFingerprint: z.string(),
  regionFingerprints: z.record(z.string(), z.string()),
  roleClass: z.string().optional(),
});
export type InterfaceSignature = z.infer<typeof InterfaceSignature>;

export const LookupQuery = z.object({
  origins: z.array(z.string()).min(1),
  canonicalOperation: z.string().optional(),
  signatures: z.array(InterfaceSignature),
});
export type LookupQuery = z.infer<typeof LookupQuery>;

/** Registry metadata for one candidate version (no artifact payload). */
export const CapabilityCandidate = z.object({
  capabilityId: z.string(),
  versionId: z.string(),
  version: z.number(),
  canonicalOperation: z.string(),
  origins: z.array(z.string()),
  interfaceFingerprints: z.array(z.string()),
  state: z.string(),
  contentHash: z.string(),
  bytes: z.number(),
  publisherId: z.string(),
  validations: z.number(),
  successfulReuses: z.number(),
  updatedAt: z.number(),
});
export type CapabilityCandidate = z.infer<typeof CapabilityCandidate>;

export const RebindReport = z.object({
  outcome: CompatibilityOutcome,
  bound: z.number(),
  unbound: z.array(z.object({ key: z.string(), reason: z.string() })),
  ambiguous: z.array(z.string()),
  /** Writes whose controls bound uniquely and whose effects match the declared ones. */
  writesSafe: z.boolean(),
  pagesVisited: z.number(),
  ms: z.number(),
  fingerprintMatches: z.number(),
  fingerprintMismatches: z.number(),
});
export type RebindReport = z.infer<typeof RebindReport>;
