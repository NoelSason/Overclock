import type { AppBinding } from "@overclock/contracts";
import type { BrowserManager, StorageState } from "@overclock/browser-runtime";
import type { CapabilityChange, INetworkClient, PortableCapability } from "@overclock/network-contracts";
import { validateProposedCapability, type ValidationReport } from "./validate";

/**
 * Validation worker loop: watches the registry for PROPOSED versions on this validator's
 * origins, validates each one independently, and records the result. It depends only on the
 * INetworkClient interface; the SpacetimeDB-backed client is supplied by the caller.
 */

export interface ValidationWorkerOptions {
  client: INetworkClient;
  browser: BrowserManager;
  /** The validator's environment: the apps it may test against. */
  apps: AppBinding[];
  /** Session for the given apps (observed only in mutation-blocked contexts). */
  storageStateFor: (apps: AppBinding[]) => Promise<StorageState | undefined>;
  /** Non-sensitive label recorded with each result. */
  environment: string;
  /** Validator-owned probe records for a capability (optional; derived from live list pages otherwise). */
  recordsFor?: ((cap: PortableCapability) => Record<string, unknown>[] | undefined) | undefined;
  onResult?: ((r: ValidationReport) => void) | undefined;
  onSkip?: ((versionId: string, reason: string) => void) | undefined;
}

export interface ValidationWorker {
  /** Resolves when the queue is empty and nothing is running. */
  idle(): Promise<void>;
  stop(): Promise<void>;
  readonly processed: number;
}

export async function startValidationWorker(opts: ValidationWorkerOptions): Promise<ValidationWorker> {
  const { client } = opts;
  const origins = opts.apps.map((a) => new URL(a.origin).origin);
  await client.watchOrigins(origins);
  const seen = new Set<string>();
  const queue: string[] = [];
  let running: Promise<void> | null = null;
  let stopped = false;
  let processed = 0;
  const abort = new AbortController();
  const idleWaiters: (() => void)[] = [];

  const processOne = async (versionId: string): Promise<void> => {
    const { capability } = await client.fetchArtifact(versionId);
    if (client.identity && capability.publisherId === client.identity) {
      opts.onSkip?.(versionId, "own publication (validators never validate their own versions)");
      return;
    }
    const byOrigin = new Map(opts.apps.map((a) => [new URL(a.origin).origin, a]));
    const apps: AppBinding[] = [];
    for (const a of capability.applications) {
      const local = byOrigin.get(a.origin);
      if (!local) {
        opts.onSkip?.(versionId, `origin ${a.origin} is not in this validator's environment`);
        return;
      }
      apps.push({ name: a.name, origin: local.origin });
    }
    const storageState = await opts.storageStateFor(apps);
    const report = await validateProposedCapability({ capability, apps, browser: opts.browser, storageState, versionId, environment: opts.environment, records: opts.recordsFor?.(capability), signal: abort.signal });
    await client.recordValidation(report.result);
    processed++;
    opts.onResult?.(report);
  };

  const pump = (): void => {
    if (running || stopped) return;
    const next = queue.shift();
    if (!next) {
      for (const w of idleWaiters.splice(0)) w();
      return;
    }
    running = processOne(next)
      .catch((err: unknown) => opts.onSkip?.(next, `validation crashed: ${(err as Error).message.split("\n")[0]}`))
      .finally(() => {
        running = null;
        pump();
      });
  };

  const onChange = (c: CapabilityChange) => {
    if (c.state !== "PROPOSED" || seen.has(c.versionId)) return;
    seen.add(c.versionId);
    queue.push(c.versionId);
    pump();
  };
  const unsubscribe = client.onCapabilityChange(onChange);
  // The first sync of an origin is state, not a change: queue proposals that already exist.
  for (const v of client.versionsInState("PROPOSED")) onChange({ capabilityId: v.capabilityId, versionId: v.versionId, version: v.version, state: "PROPOSED", committedAt: v.updatedAt, receivedAt: Date.now() });

  return {
    get processed() {
      return processed;
    },
    idle() {
      if (!running && queue.length === 0) return Promise.resolve();
      return new Promise<void>((r) => idleWaiters.push(r));
    },
    async stop() {
      stopped = true;
      unsubscribe();
      abort.abort();
      queue.length = 0;
      await running;
      for (const w of idleWaiters.splice(0)) w();
    },
  };
}
