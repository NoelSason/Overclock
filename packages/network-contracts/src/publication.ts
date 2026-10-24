import { z } from "zod";

/**
 * Publication state machine (enforced by the SpacetimeDB module; clients cannot skip states):
 *   PROPOSED -> VALIDATING -> VERIFIED -> CANARY -> ACTIVE
 *   any non-terminal -> QUARANTINED -> (VERIFIED again after re-validation) | REVOKED
 * Promotion to ACTIVE requires a passing validation from an authorized validator identity that
 * differs from the publisher, and a version number greater than the current active version.
 */
export const PublicationState = z.enum(["PROPOSED", "VALIDATING", "VERIFIED", "CANARY", "ACTIVE", "QUARANTINED", "REVOKED"]);
export type PublicationState = z.infer<typeof PublicationState>;

export const ValidationResult = z.object({
  versionId: z.string(),
  environment: z.string(),
  outcome: z.enum(["pass", "fail"]),
  category: z.string(),
  /** Digest of the sanitized evidence (never raw traces). */
  evidenceDigest: z.string(),
  detail: z.string().max(500),
});
export type ValidationResult = z.infer<typeof ValidationResult>;

export const PublisherStatus = z.enum(["pending", "authorized", "suspended"]);
export type PublisherStatus = z.infer<typeof PublisherStatus>;

export const PublisherRole = z.enum(["publisher", "validator", "repairer", "admin"]);
export type PublisherRole = z.infer<typeof PublisherRole>;

/** Knowledge policy for a run (extends the legacy `cache` flag; see RunConfig.knowledge). */
export const KnowledgePolicy = z.enum(["strict-cold", "local-only", "network-read", "network-read-and-contribute"]);
export type KnowledgePolicy = z.infer<typeof KnowledgePolicy>;
