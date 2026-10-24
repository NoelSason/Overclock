import type { ModelConfiguration } from "@browserbasehq/stagehand";
import { costUsd, ExternalBudgetExceededError, type BaselineModel } from "./contract";

/** The AI SDK middleware type Stagehand accepts on its model configuration ("usage tracking, logging, request transforms"). */
export type ModelMiddleware = NonNullable<Extract<ModelConfiguration, { modelName: string }>["middleware"]>;
type CallParams = Parameters<NonNullable<ModelMiddleware["transformParams"]>>[0]["params"];

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

interface Usage {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  cachedInputTokens?: number | undefined;
}

/** Rough input-token estimate for the budget guard: JSON size of the prompt without inline file data. */
function estimateInputTokens(params: CallParams): number {
  const json = JSON.stringify(params.prompt, (k, v: unknown) => (k === "data" && typeof v === "string" ? "" : v));
  return Math.ceil((json?.length ?? 0) / 3.5);
}

function cacheCreationTokens(providerMetadata: unknown): number {
  const v = (providerMetadata as { anthropic?: { cacheCreationInputTokens?: unknown } } | undefined)?.anthropic?.cacheCreationInputTokens;
  return typeof v === "number" ? v : 0;
}

/**
 * Meters every model call Stagehand makes (agent steps, act/observe/extract, the forced final
 * "done" call) through its documented model middleware hook: counts calls and tokens, prices
 * them, refuses calls once the budget is spent, and ties in-flight calls to the run's abort signal.
 */
export class UsageMeter {
  calls = 0;
  failures = 0;
  /** Message of the most recent failed call. */
  lastError: string | undefined;
  inputTokens = 0;
  outputTokens = 0;
  /** Prompt-cache reads and writes (both also included in inputTokens). */
  cachedInputTokens = 0;
  cacheWriteTokens = 0;
  spentUsd = 0;
  /** Set once a call was refused for budget. */
  budgetExceeded: ExternalBudgetExceededError | null = null;
  private readonly abort = new AbortController();

  constructor(
    readonly model: BaselineModel,
    readonly budgetUsd: number | undefined,
    readonly effort: Effort | null,
    signal: AbortSignal | undefined,
  ) {
    if (signal) {
      if (signal.aborted) this.abort.abort(signal.reason);
      else signal.addEventListener("abort", () => this.abort.abort(signal.reason), { once: true });
    }
  }

  /** Aborted on cancel or when the budget is spent. */
  get signal(): AbortSignal {
    return this.abort.signal;
  }

  record(usage: Usage | undefined, providerMetadata: unknown): void {
    const uncached = usage?.inputTokens ?? 0;
    const cached = usage?.cachedInputTokens ?? 0;
    const written = cacheCreationTokens(providerMetadata);
    const input = uncached + cached + written;
    const output = usage?.outputTokens ?? 0;
    this.inputTokens += input;
    this.outputTokens += output;
    this.cachedInputTokens += cached;
    this.cacheWriteTokens += written;
    this.spentUsd += costUsd(this.model, input, output);
  }

  private fail(err: unknown): void {
    this.failures++;
    this.lastError = (err instanceof Error ? err.message : String(err)).slice(0, 200);
  }

  /** Throws (and aborts the run) if this call could take spend past the budget. */
  guard(params: CallParams): void {
    if (this.abort.signal.aborted) throw this.budgetExceeded ?? new Error("Cancelled");
    if (this.budgetUsd === undefined) return;
    const projected = costUsd(this.model, estimateInputTokens(params), 500);
    if (this.spentUsd + projected > this.budgetUsd) {
      this.budgetExceeded = new ExternalBudgetExceededError(this.spentUsd, this.budgetUsd);
      this.abort.abort(this.budgetExceeded);
      throw this.budgetExceeded;
    }
  }

  readonly middleware: ModelMiddleware = {
    transformParams: async ({ params }) => {
      const signal = params.abortSignal ? AbortSignal.any([params.abortSignal, this.abort.signal]) : this.abort.signal;
      const anthropic = params.providerOptions?.anthropic ?? {};
      const withEffort = this.effort && anthropic.effort === undefined ? { ...params.providerOptions, anthropic: { ...anthropic, effort: this.effort } } : params.providerOptions;
      return { ...params, abortSignal: signal, ...(withEffort ? { providerOptions: withEffort } : {}) };
    },
    wrapGenerate: async ({ doGenerate, params }) => {
      this.guard(params);
      this.calls++;
      try {
        const res = await doGenerate();
        this.record(res.usage, res.providerMetadata);
        return res;
      } catch (err) {
        this.fail(err);
        throw err;
      }
    },
    wrapStream: async ({ doStream, params }) => {
      this.guard(params);
      this.calls++;
      let res: Awaited<ReturnType<typeof doStream>>;
      try {
        res = await doStream();
      } catch (err) {
        this.fail(err);
        throw err;
      }
      type Part = typeof res.stream extends ReadableStream<infer P> ? P : never;
      const meter = (part: Part) => {
        if (part.type === "finish") this.record(part.usage, part.providerMetadata);
        else if (part.type === "error") this.fail(part.error);
      };
      return { ...res, stream: res.stream.pipeThrough(new TransformStream<Part, Part>({ transform: (part, ctl) => (meter(part), ctl.enqueue(part)) })) };
    },
  };
}
