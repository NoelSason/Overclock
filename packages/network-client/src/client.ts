import {
  LookupQuery,
  MAX_CAPABILITY_BYTES,
  PortableCapability,
  PublicationState,
  ValidationResult,
  type CapabilityCandidate,
  type CapabilityChange,
  type FailureSignature,
  type INetworkClient,
  type NetworkActivity,
  type NetworkConfig,
  type NetworkStats,
  type PublisherRole,
  type RepairJobView,
  type RepairLease,
} from "@overclock/network-contracts";
import { DisconnectedError, Identity, SenderError, UnknownCallResultError, or, setGlobalLogLevel, type BooleanExpr, type TypedTableDef } from "spacetimedb";
import { DbConnection, tables, type EventContext, type SubscriptionHandle } from "./generated/index";
import type { CapabilityVersions, RepairJobs } from "./generated/types";
import {
  CapabilityIntegrityError,
  CapabilityNotFoundError,
  CapabilityTooLargeError,
  NetworkDisabledError,
  NetworkError,
  NetworkRejectedError,
  NetworkUnavailableError,
} from "./errors";
import { Samples, normalizeOrigin, nowMs, toActivity, toCandidate, toRepairJobView, tsMs } from "./mapping";
import { ArtifactCache, TokenStore, sha256Hex, utf8Length } from "./storage";

export interface NetworkClientOptions {
  /** Initial connection must succeed within this window (default 5000 ms). */
  connectTimeoutMs?: number;
  /** Reconnect backoff bounds (SDK floors: 500 ms / 1000 ms). */
  reconnectMinDelayMs?: number;
  reconnectMaxDelayMs?: number;
  /** How long an empty lookup result is remembered (default 15000 ms). */
  negativeCacheTtlMs?: number;
  /** Bound for on-demand artifact fetches (default 10000 ms). */
  fetchTimeoutMs?: number;
}

/** Lease result with the module's rejection reason when `ok` is false. */
export type RepairLeaseResult = RepairLease & { reason?: string };

type LookupResult = Awaited<ReturnType<INetworkClient["lookup"]>>;
type FetchResult = Awaited<ReturnType<INetworkClient["fetchArtifact"]>>;

/** Event kinds that reflect a committed transaction (as opposed to initial subscription sync). */
function isLiveEvent(ctx: EventContext): boolean {
  return ctx.event.tag === "Reducer" || ctx.event.tag === "Transaction";
}

/** OR together one equality per origin (subscription WHERE clause). */
function anyOf<T extends TypedTableDef>(exprs: BooleanExpr<T>[]): BooleanExpr<T> {
  const [first, ...rest] = exprs;
  if (first === undefined) throw new Error("at least one origin is required");
  return rest.reduce<BooleanExpr<T>>((acc, e) => or(acc, e), first);
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Map SDK call failures onto the client's error types. */
function mapCallError(operation: string, e: unknown): Error {
  if (e instanceof SenderError) return new NetworkRejectedError(operation, e.message);
  if (e instanceof DisconnectedError) return new NetworkUnavailableError(`${operation}: not connected to the network`);
  if (e instanceof UnknownCallResultError) return new NetworkUnavailableError(`${operation}: connection lost before the result arrived (the call may have run)`);
  if (e instanceof NetworkError) return e;
  return new NetworkError(`${operation} failed: ${errorMessage(e)}`);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<{ ok: true; value: T } | { ok: false }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ ok: false }), Math.max(0, ms));
    p.then(
      (value) => {
        clearTimeout(timer);
        resolve({ ok: true, value });
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Internal waits must never surface as unhandled rejections.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

let sdkLogLevelSet = false;

/**
 * Overclock Network client over a real SpacetimeDB connection (one per engine process).
 *
 * - Identity: the SpacetimeDB identity of this runtime, persisted as a token in
 *   `<dataDir>/network-token` (0600). The module derives every permission from it.
 * - Reads come from the client cache of origin-scoped subscriptions (`watchOrigins`).
 * - Artifacts are fetched on demand, verified against their content hash, and kept in a
 *   content-addressed cache under `<dataDir>/capabilities/`.
 */
export class NetworkClient implements INetworkClient {
  readonly config: NetworkConfig;
  private readonly opts: Required<NetworkClientOptions>;
  private readonly tokens: TokenStore;
  private readonly artifacts: ArtifactCache;
  private readonly tokenKey: string;

  private conn: DbConnection | null = null;
  private token: string | undefined;
  private identityHex: string | null = null;
  private connected = false;
  private closed = false;
  private everConnected = false;
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;
  private rebuildAttempt = 0;
  private firstConnect: Deferred<void> | null = null;

  /** Origin -> applied waiter. Present once watchOrigins was requested for the origin. */
  private readonly watched = new Map<string, Deferred<void>>();
  private readonly appliedOrigins = new Set<string>();
  private readonly watchHandles: SubscriptionHandle[] = [];
  private baseApplied: Deferred<void> = deferred<void>();

  private readonly negative = new Map<string, number>();
  private readonly inflightLookups = new Map<string, Promise<LookupResult>>();
  private readonly inflightFetches = new Map<string, Promise<FetchResult>>();
  private readonly seenVersionState = new Map<string, string>();
  private readonly seenJobUpdate = new Map<string, bigint>();

  private readonly statusListeners = new Set<(connected: boolean) => void>();
  private readonly changeListeners = new Set<(c: CapabilityChange) => void>();
  private readonly repairListeners = new Set<(j: RepairJobView) => void>();
  private readonly activityListeners = new Set<(a: NetworkActivity) => void>();

  private readonly counters = { lookups: 0, localHits: 0, networkHits: 0, misses: 0, negativeHits: 0 };
  private readonly lookupMs = new Samples();
  private readonly fetchMs = new Samples();

  private constructor(config: NetworkConfig, opts: NetworkClientOptions) {
    this.config = config;
    this.opts = {
      connectTimeoutMs: opts.connectTimeoutMs ?? 5000,
      reconnectMinDelayMs: opts.reconnectMinDelayMs ?? 500,
      reconnectMaxDelayMs: opts.reconnectMaxDelayMs ?? 30_000,
      negativeCacheTtlMs: opts.negativeCacheTtlMs ?? 15_000,
      fetchTimeoutMs: opts.fetchTimeoutMs ?? 10_000,
    };
    this.tokens = new TokenStore(config.dataDir);
    this.artifacts = new ArtifactCache(config.dataDir);
    this.tokenKey = new URL(config.endpoint).host;
  }

  /**
   * Connect, resolving once the connection is established and the base subscription applied.
   * Throws NetworkUnavailableError if that does not happen within `connectTimeoutMs`, and
   * NetworkDisabledError if the config is disabled.
   */
  static async connect(config: NetworkConfig, opts: NetworkClientOptions = {}): Promise<NetworkClient> {
    if (!config.enabled) throw new NetworkDisabledError("Overclock Network is disabled (OVERCLOCK_NETWORK_ENABLED=false)");
    if (!sdkLogLevelSet) {
      setGlobalLogLevel("warn");
      sdkLogLevelSet = true;
    }
    const client = new NetworkClient(config, opts);
    await client.start();
    return client;
  }

  get identity(): string | null {
    return this.identityHex;
  }

  isConnected(): boolean {
    return this.connected;
  }

  onStatus(cb: (connected: boolean) => void): () => void {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  onCapabilityChange(cb: (c: CapabilityChange) => void): () => void {
    this.changeListeners.add(cb);
    return () => this.changeListeners.delete(cb);
  }

  onRepairJob(cb: (j: RepairJobView) => void): () => void {
    this.repairListeners.add(cb);
    return () => this.repairListeners.delete(cb);
  }

  onActivity(cb: (a: NetworkActivity) => void): () => void {
    this.activityListeners.add(cb);
    return () => this.activityListeners.delete(cb);
  }

  // ------------------------------------------------------------------------------------------
  // Connection lifecycle
  // ------------------------------------------------------------------------------------------

  private async start(): Promise<void> {
    this.token = await this.tokens.load(this.tokenKey);
    this.firstConnect = deferred<void>();
    this.conn = this.build();
    const ready = this.firstConnect.promise.then(() => this.baseApplied.promise);
    let outcome: Awaited<ReturnType<typeof withTimeout<void>>>;
    try {
      outcome = await withTimeout(ready, this.opts.connectTimeoutMs);
    } catch (e) {
      await this.close();
      throw e instanceof NetworkError ? e : new NetworkUnavailableError(`cannot connect to ${this.config.endpoint}: ${errorMessage(e)}`);
    }
    if (!outcome.ok) {
      await this.close();
      throw new NetworkUnavailableError(`no connection to ${this.config.endpoint}/${this.config.database} within ${this.opts.connectTimeoutMs} ms`);
    }
  }

  private build(): DbConnection {
    const conn = DbConnection.builder()
      .withUri(this.config.endpoint)
      .withDatabaseName(this.config.database)
      .withToken(this.token)
      .withAutomaticReconnect({ minDelayMs: this.opts.reconnectMinDelayMs, maxDelayMs: this.opts.reconnectMaxDelayMs })
      .onConnect((_c, identity, token) => this.handleConnected(identity, token))
      .onAutomaticReconnect((_c, identity, token) => this.handleConnected(identity, token))
      .onDisconnect((_ctx, _err, nextAttempt) => this.handleDisconnected(nextAttempt))
      .onConnectError((_ctx, err, nextAttempt) => this.handleConnectError(err, nextAttempt))
      .build();
    this.attach(conn);
    return conn;
  }

  /** Register row callbacks and (re)subscribe everything this client watches on `conn`. */
  private attach(conn: DbConnection): void {
    conn.db.capabilityVersions.onInsert((ctx, row) => this.handleVersion(ctx, row));
    conn.db.capabilityVersions.onUpdate((ctx, _old, row) => this.handleVersion(ctx, row));
    conn.db.repairJobs.onInsert((ctx, row) => this.handleJob(ctx, row));
    conn.db.repairJobs.onUpdate((ctx, _old, row) => this.handleJob(ctx, row));
    conn.db.activity.onInsert((ctx, row) => {
      if (!isLiveEvent(ctx)) return;
      const a = toActivity(row);
      for (const cb of this.activityListeners) this.safeCall(() => cb(a));
    });
    conn.db.activeSelections.onUpdate(() => this.negative.clear());
    conn.db.activeSelections.onInsert(() => this.negative.clear());

    conn
      .subscriptionBuilder()
      .onApplied(() => this.baseApplied.resolve())
      .onError((ctx) => this.baseApplied.reject(ctx.event))
      .subscribe([tables.myPublisher]);

    const origins = [...this.watched.keys()];
    this.watchHandles.length = 0;
    this.appliedOrigins.clear();
    if (origins.length > 0) this.subscribeOrigins(conn, origins);
  }

  private handleConnected(identity: Identity, token: string): void {
    this.identityHex = identity.toHexString();
    this.connected = true;
    this.everConnected = true;
    this.rebuildAttempt = 0;
    if (token && token !== this.token) {
      this.token = token;
      this.tokens.save(this.tokenKey, token).catch(() => {});
    }
    this.firstConnect?.resolve();
    this.emitStatus(true);
  }

  private handleDisconnected(nextAttempt: number | undefined): void {
    const was = this.connected;
    this.connected = false;
    if (was) this.emitStatus(false);
    if (nextAttempt === undefined) this.scheduleRebuild();
  }

  private handleConnectError(err: Error, nextAttempt: number | undefined): void {
    if (!this.everConnected) {
      this.firstConnect?.reject(new NetworkUnavailableError(`cannot connect to ${this.config.endpoint}: ${err.message}`));
      return;
    }
    if (nextAttempt === undefined) this.scheduleRebuild();
  }

  /** The SDK stopped retrying: build a fresh connection with our own exponential backoff. */
  private scheduleRebuild(): void {
    if (this.closed || !this.everConnected || this.rebuildTimer !== null) return;
    const base = Math.min(this.opts.reconnectMaxDelayMs, this.opts.reconnectMinDelayMs * 2 ** this.rebuildAttempt);
    const delay = base * (0.5 + Math.random() * 0.5);
    this.rebuildAttempt++;
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null;
      if (this.closed) return;
      this.baseApplied = deferred<void>();
      try {
        this.conn?.disconnect();
      } catch {
        // already closed
      }
      this.conn = this.build();
    }, delay);
  }

  private emitStatus(connected: boolean): void {
    for (const cb of this.statusListeners) this.safeCall(() => cb(connected));
  }

  private safeCall(fn: () => void): void {
    try {
      fn();
    } catch {
      // Listener errors must not break cache processing.
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.rebuildTimer !== null) clearTimeout(this.rebuildTimer);
    this.rebuildTimer = null;
    const conn = this.conn;
    this.conn = null;
    const was = this.connected;
    this.connected = false;
    try {
      conn?.disconnect();
    } catch {
      // already closed
    }
    if (was) this.emitStatus(false);
  }

  private requireConn(operation: string): DbConnection {
    if (this.closed || this.conn === null) throw new NetworkUnavailableError(`${operation}: client is closed`);
    if (!this.connected) throw new NetworkUnavailableError(`${operation}: not connected to the network`);
    return this.conn;
  }

  // ------------------------------------------------------------------------------------------
  // Subscription events
  // ------------------------------------------------------------------------------------------

  private handleVersion(ctx: EventContext, row: CapabilityVersions): void {
    const prev = this.seenVersionState.get(row.versionId);
    this.seenVersionState.set(row.versionId, row.state);
    if (prev === row.state) return;
    // Initial sync of a new subscription is not a change; a replay after reconnect that shows a
    // different state than we last saw is.
    if (!isLiveEvent(ctx) && prev === undefined) return;
    this.negative.clear();
    const state = PublicationState.safeParse(row.state);
    const previous = PublicationState.safeParse(prev);
    if (!state.success) return;
    const change: CapabilityChange = {
      capabilityId: row.capabilityId,
      versionId: row.versionId,
      version: row.version,
      state: state.data,
      previousState: previous.success ? previous.data : undefined,
      committedAt: tsMs(row.stateChangedAt),
      receivedAt: nowMs(),
    };
    for (const cb of this.changeListeners) this.safeCall(() => cb(change));
  }

  private handleJob(ctx: EventContext, row: RepairJobs): void {
    const prev = this.seenJobUpdate.get(row.jobId);
    const stamp = row.updatedAt.microsSinceUnixEpoch;
    this.seenJobUpdate.set(row.jobId, stamp);
    if (prev === stamp) return;
    if (!isLiveEvent(ctx) && prev === undefined) return;
    const view = toRepairJobView(row);
    for (const cb of this.repairListeners) this.safeCall(() => cb(view));
  }

  // ------------------------------------------------------------------------------------------
  // Scoped subscriptions
  // ------------------------------------------------------------------------------------------

  private subscribeOrigins(conn: DbConnection, origins: string[]): void {
    // Rows linked to the origins through capability_apps (two-table semijoins on indexed columns).
    const linked = tables.capabilityApps.where((ca) => anyOf(origins.map((o) => ca.origin.eq(o))));
    const queries = [
      tables.applications.where((a) => anyOf(origins.map((o) => a.origin.eq(o)))),
      tables.uiVariants.where((u) => anyOf(origins.map((o) => u.origin.eq(o)))),
      tables.activity.where((a) => anyOf(origins.map((o) => a.origin.eq(o)))),
      linked,
      linked.rightSemijoin(tables.capabilities, (ca, c) => ca.capabilityId.eq(c.capabilityId)),
      linked.rightSemijoin(tables.capabilityVersions, (ca, v) => ca.capabilityId.eq(v.capabilityId)),
      linked.rightSemijoin(tables.activeSelections, (ca, s) => ca.capabilityId.eq(s.capabilityId)),
      linked.rightSemijoin(tables.repairJobs, (ca, j) => ca.capabilityId.eq(j.capabilityId)),
      linked.rightSemijoin(tables.validationRecords, (ca, r) => ca.capabilityId.eq(r.capabilityId)),
      linked.rightSemijoin(tables.reuseStats, (ca, s) => ca.capabilityId.eq(s.capabilityId)),
    ];
    const handle = conn
      .subscriptionBuilder()
      .onApplied(() => {
        for (const o of origins) {
          this.appliedOrigins.add(o);
          this.watched.get(o)?.resolve();
        }
      })
      .onError((ctx) => {
        for (const o of origins) this.watched.get(o)?.reject(ctx.event);
      })
      .subscribe(queries);
    this.watchHandles.push(handle);
  }

  /** Subscribe to registry rows for these origins (additive; already-watched origins are reused). */
  async watchOrigins(origins: string[]): Promise<void> {
    const normalized = [...new Set(origins.map(normalizeOrigin))];
    const fresh = normalized.filter((o) => !this.watched.has(o));
    for (const o of fresh) this.watched.set(o, deferred<void>());
    if (fresh.length > 0 && this.conn !== null && !this.closed) this.subscribeOrigins(this.conn, fresh);
    const waits = normalized.map((o) => this.watched.get(o)!.promise);
    const result = await withTimeout(Promise.all(waits), this.opts.fetchTimeoutMs);
    if (!result.ok) throw new NetworkUnavailableError(`subscription for ${normalized.join(", ")} was not applied within ${this.opts.fetchTimeoutMs} ms`);
  }

  // ------------------------------------------------------------------------------------------
  // Lookup (client cache)
  // ------------------------------------------------------------------------------------------

  async lookup(q: LookupQuery): Promise<LookupResult> {
    const t0 = performance.now();
    const query = LookupQuery.parse(q);
    const origins = [...new Set(query.origins.map(normalizeOrigin))].sort();
    const key = JSON.stringify({
      origins,
      op: query.canonicalOperation ?? null,
      fps: [...new Set(query.signatures.flatMap((s) => [s.pageFingerprint, ...Object.values(s.regionFingerprints)]))].sort(),
    });
    this.counters.lookups++;
    const negUntil = this.negative.get(key);
    if (negUntil !== undefined && negUntil > Date.now()) {
      this.counters.negativeHits++;
      const ms = performance.now() - t0;
      this.lookupMs.add(ms);
      return { candidates: [], source: "negative-cache", ms };
    }
    const inflight = this.inflightLookups.get(key);
    if (inflight) return inflight;
    const p = this.doLookup(query, origins, key, t0).finally(() => this.inflightLookups.delete(key));
    this.inflightLookups.set(key, p);
    return p;
  }

  private async doLookup(query: LookupQuery, origins: string[], key: string, t0: number): Promise<LookupResult> {
    let source: "local-cache" | "network" = "local-cache";
    const missing = origins.filter((o) => !this.appliedOrigins.has(o));
    if (missing.length > 0) {
      source = "network";
      const remaining = this.config.lookupTimeoutMs - (performance.now() - t0);
      const watch = this.watchOrigins(missing).then(
        () => true,
        () => false,
      );
      const outcome = await withTimeout(watch, remaining);
      if (!outcome.ok || !outcome.value) {
        const ms = performance.now() - t0;
        this.counters.misses++;
        this.lookupMs.add(ms);
        return { candidates: this.matchCandidates(query, origins), source: "timeout", ms };
      }
    }
    const candidates = this.matchCandidates(query, origins);
    const ms = performance.now() - t0;
    this.lookupMs.add(ms);
    if (candidates.length === 0) {
      this.counters.misses++;
      this.negative.set(key, Date.now() + this.opts.negativeCacheTtlMs);
    } else if (source === "local-cache") {
      this.counters.localHits++;
    } else {
      this.counters.networkHits++;
    }
    return { candidates, source, ms };
  }

  private matchCandidates(query: LookupQuery, origins: string[]): CapabilityCandidate[] {
    const conn = this.conn;
    if (conn === null) return [];
    const originSet = new Set(origins);
    const fps = new Set(query.signatures.flatMap((s) => [s.pageFingerprint, ...Object.values(s.regionFingerprints)]));
    const scored: Array<{ c: CapabilityCandidate; op: number; fp: number }> = [];
    for (const sel of conn.db.activeSelections.iter()) {
      if (sel.activeVersionId === "") continue;
      const v = conn.db.capabilityVersions.versionId.find(sel.activeVersionId);
      if (!v || v.state !== "ACTIVE") continue;
      if (!v.origins.every((o) => originSet.has(o))) continue;
      const op = query.canonicalOperation !== undefined && v.canonicalOperation === query.canonicalOperation ? 1 : 0;
      const fp = v.interfaceFingerprints.reduce((n, f) => n + (fps.has(f) ? 1 : 0), 0);
      if (op === 0 && fp === 0) continue;
      scored.push({ c: toCandidate(v, this.successfulReuses(v.versionId)), op, fp });
    }
    scored.sort((a, b) => b.op - a.op || b.fp - a.fp || b.c.version - a.c.version);
    return scored.map((s) => s.c);
  }

  private successfulReuses(versionId: string): number {
    const s = this.conn?.db.reuseStats.versionId.find(versionId);
    return s ? Number(s.successes) : 0;
  }

  activeVersion(capabilityId: string): CapabilityCandidate | null {
    const conn = this.conn;
    if (conn === null) return null;
    const sel = conn.db.activeSelections.selectionId.find(`${capabilityId}|*`);
    if (!sel || sel.activeVersionId === "") return null;
    const v = conn.db.capabilityVersions.versionId.find(sel.activeVersionId);
    return v ? toCandidate(v, this.successfulReuses(v.versionId)) : null;
  }

  /** Cached registry metadata for any version of a watched origin (not only the active one). */
  versionInfo(versionId: string): CapabilityCandidate | null {
    const v = this.conn?.db.capabilityVersions.versionId.find(versionId);
    return v ? toCandidate(v, this.successfulReuses(v.versionId)) : null;
  }

  repairJob(jobId: string): RepairJobView | null {
    const row = this.conn?.db.repairJobs.jobId.find(jobId);
    return row ? toRepairJobView(row) : null;
  }

  // ------------------------------------------------------------------------------------------
  // Artifacts
  // ------------------------------------------------------------------------------------------

  async fetchArtifact(versionId: string): Promise<FetchResult> {
    const inflight = this.inflightFetches.get(versionId);
    if (inflight) return inflight;
    const p = this.doFetch(versionId).finally(() => this.inflightFetches.delete(versionId));
    this.inflightFetches.set(versionId, p);
    return p;
  }

  private parseArtifact(payload: string, hash: string): PortableCapability {
    let json: unknown;
    try {
      json = JSON.parse(payload);
    } catch {
      throw new CapabilityIntegrityError(`artifact ${hash.slice(0, 12)} is not valid JSON`);
    }
    const parsed = PortableCapability.safeParse(json);
    if (!parsed.success) throw new CapabilityIntegrityError(`artifact ${hash.slice(0, 12)} does not match the PortableCapability schema: ${parsed.error.message.slice(0, 300)}`);
    return parsed.data;
  }

  private async doFetch(versionId: string): Promise<FetchResult> {
    const t0 = performance.now();
    const known = this.conn?.db.capabilityVersions.versionId.find(versionId);
    if (known) {
      const local = await this.artifacts.read(known.contentHash);
      if (local !== null) {
        const capability = this.parseArtifact(local, known.contentHash);
        const ms = performance.now() - t0;
        this.fetchMs.add(ms);
        return { capability, source: "local-cache", ms };
      }
    }
    const conn = this.requireConn("fetchArtifact");
    const applied = deferred<void>();
    const handle = conn
      .subscriptionBuilder()
      .onApplied(() => applied.resolve())
      .onError((ctx) => applied.reject(ctx.event))
      .subscribe([tables.capabilityPayloads.where((r) => r.versionId.eq(versionId)), tables.capabilityVersions.where((r) => r.versionId.eq(versionId))]);
    try {
      const outcome = await withTimeout(applied.promise, this.opts.fetchTimeoutMs);
      if (!outcome.ok) throw new NetworkUnavailableError(`fetchArtifact ${versionId}: no response within ${this.opts.fetchTimeoutMs} ms`);
      const meta = conn.db.capabilityVersions.versionId.find(versionId);
      const row = conn.db.capabilityPayloads.versionId.find(versionId);
      if (!meta || !row) throw new CapabilityNotFoundError(`capability version ${versionId} does not exist`);
      if (row.contentHash !== meta.contentHash) throw new CapabilityIntegrityError(`artifact ${versionId}: payload hash does not match the registry`);
      const actual = sha256Hex(row.payload);
      if (actual !== meta.contentHash) throw new CapabilityIntegrityError(`artifact ${versionId}: content hash mismatch`);
      if (utf8Length(row.payload) !== meta.byteSize) throw new CapabilityIntegrityError(`artifact ${versionId}: size mismatch`);
      const capability = this.parseArtifact(row.payload, actual);
      await this.artifacts.write(actual, row.payload);
      const ms = performance.now() - t0;
      this.fetchMs.add(ms);
      return { capability, source: "network", ms };
    } finally {
      try {
        if (!handle.isEnded()) handle.unsubscribe();
      } catch {
        // already ended
      }
    }
  }

  // ------------------------------------------------------------------------------------------
  // Writes (reducers and result-returning procedures)
  // ------------------------------------------------------------------------------------------

  private async call<T>(operation: string, fn: (conn: DbConnection) => Promise<T>): Promise<T> {
    const conn = this.requireConn(operation);
    try {
      return await fn(conn);
    } catch (e) {
      throw mapCallError(operation, e);
    }
  }

  async registerPublisher(displayName: string, role: PublisherRole): Promise<{ status: string }> {
    await this.call("registerPublisher", (c) => c.reducers.registerPublisher({ displayName, role }));
    return { status: this.myPublisher()?.status ?? "pending" };
  }

  /** The caller's own publisher row (from the `my_publisher` view). */
  myPublisher(): { displayName: string; role: string; status: string } | null {
    const conn = this.conn;
    if (conn === null) return null;
    for (const row of conn.db.myPublisher.iter()) return { displayName: row.displayName, role: row.role, status: row.status };
    return null;
  }

  async registerApplication(origin: string, routeFamilies: string[]): Promise<void> {
    await this.call("registerApplication", (c) => c.reducers.registerApplication({ origin: normalizeOrigin(origin), routeFamilies }));
  }

  /**
   * Serialize, size-check, hash, and propose a capability. `publisherId` is always replaced by
   * this client's authenticated identity (the module rejects any other value).
   */
  async proposeCapability(c: PortableCapability): Promise<{ versionId: string; state: PublicationState }> {
    if (!this.config.publishEnabled) throw new NetworkDisabledError("publishing is disabled (OVERCLOCK_NETWORK_PUBLISH_ENABLED=false)");
    const conn = this.requireConn("proposeCapability");
    const identity = this.identityHex;
    if (identity === null) throw new NetworkUnavailableError("proposeCapability: identity not established");
    const capability = PortableCapability.parse({ ...c, publisherId: identity });
    const payload = JSON.stringify(capability);
    const byteSize = utf8Length(payload);
    if (byteSize > MAX_CAPABILITY_BYTES) throw new CapabilityTooLargeError(`capability is ${byteSize} bytes; the limit is ${MAX_CAPABILITY_BYTES}`);
    const contentHash = sha256Hex(payload);
    try {
      await conn.reducers.proposeCapability({ payload, contentHash, byteSize });
    } catch (e) {
      throw mapCallError("proposeCapability", e);
    }
    await this.artifacts.write(contentHash, payload).catch(() => {});
    return { versionId: `${capability.capabilityId}@${capability.version}`, state: "PROPOSED" };
  }

  async recordValidation(r: ValidationResult): Promise<void> {
    const v = ValidationResult.parse(r);
    await this.call("recordValidation", (c) =>
      c.reducers.recordValidationResult({
        versionId: v.versionId,
        environment: v.environment,
        outcome: v.outcome,
        category: v.category,
        evidenceDigest: v.evidenceDigest,
        detail: v.detail,
      }),
    );
  }

  /**
   * Promote a VERIFIED/CANARY version to ACTIVE (or only to CANARY with `canary: true`).
   * The cached selection version is sent as an optimistic-concurrency guard, so a promotion
   * decided on a stale view fails; pass `expectedSelectionVersion: null` to skip the guard.
   */
  async promote(versionId: string, opts: { canary?: boolean; expectedSelectionVersion?: number | null } = {}): Promise<{ state: PublicationState }> {
    let expected: bigint | undefined;
    if (opts.expectedSelectionVersion === null) {
      expected = undefined;
    } else if (opts.expectedSelectionVersion !== undefined) {
      expected = BigInt(opts.expectedSelectionVersion);
    } else {
      const capabilityId = this.conn?.db.capabilityVersions.versionId.find(versionId)?.capabilityId;
      const sel = capabilityId ? this.conn?.db.activeSelections.selectionId.find(`${capabilityId}|*`) : undefined;
      expected = sel?.selectionVersion;
    }
    await this.call("promote", (c) => c.reducers.promoteCapabilityVersion({ versionId, canary: opts.canary ?? false, expectedSelectionVersion: expected }));
    const state = PublicationState.safeParse(this.conn?.db.capabilityVersions.versionId.find(versionId)?.state);
    return { state: state.success ? state.data : opts.canary ? "CANARY" : "ACTIVE" };
  }

  async quarantine(versionId: string, reason: string): Promise<void> {
    await this.call("quarantine", (c) => c.reducers.quarantineCapabilityVersion({ versionId, reason }));
  }

  async revoke(versionId: string, reason: string): Promise<void> {
    await this.call("revoke", (c) => c.reducers.revokeCapabilityVersion({ versionId, reason }));
  }

  async restorePreviousVersion(capabilityId: string, reason: string): Promise<void> {
    await this.call("restorePreviousVersion", (c) => c.reducers.restorePreviousVersion({ capabilityId, reason }));
  }

  /** Admin only: authorize a registered identity (hex) with a role. */
  async authorizePublisher(identityHex: string, role: PublisherRole): Promise<void> {
    await this.call("authorizePublisher", (c) => c.reducers.authorizePublisher({ target: Identity.fromString(identityHex), role }));
  }

  async suspendPublisher(identityHex: string): Promise<void> {
    await this.call("suspendPublisher", (c) => c.reducers.suspendPublisher({ target: Identity.fromString(identityHex) }));
  }

  async reportReuse(versionId: string, ok: boolean): Promise<void> {
    await this.call("reportReuse", (c) => c.reducers.reportReuse({ versionId, ok }));
  }

  async reportFailure(sig: FailureSignature): Promise<{ jobId: string; existing: boolean }> {
    const r = await this.call("reportFailure", (c) =>
      c.procedures.reportCompatibilityFailureResult({
        capabilityId: sig.capabilityId,
        version: sig.version,
        category: sig.category,
        subject: sig.subject,
        observedFingerprint: sig.observedFingerprint ?? "",
      }),
    );
    return { jobId: r.jobId, existing: r.existing };
  }

  private toLease(r: { jobId: string; ok: boolean; fencingToken: bigint; holder: string; expiresAtMicros: bigint; reason: string }): RepairLeaseResult {
    if (!r.ok) return { jobId: r.jobId, ok: false, reason: r.reason };
    return { jobId: r.jobId, ok: true, fencingToken: Number(r.fencingToken), holder: r.holder, expiresAt: Number(r.expiresAtMicros) / 1000 };
  }

  async claimRepair(jobId: string, leaseMs: number): Promise<RepairLeaseResult> {
    const r = await this.call("claimRepair", (c) => c.procedures.claimRepairLeaseResult({ jobId, leaseMs: Math.max(0, Math.floor(leaseMs)) }));
    return this.toLease(r);
  }

  async renewRepair(jobId: string, fencingToken: number, leaseMs: number): Promise<RepairLeaseResult> {
    const r = await this.call("renewRepair", (c) =>
      c.procedures.renewRepairLeaseResult({ jobId, fencingToken: BigInt(fencingToken), leaseMs: Math.max(0, Math.floor(leaseMs)) }),
    );
    return this.toLease(r);
  }

  async finishRepair(jobId: string, fencingToken: number, proposedVersionId: string): Promise<{ ok: boolean; reason?: string }> {
    const r = await this.call("finishRepair", (c) => c.procedures.finishRepairJobResult({ jobId, fencingToken: BigInt(fencingToken), proposedVersionId }));
    return r.ok ? { ok: true } : { ok: false, reason: r.reason };
  }

  async releaseRepair(jobId: string, fencingToken: number): Promise<void> {
    await this.call("releaseRepair", (c) => c.reducers.releaseRepairLease({ jobId, fencingToken: BigInt(fencingToken) }));
  }

  // ------------------------------------------------------------------------------------------
  // Stats
  // ------------------------------------------------------------------------------------------

  stats(): NetworkStats {
    return {
      connected: this.connected,
      identity: this.identityHex,
      ...this.counters,
      lookupMs: { p50: this.lookupMs.p50(), count: this.lookupMs.count },
      fetchMs: { p50: this.fetchMs.p50(), count: this.fetchMs.count },
    };
  }
}
