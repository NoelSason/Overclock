import { APP_NAMES, type AppName } from "../data/apps";

export interface AppStats {
  requests: number;
  inFlight: number;
  maxInFlight: number;
  throttled429: number;
  /** Committed state-changing requests (edit, note, import, API write), including ones answered with an injected 500. */
  writes: number;
  injectedBeforeCommit: number;
  injectedAfterCommit: number;
  conflicts409: number;
  /** State-changing requests refused with 403 because the session has the read-only viewer role. */
  deniedWrites: number;
}

export interface ArenaStats {
  apps: Record<AppName, AppStats>;
  lastResetAt: number;
}

function emptyStats(inFlight = 0): AppStats {
  return { requests: 0, inFlight, maxInFlight: inFlight, throttled429: 0, writes: 0, injectedBeforeCommit: 0, injectedAfterCommit: 0, conflicts409: 0, deniedWrites: 0 };
}

export class StatsRegistry {
  private apps = Object.fromEntries(APP_NAMES.map((a) => [a, emptyStats()])) as Record<AppName, AppStats>;
  private lastResetAt = Date.now();

  of(app: AppName): AppStats {
    return this.apps[app];
  }

  enter(app: AppName): void {
    const s = this.apps[app];
    s.inFlight++;
    if (s.inFlight > s.maxInFlight) s.maxInFlight = s.inFlight;
  }

  leave(app: AppName): void {
    const s = this.apps[app];
    s.inFlight = Math.max(0, s.inFlight - 1);
  }

  /** Zero the counters. `inFlight` is a live gauge, so it carries over. */
  clear(): void {
    for (const app of APP_NAMES) this.apps[app] = emptyStats(this.apps[app].inFlight);
    this.lastResetAt = Date.now();
  }

  snapshot(): ArenaStats {
    return { apps: structuredClone(this.apps), lastResetAt: this.lastResetAt };
  }
}
