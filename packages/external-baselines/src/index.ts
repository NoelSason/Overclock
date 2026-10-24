import type { PublicScenario, RunConfigInput } from "@overclock/contracts";
import { loadEnv } from "@overclock/telemetry";
import { arenaCredentialsFromEnv, ExternalBaselineUnavailableError, resolveRunInput, type ExternalRunInput, type ExternalRunResult } from "./contract";
import { loadFramework } from "./session";
import { runStagehand } from "./stagehand";

export {
  arenaCredentialsFromEnv,
  BASELINE_MODELS,
  BASELINE_PRICES,
  costUsd,
  DEFAULT_BASELINE_MODEL,
  DEFAULT_MAX_STEPS_PER_RECORD,
  ExternalBaselineUnavailableError,
  ExternalBudgetExceededError,
  isBaselineModel,
  recordKeyOf,
  resolveRunInput,
  type BaselineModel,
  type ExternalEpisode,
  type ExternalRunInput,
  type ExternalRunResult,
} from "./contract";
export { UsageMeter, type Effort, type ModelMiddleware } from "./meter";
export { OPERATING_RULES, recordInstruction, wrapUpInstruction } from "./prompt";
export { aiSdkAnthropicBaseUrl, FRAMEWORK, installOriginGuard, loadFramework, login, openStagehandSession, type Framework, type GuardStats, type StagehandSession } from "./session";

/**
 * Run the external baseline (Stagehand's agent) on one batch.
 *
 * Throws TypeError on invalid input and ExternalBaselineUnavailableError when this environment
 * cannot run it (no API key, Stagehand or Chromium missing). Everything that goes wrong once the
 * run has started (budget, cancel, browser or model errors) comes back in `result.error`.
 */
export async function runExternal(input: ExternalRunInput): Promise<ExternalRunResult> {
  const o = resolveRunInput(input);
  loadEnv();
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new ExternalBaselineUnavailableError("ANTHROPIC_API_KEY is not set");
  const framework = await loadFramework();
  return runStagehand({ ...o, framework, apiKey });
}

export type ExternalRunnerOptions = Pick<ExternalRunInput, "model" | "maxStepsPerRecord" | "budgetUsd" | "effort" | "mode" | "signal"> & { credentials?: ExternalRunInput["credentials"] };

/**
 * Adapter for the benchmark harness's `ExternalRunner` signature: same task text, records, and
 * apps the engine run gets. The run config's budget wins over `opts.budgetUsd`.
 */
export function createExternalRunner(opts: ExternalRunnerOptions = {}): (config: RunConfigInput, scenario: PublicScenario) => Promise<ExternalRunResult> {
  return (config, scenario) => {
    const budgetUsd = config.budgetUsd ?? opts.budgetUsd;
    return runExternal({
      goal: config.goal,
      records: config.records ?? scenario.records,
      applications: config.applications.map((a) => ({ name: a.name, origin: a.origin })),
      credentials: opts.credentials ?? arenaCredentialsFromEnv(),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.maxStepsPerRecord ? { maxStepsPerRecord: opts.maxStepsPerRecord } : {}),
      ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
      ...(opts.mode ? { mode: opts.mode } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(budgetUsd !== undefined ? { budgetUsd } : {}),
    });
  };
}
