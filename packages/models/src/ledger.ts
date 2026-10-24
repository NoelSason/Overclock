/** Prices per million tokens (USD). Sources: Anthropic model table (2026-10-06), TypeSafe docs. */
export const PRICES: Record<string, { input: number; output: number; cacheRead?: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  jev: { input: 0.042, output: 0 },
};

export function priceFor(model: string): { input: number; output: number; cacheRead?: number } {
  if (model.startsWith("jev")) return PRICES.jev!;
  return PRICES[model] ?? { input: 4, output: 20 };
}

export interface ModelCallRecord {
  provider: "anthropic" | "typesafe";
  model: string;
  purpose: string;
  ms: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  ok: boolean;
  error?: string | undefined;
}

export class BudgetExceededError extends Error {
  constructor(
    readonly spentUsd: number,
    readonly budgetUsd: number,
  ) {
    super(`Model budget exceeded: $${spentUsd.toFixed(4)} spent of $${budgetUsd.toFixed(2)}`);
  }
}

/**
 * Records every model invocation (latency, tokens, cost, structured-output failures) and enforces
 * an optional spend budget. One ledger per run; a process-wide ledger tracks benchmark totals.
 */
export class ModelLedger {
  readonly calls: ModelCallRecord[] = [];
  spentUsd = 0;
  private readonly listeners = new Set<(c: ModelCallRecord) => void>();

  constructor(
    public budgetUsd?: number,
    private readonly parent?: ModelLedger,
  ) {}

  onCall(l: (c: ModelCallRecord) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** Throws before a call if the projected spend would exceed this ledger's or a parent's budget. */
  guard(projectedUsd: number): void {
    if (this.budgetUsd !== undefined && this.spentUsd + projectedUsd > this.budgetUsd) throw new BudgetExceededError(this.spentUsd, this.budgetUsd);
    this.parent?.guard(projectedUsd);
  }

  record(c: ModelCallRecord): void {
    this.calls.push(c);
    this.spentUsd += c.costUsd;
    for (const l of this.listeners) l(c);
    this.parent?.record(c);
  }

  totals(): { calls: number; inputTokens: number; outputTokens: number; costUsd: number; ms: number; failures: number } {
    return this.calls.reduce((t, c) => ({ calls: t.calls + 1, inputTokens: t.inputTokens + c.inputTokens, outputTokens: t.outputTokens + c.outputTokens, costUsd: t.costUsd + c.costUsd, ms: t.ms + c.ms, failures: t.failures + (c.ok ? 0 : 1) }), {
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      ms: 0,
      failures: 0,
    });
  }
}
