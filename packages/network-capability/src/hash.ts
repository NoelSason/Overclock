import { createHash } from "node:crypto";
import type { PortableCapability } from "@overclock/network-contracts";

/**
 * Canonical JSON: object keys sorted, `undefined` members dropped, arrays in order. Two
 * structurally equal values always serialize to the same bytes, so hashes are stable across
 * runtimes and across JSON round trips.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : canonicalize(v)));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = canonicalize(v);
    }
    return out;
  }
  return value;
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Short structural hash (hex) used for form signatures and region keys. */
export function shortHash(s: string, len = 16): string {
  return sha256(s).slice(0, len);
}

/** sha256 over the canonical JSON of the capability with `provenance.artifactHash` blank. */
export function computeArtifactHash(cap: PortableCapability): string {
  return sha256(canonicalJson({ ...cap, provenance: { ...cap.provenance, artifactHash: "" } }));
}

export function verifyArtifactHash(cap: PortableCapability): boolean {
  return cap.provenance.artifactHash === computeArtifactHash(cap);
}

/** Return a copy with `provenance.artifactHash` recomputed. */
export function withArtifactHash(cap: PortableCapability): PortableCapability {
  const c = structuredClone(cap);
  c.provenance.artifactHash = computeArtifactHash(c);
  return c;
}
