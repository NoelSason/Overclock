import type { AppModel } from "@overclock/contracts";
import type { CapabilityCandidate, CompatibilityOutcome, InterfaceSignature, PortableCapability } from "@overclock/network-contracts";
import { regionMap } from "./describe";

/**
 * Registry-metadata helpers. Lookups never download artifacts or call a model: a runtime
 * computes non-sensitive interface signatures from a lightweight local observation and ranks
 * candidate versions deterministically; only the chosen one is fetched and rebound live.
 */

/** Fingerprints a registry row should carry for `capability` (app interface hashes and page hashes). */
export function registryFingerprints(capability: PortableCapability): string[] {
  return [...new Set([...capability.applications.map((a) => a.interfaceFingerprint), ...capability.pages.map((p) => p.pageFingerprint)])].sort();
}

/** One interface signature per observed page of the given local models. */
export function interfaceSignatures(models: AppModel[], roleClass?: string): InterfaceSignature[] {
  const out: InterfaceSignature[] = [];
  for (const m of models)
    for (const p of m.pages)
      out.push({ origin: new URL(m.origin).origin, routeFamily: p.routePattern, pageFingerprint: p.fingerprint, regionFingerprints: regionMap(m, p), ...(roleClass ? { roleClass } : {}) });
  return out;
}

export interface CandidateMatch {
  candidate: CapabilityCandidate;
  /** Fraction of this runtime's signatures (on the candidate's origins) whose page fingerprint the candidate knows. */
  fingerprintOverlap: number;
  /** Fraction of the candidate's origins this runtime may use. */
  originCoverage: number;
  /** What live rebinding is expected to report (a hint; rebinding decides). */
  predicted: CompatibilityOutcome;
  /** Deterministic sort score (higher first). */
  score: number;
  reasons: string[];
}

export interface MatchOptions {
  canonicalOperation?: string | undefined;
  /** Origins this runtime is allowed to use; candidates needing others are excluded. */
  origins?: string[] | undefined;
}

const STATE_RANK: Record<string, number> = { ACTIVE: 4, CANARY: 3, VERIFIED: 2, VALIDATING: 1, PROPOSED: 0 };
const EXCLUDED_STATES = new Set(["QUARANTINED", "REVOKED"]);

function norm(o: string): string {
  try {
    return new URL(o).origin;
  } catch {
    return o;
  }
}

/**
 * Rank registry candidates against local interface signatures. Pure and deterministic: same
 * inputs, same order. Excluded: quarantined/revoked versions, a different canonical operation,
 * no shared origin, or (with `origins`) any origin this runtime may not use.
 */
export function matchCandidates(signatures: InterfaceSignature[], candidates: CapabilityCandidate[], opts: MatchOptions = {}): CandidateMatch[] {
  const sigOrigins = new Set(signatures.map((s) => norm(s.origin)));
  const allowed = opts.origins ? new Set(opts.origins.map(norm)) : null;
  const out: CandidateMatch[] = [];
  for (const c of candidates) {
    const reasons: string[] = [];
    if (EXCLUDED_STATES.has(c.state)) continue;
    if (opts.canonicalOperation && c.canonicalOperation !== opts.canonicalOperation) continue;
    const origins = c.origins.map(norm);
    if (allowed && origins.some((o) => !allowed.has(o))) continue;
    const shared = origins.filter((o) => sigOrigins.has(o));
    if (!shared.length) continue;
    const relevant = signatures.filter((s) => shared.includes(norm(s.origin)));
    const known = new Set(c.interfaceFingerprints);
    const hits = relevant.filter((s) => known.has(s.pageFingerprint)).length;
    const fingerprintOverlap = relevant.length ? hits / relevant.length : 0;
    const originCoverage = shared.length / origins.length;
    const stateRank = STATE_RANK[c.state] ?? 0;
    reasons.push(`state ${c.state}`, `${hits}/${relevant.length} page fingerprints known`, `${shared.length}/${origins.length} origins observed`);
    const predicted: CompatibilityOutcome = fingerprintOverlap === 1 && originCoverage === 1 ? "EXACT_COMPATIBLE" : fingerprintOverlap > 0 ? "STRUCTURALLY_COMPATIBLE" : "REQUIRES_REBINDING";
    const score = Math.round((stateRank * 100 + fingerprintOverlap * 40 + originCoverage * 20 + Math.min(10, Math.log1p(c.successfulReuses) * 2) + Math.min(5, Math.log1p(c.validations))) * 1000) / 1000;
    out.push({ candidate: c, fingerprintOverlap, originCoverage, predicted, score, reasons });
  }
  out.sort((a, b) => b.score - a.score || b.candidate.version - a.candidate.version || b.candidate.updatedAt - a.candidate.updatedAt || a.candidate.versionId.localeCompare(b.candidate.versionId));
  return out;
}
