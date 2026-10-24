/**
 * Public contract of the external-baseline adapter: what the benchmark harness passes in, what it
 * gets back, the prices used to cost a run, and input validation. Framework-independent.
 */

export interface ExternalRunInput {
  /** The task text Overclock gets (PublicScenario.goal). */
  goal: string;
  /** The records Overclock gets, processed in order. */
  records: Record<string, unknown>[];
  /** The applications the task may use. Navigation is restricted to exactly these origins. */
  applications: { name: string; origin: string }[];
  /** Arena operator login (env ARENA_USERNAME / ARENA_PASSWORD; defaults operator / overclock-arena). */
  credentials: { username: string; password: string };
  /** One of BASELINE_MODELS. Default claude-haiku-5-5 (the model of Overclock's sequential baseline). */
  model?: string;
  /** Agent step cap per record. Default 30 (same as the sequential baseline); the wrap-up gets twice this. */
  maxStepsPerRecord?: number;
  signal?: AbortSignal;
  /** Stop when model spend reaches this many USD. No cap when omitted. */
  budgetUsd?: number;
  /**
   * Claude effort sent with every model call. Default "low", the effort Overclock's own Haiku
   * calls use (OVERCLOCK_HELPER_EFFORT default); null sends none (API default).
   */
  effort?: "low" | "medium" | "high" | "xhigh" | "max" | null;
}

export interface ExternalEpisode {
  /** Record key, or "batch" for the wrap-up. */
  key: string;
  kind: "record" | "wrap-up";
  /** The framework's own completion claim. Never checked here; the arena checker decides. */
  claimedDone: boolean;
  /** Tool calls the agent made (as reported by the framework). */
  actions: number;
  wallMs: number;
  /** The agent's final message, clipped. */
  message: string;
  error?: string;
}

export interface ExternalRunResult {
  framework: string;
  frameworkVersion: string;
  model: string;
  wallMs: number;
  /** Time from the start of the run to the first browser-acting tool call of the agent (login excluded). */
  firstActionMs: number | null;
  modelCalls: number;
  /** Every input token sent, cached or not. */
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  recordsAttempted: number;
  /** Records the agent claimed to have finished. A claim only: the harness checks the arena independently. */
  recordsClaimedDone: number;
  /** Why the run stopped early or failed (budget, cancel, setup failure). */
  error?: string;
  /** Per-episode detail, in order (records, then the wrap-up). */
  episodes?: ExternalEpisode[];
  /** Requests the origin allowlist refused. */
  blockedRequests?: number;
  /** The framework's own token counters (Stagehand metrics), for cross-checking the metered numbers. */
  frameworkReported?: { inputTokens: number; outputTokens: number };
}

/** Thrown when the baseline cannot run in this environment (missing package, browser, or API key). */
export class ExternalBaselineUnavailableError extends Error {
  override readonly name = "ExternalBaselineUnavailableError";
}

/** Thrown inside model calls when the run's budget is spent; the run then stops with `error` set. */
export class ExternalBudgetExceededError extends Error {
  override readonly name = "ExternalBudgetExceededError";
  constructor(
    readonly spentUsd: number,
    readonly budgetUsd: number,
  ) {
    super(`Model budget exceeded: $${spentUsd.toFixed(4)} spent of $${budgetUsd.toFixed(2)}`);
  }
}

/** USD per million tokens, fixed for the benchmark (cache reads are billed at the input price). */
export const BASELINE_PRICES = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-opus-5-5": { input: 4, output: 20 },
} as const satisfies Record<string, { input: number; output: number }>;

export type BaselineModel = keyof typeof BASELINE_PRICES;
export const BASELINE_MODELS = Object.keys(BASELINE_PRICES) as BaselineModel[];
export const DEFAULT_BASELINE_MODEL: BaselineModel = "claude-haiku-5-5";
export const DEFAULT_MAX_STEPS_PER_RECORD = 30;

export function isBaselineModel(m: string): m is BaselineModel {
  return Object.hasOwn(BASELINE_PRICES, m);
}

export function costUsd(model: BaselineModel, inputTokens: number, outputTokens: number): number {
  const p = BASELINE_PRICES[model];
  return (inputTokens / 1e6) * p.input + (outputTokens / 1e6) * p.output;
}

export interface ResolvedRunInput {
  goal: string;
  records: Record<string, unknown>[];
  applications: { name: string; origin: string }[];
  credentials: { username: string; password: string };
  model: BaselineModel;
  maxStepsPerRecord: number;
  signal: AbortSignal | undefined;
  budgetUsd: number | undefined;
  effort: NonNullable<ExternalRunInput["effort"]> | null;
}

const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

/** Validate and normalize the input. Throws TypeError on input the adapter cannot run. */
export function resolveRunInput(input: ExternalRunInput): ResolvedRunInput {
  if (typeof input?.goal !== "string" || !input.goal.trim()) throw new TypeError("goal must be a non-empty string");
  if (!Array.isArray(input.records)) throw new TypeError("records must be an array");
  for (const [i, r] of input.records.entries()) {
    if (typeof r !== "object" || r === null || Array.isArray(r)) throw new TypeError(`records[${i}] must be an object`);
  }
  if (!Array.isArray(input.applications) || input.applications.length === 0) throw new TypeError("applications must be a non-empty array");
  const names = new Set<string>();
  const applications = input.applications.map((a, i) => {
    if (typeof a?.name !== "string" || !a.name) throw new TypeError(`applications[${i}].name must be a non-empty string`);
    if (names.has(a.name)) throw new TypeError(`applications[${i}].name "${a.name}" is duplicated`);
    names.add(a.name);
    let url: URL;
    try {
      url = new URL(a.origin);
    } catch {
      throw new TypeError(`applications[${i}].origin is not a URL: ${String(a.origin)}`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new TypeError(`applications[${i}].origin must be http(s): ${a.origin}`);
    return { name: a.name, origin: url.origin };
  });
  const c = input.credentials;
  if (typeof c?.username !== "string" || typeof c.password !== "string") throw new TypeError("credentials.username and credentials.password must be strings");
  const model = input.model ?? DEFAULT_BASELINE_MODEL;
  if (!isBaselineModel(model)) throw new TypeError(`model must be one of ${BASELINE_MODELS.join(", ")}; got "${model}"`);
  const maxStepsPerRecord = input.maxStepsPerRecord ?? DEFAULT_MAX_STEPS_PER_RECORD;
  if (!Number.isInteger(maxStepsPerRecord) || maxStepsPerRecord < 1) throw new TypeError("maxStepsPerRecord must be a positive integer");
  const budgetUsd = input.budgetUsd;
  if (budgetUsd !== undefined && (typeof budgetUsd !== "number" || !Number.isFinite(budgetUsd) || budgetUsd <= 0)) throw new TypeError("budgetUsd must be a positive number");
  const effort = input.effort === undefined ? "low" : input.effort;
  if (effort !== null && !EFFORTS.has(effort)) throw new TypeError(`effort must be one of ${[...EFFORTS].join(", ")} or null`);
  return { goal: input.goal, records: input.records, applications, credentials: { username: c.username, password: c.password }, model, maxStepsPerRecord, signal: input.signal, budgetUsd, effort };
}

/** Stable display key for a record: an id-like field, else the first primitive value, else its position. Same rule as the sequential baseline. */
export function recordKeyOf(rec: Record<string, unknown>, index: number): string {
  const entries = Object.entries(rec).filter(([, v]) => typeof v === "string" || typeof v === "number");
  const pick = entries.find(([k]) => k === "key" || k === "id") ?? entries.find(([k]) => /(Id|_id|ID|Key)$/.test(k)) ?? entries[0];
  return pick ? String(pick[1]) : `#${index + 1}`;
}

/** Credentials from the arena's environment variables, with the arena's defaults. */
export function arenaCredentialsFromEnv(): { username: string; password: string } {
  return { username: process.env.ARENA_USERNAME || "operator", password: process.env.ARENA_PASSWORD || "overclock-arena" };
}
