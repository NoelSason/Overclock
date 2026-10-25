import type { EngineHealth, RunConfig, RunListItem } from "@overclock/contracts";
import type { EngineStore } from "./store";
import { RunController } from "./run";
import type { EngineRuntime } from "./runtime";
import type { RunHandle, RunManager } from "./types";

export const ENGINE_VERSION = "0.1.0";

/** Live runs of this engine process. Historical runs are served by ManagerWithHistory. */
export class EngineRunManager implements RunManager {
  private readonly runs = new Map<string, RunController>();

  constructor(
    readonly runtime: EngineRuntime,
    private readonly store: EngineStore | null,
  ) {}

  async create(config: RunConfig): Promise<RunHandle> {
    const run = new RunController(config, this.runtime, this.store);
    this.runs.set(run.runId, run);
    run.start();
    return run;
  }

  get(runId: string): RunHandle | undefined {
    return this.runs.get(runId);
  }

  list(): RunListItem[] {
    return [...this.runs.values()]
      .map((r) => ({ runId: r.runId, status: r.status(), mode: r.config.mode, goal: r.config.goal.slice(0, 200), createdAt: r.createdAt, label: r.config.label, summary: r.result().summary ?? undefined }))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async health(): Promise<EngineHealth> {
    let browser: { available: boolean; reason?: string } = { available: true };
    try {
      await this.runtime.browser.get();
    } catch (err) {
      browser = { available: false, reason: (err as Error).message.slice(0, 200) };
    }
    const c = this.runtime.claudeConfig;
    const j = this.runtime.jevConfig;
    return {
      ok: true,
      version: ENGINE_VERSION,
      capabilities: {
        anthropic: { available: !!process.env.ANTHROPIC_API_KEY, plannerModel: c.plannerModel, helperModel: c.helperModel, reason: process.env.ANTHROPIC_API_KEY ? undefined : "ANTHROPIC_API_KEY is not set; planning, critique, deep repair and the sequential baseline are unavailable" },
        typesafe: { available: !!process.env.TYPESAFE_API_KEY, model: j.model, visionModel: j.visionModel, reason: process.env.TYPESAFE_API_KEY ? undefined : "TYPESAFE_API_KEY is not set; reflex decisions fall back to deterministic rules" },
        browser,
      },
    };
  }

  async cancelAll(): Promise<void> {
    for (const r of this.runs.values()) r.cancel("engine shutting down");
  }
}
