import type {
  CapabilityCandidate,
  CapabilityChange,
  FailureSignature,
  INetworkClient,
  LookupQuery,
  NetworkActivity,
  NetworkConfig,
  NetworkStats,
  PortableCapability,
  PublicationState,
  PublisherRole,
  RepairJobView,
  RepairLease,
  ValidationResult,
} from "@overclock/network-contracts";
import { NetworkClient, type NetworkClientOptions } from "./client";
import { NetworkDisabledError } from "./errors";

type LookupResult = Awaited<ReturnType<INetworkClient["lookup"]>>;

/**
 * Lookup result meaning NO_CAPABILITY. The contract's `source` union has no "disabled" member,
 * so a disabled client reports "negative-cache" (an authoritative empty answer) with 0 ms.
 */
export const NO_CAPABILITY_LOOKUP: Readonly<LookupResult> = Object.freeze({ candidates: [], source: "negative-cache", ms: 0 });

const noop = () => {};

/**
 * Client used when Overclock Network is disabled. `lookup` returns NO_CAPABILITY instantly;
 * every network operation rejects with NetworkDisabledError; cache reads return null; event
 * subscriptions are accepted and never fire.
 */
export class DisabledNetworkClient implements INetworkClient {
  readonly identity: string | null = null;

  constructor(readonly config: NetworkConfig) {}

  private fail(operation: string): never {
    throw new NetworkDisabledError(`${operation}: Overclock Network is disabled`);
  }

  isConnected(): boolean {
    return false;
  }
  onStatus(_cb: (connected: boolean) => void): () => void {
    return noop;
  }
  async watchOrigins(_origins: string[]): Promise<void> {
    this.fail("watchOrigins");
  }
  async lookup(_q: LookupQuery): Promise<LookupResult> {
    return { ...NO_CAPABILITY_LOOKUP, candidates: [] };
  }
  async fetchArtifact(_versionId: string): Promise<{ capability: PortableCapability; source: "local-cache" | "network"; ms: number }> {
    this.fail("fetchArtifact");
  }
  async reportReuse(_versionId: string, _ok: boolean): Promise<void> {
    this.fail("reportReuse");
  }
  async registerPublisher(_displayName: string, _role: PublisherRole): Promise<{ status: string }> {
    this.fail("registerPublisher");
  }
  async registerApplication(_origin: string, _routeFamilies: string[]): Promise<void> {
    this.fail("registerApplication");
  }
  async proposeCapability(_c: PortableCapability): Promise<{ versionId: string; state: PublicationState }> {
    this.fail("proposeCapability");
  }
  async recordValidation(_r: ValidationResult): Promise<void> {
    this.fail("recordValidation");
  }
  async promote(_versionId: string): Promise<{ state: PublicationState }> {
    this.fail("promote");
  }
  async quarantine(_versionId: string, _reason: string): Promise<void> {
    this.fail("quarantine");
  }
  activeVersion(_capabilityId: string): CapabilityCandidate | null {
    return null;
  }
  versionInfo(_versionId: string): CapabilityCandidate | null {
    return null;
  }
  versionsInState(_state: PublicationState): CapabilityCandidate[] {
    return [];
  }


  async reportFailure(_sig: FailureSignature): Promise<{ jobId: string; existing: boolean }> {
    this.fail("reportFailure");
  }
  async claimRepair(_jobId: string, _leaseMs: number): Promise<RepairLease> {
    this.fail("claimRepair");
  }
  async renewRepair(_jobId: string, _fencingToken: number, _leaseMs: number): Promise<RepairLease> {
    this.fail("renewRepair");
  }
  async finishRepair(_jobId: string, _fencingToken: number, _proposedVersionId: string): Promise<{ ok: boolean; reason?: string }> {
    this.fail("finishRepair");
  }
  async releaseRepair(_jobId: string, _fencingToken: number): Promise<void> {
    this.fail("releaseRepair");
  }
  repairJob(_jobId: string): RepairJobView | null {
    return null;
  }
  onCapabilityChange(_cb: (c: CapabilityChange) => void): () => void {
    return noop;
  }
  onRepairJob(_cb: (j: RepairJobView) => void): () => void {
    return noop;
  }
  onActivity(_cb: (a: NetworkActivity) => void): () => void {
    return noop;
  }
  stats(): NetworkStats {
    return {
      connected: false,
      identity: null,
      lookups: 0,
      localHits: 0,
      networkHits: 0,
      misses: 0,
      negativeHits: 0,
      lookupMs: { p50: 0, count: 0 },
      fetchMs: { p50: 0, count: 0 },
    };
  }
  async close(): Promise<void> {}
}

/** A connected NetworkClient when enabled, otherwise a DisabledNetworkClient. */
export async function createNetworkClient(config: NetworkConfig, opts?: NetworkClientOptions): Promise<INetworkClient> {
  if (!config.enabled) return new DisabledNetworkClient(config);
  return NetworkClient.connect(config, opts);
}
