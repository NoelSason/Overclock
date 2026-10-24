import type { CheckResult, PublicScenario, RunConfigInput, ScenarioRequest, VariationConfig } from "@overclock/contracts";
import { HttpClient, envVar, type FetchLike } from "./http";

export const DEFAULT_ARENA_URL = "http://127.0.0.1:4100";

export interface ArenaOptions {
  /** Arena admin base URL. Defaults to `$OVERCLOCK_ARENA_URL`, then http://127.0.0.1:4100. */
  endpoint?: string | undefined;
  fetch?: FetchLike | undefined;
  /** Timeout for each request in ms (default 30000; 0 disables). */
  timeoutMs?: number | undefined;
}

/** `seed` is required; `template` and `records` fall back to the arena's defaults. */
export type ScenarioRequestInput = Pick<ScenarioRequest, "seed"> & Partial<ScenarioRequest>;

/** Client for the arena admin (judge) API: scenarios, ground-truth checks, and injected variations. */
export class Arena {
  readonly endpoint: string;
  private readonly http: HttpClient;

  constructor(opts: ArenaOptions = {}) {
    this.http = new HttpClient({
      service: "arena",
      endpoint: opts.endpoint || envVar("OVERCLOCK_ARENA_URL") || DEFAULT_ARENA_URL,
      fetch: opts.fetch,
      timeoutMs: opts.timeoutMs ?? 30_000,
    });
    this.endpoint = this.http.endpoint;
  }

  health(): Promise<unknown> {
    return this.http.request("GET", "/api/health");
  }

  /** The loaded scenario; rejects with HTTP 404 when none is loaded. */
  scenario(): Promise<PublicScenario> {
    return this.http.request("GET", "/api/scenario");
  }

  /** Generates and loads a fresh scenario. Also clears variations and stats. */
  loadScenario(req: ScenarioRequestInput): Promise<PublicScenario> {
    return this.http.request("POST", "/api/scenario", { body: req });
  }

  /** Restores the loaded scenario to its starting snapshot and clears variations and stats. */
  reset(): Promise<PublicScenario> {
    return this.http.request("POST", "/api/reset");
  }

  /** Ground-truth comparison of the apps' current state against the scenario's expected outcome. */
  check(): Promise<CheckResult> {
    return this.http.request("GET", "/api/check");
  }

  variations(): Promise<VariationConfig> {
    return this.http.request("GET", "/api/variations");
  }

  /** Replaces the whole variation config; omitted keys fall back to defaults. */
  setVariations(v: Partial<VariationConfig>): Promise<VariationConfig> {
    return this.http.request("PUT", "/api/variations", { body: v });
  }

  /** Deep-merges a partial config into the current one. */
  patchVariations(p: Record<string, unknown>): Promise<VariationConfig> {
    return this.http.request("PATCH", "/api/variations", { body: p });
  }

  resetVariations(): Promise<VariationConfig> {
    return this.http.request("POST", "/api/variations/reset");
  }

  /** Applies a preset judge surprise (e.g. "rename-save", "latency", "clear") to one app or all. Returns the new variation config. */
  surprise(kind: string, app?: string): Promise<VariationConfig> {
    return this.http.request("POST", "/api/judge/surprise", { body: app === undefined ? { kind } : { kind, app } });
  }

  /** Edits one record nobody has processed yet, as a judge would mid-run. */
  editUnprocessed(): Promise<unknown> {
    return this.http.request("POST", "/api/judge/edit-unprocessed");
  }

  stats(): Promise<unknown> {
    return this.http.request("GET", "/api/stats");
  }
}

/**
 * Builds a run config from an arena scenario: its goal, applications, and records, labelled with
 * the scenario title. `overrides` win over every derived field.
 */
export function configFromScenario(s: PublicScenario, overrides: Partial<RunConfigInput> = {}): RunConfigInput {
  return {
    goal: s.goal,
    applications: s.applications.map((a) => ({ name: a.name, origin: a.origin })),
    records: s.records,
    label: s.title,
    ...overrides,
  };
}
