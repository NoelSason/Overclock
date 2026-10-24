import { APP_NAMES, type AppName } from "./variations";

export interface AppStats {
  requests: number;
  inFlight: number;
  maxInFlight: number;
  throttled429: number;
  /** Committed state-changing POSTs (edit, note, import), including ones answered with an injected 500. */
  writes: number;
  injectedBeforeCommit: number;
  injectedAfterCommit: number;
  conflicts409: number;
}

export interface ArenaStats {
  apps: Record<AppName, AppStats>;
  lastResetAt: number;
}

function emptyStats(inFlight = 0): AppStats {
  return { requests: 0, inFlight, maxInFlight: inFlight, throttled429: 0, writes: 0, injectedBeforeCommit: 0, injectedAfterCommit: 0, conflicts409: 0 };
}

export class StatsRegistry {
  private apps: Record<AppName, AppStats> = { CRM: emptyStats(), Orders: emptyStats(), Support: emptyStats() };
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
