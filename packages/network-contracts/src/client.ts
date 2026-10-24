import type { CapabilityCandidate, LookupQuery } from "./compatibility";
import type { PortableCapability } from "./capability";
import type { PublicationState, PublisherRole, ValidationResult } from "./publication";
import type { FailureSignature, RepairJobView, RepairLease } from "./repair";
import type { KnowledgePolicy } from "./publication";

/**
 * Interface of the Overclock Network client (implemented in @overclock/network-client over a
 * real SpacetimeDB connection). The engine, validation worker, and tests depend only on this.
 * One client (one connection) per engine process; browser workers never talk to the network.
 */

export interface NetworkConfig {
  enabled: boolean;
  /** SpacetimeDB host, e.g. ws://127.0.0.1:3100 */
  endpoint: string;
  /** Database name or identity. */
  database: string;
  mode: KnowledgePolicy;
  publishEnabled: boolean;
  lookupTimeoutMs: number;
  /** Where this runtime keeps its auth token and artifact cache (per-runtime, never shared). */
  dataDir: string;
  /** Human-readable runtime label for the activity feed (non-sensitive). */
  runtimeLabel: string;
}

export interface CapabilityChange {
  capabilityId: string;
  versionId: string;
  version: number;
  state: PublicationState;
  previousState?: PublicationState | undefined;
  /** Server commit time of the transition (ms epoch) and local receive time, for propagation latency. */
  committedAt: number;
  receivedAt: number;
}

export interface NetworkActivity {
  at: number;
  kind: string;
  actor: string;
  capabilityId?: string | undefined;
  version?: number | undefined;
  detail: string;
}

export interface NetworkStats {
  connected: boolean;
  identity: string | null;
  lookups: number;
  localHits: number;
  networkHits: number;
  misses: number;
  negativeHits: number;
  lookupMs: { p50: number; count: number };
  fetchMs: { p50: number; count: number };
}

export interface INetworkClient {
  readonly config: NetworkConfig;
  readonly identity: string | null;
  isConnected(): boolean;
  onStatus(cb: (connected: boolean) => void): () => void;

  /** Subscribe to registry rows for these origins only (scoped subscription). */
  watchOrigins(origins: string[]): Promise<void>;

  /** Metadata lookup from the subscribed client cache, bounded by lookupTimeoutMs. */
  lookup(q: LookupQuery): Promise<{ candidates: CapabilityCandidate[]; source: "local-cache" | "network" | "negative-cache" | "timeout"; ms: number }>;
  /** Fetch + hash-verify an artifact (local content-addressed cache first). */
  fetchArtifact(versionId: string): Promise<{ capability: PortableCapability; source: "local-cache" | "network"; ms: number }>;
  /** Record a verified reuse (sanitized counters only). */
  reportReuse(versionId: string, ok: boolean): Promise<void>;

  registerPublisher(displayName: string, role: PublisherRole): Promise<{ status: string }>;
  registerApplication(origin: string, routeFamilies: string[]): Promise<void>;
  proposeCapability(c: PortableCapability): Promise<{ versionId: string; state: PublicationState }>;
  recordValidation(r: ValidationResult): Promise<void>;
  promote(versionId: string): Promise<{ state: PublicationState }>;
  quarantine(versionId: string, reason: string): Promise<void>;
  activeVersion(capabilityId: string): CapabilityCandidate | null;
  /** Cached metadata for any version of a watched origin (not only the active one). */
  versionInfo(versionId: string): CapabilityCandidate | null;
  /** Cached versions of watched origins currently in `state` (e.g. a validator's PROPOSED backlog). */
  versionsInState(state: PublicationState): CapabilityCandidate[];

  reportFailure(sig: FailureSignature): Promise<{ jobId: string; existing: boolean }>;
  claimRepair(jobId: string, leaseMs: number): Promise<RepairLease>;
  renewRepair(jobId: string, fencingToken: number, leaseMs: number): Promise<RepairLease>;
  finishRepair(jobId: string, fencingToken: number, proposedVersionId: string): Promise<{ ok: boolean; reason?: string }>;
  releaseRepair(jobId: string, fencingToken: number): Promise<void>;
  repairJob(jobId: string): RepairJobView | null;

  onCapabilityChange(cb: (c: CapabilityChange) => void): () => void;
  onRepairJob(cb: (j: RepairJobView) => void): () => void;
  onActivity(cb: (a: NetworkActivity) => void): () => void;
  stats(): NetworkStats;
  close(): Promise<void>;
}
