import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { priceFor, type ModelLedger } from "./ledger";

export class ModelUnavailableError extends Error {}

export class ModelOutputError extends Error {
  constructor(
    message: string,
    readonly stopReason: string | null,
  ) {
    super(message);
  }
}

export type ClaudeRole = "planner" | "helper";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ClaudeConfig {
  plannerModel: string;
  helperModel: string;
  plannerEffort: Effort;
  helperEffort: Effort;
}

export function claudeConfigFromEnv(): ClaudeConfig {
  return {
    plannerModel: process.env.OVERCLOCK_PLANNER_MODEL || "claude-opus-5-5",
    helperModel: process.env.OVERCLOCK_HELPER_MODEL || "claude-haiku-5-5",
    plannerEffort: (process.env.OVERCLOCK_PLANNER_EFFORT as Effort) || "low",
    helperEffort: (process.env.OVERCLOCK_HELPER_EFFORT as Effort) || "low",
  };
}

/** Models that support the server-side refusal fallback chain (`fallbacks: "default"`). */
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"]);

export interface ParseRequest<T extends z.ZodType> {
  role: ClaudeRole;
  purpose: string;
  system: string;
  user: string;
  schema: T;
  maxTokens?: number;
  effort?: Effort;
  signal?: AbortSignal;
}

export interface StreamParseRequest<T extends z.ZodType> extends ParseRequest<T> {
  /** Called with each text delta and the accumulated text (the JSON being generated). */
  onText?: (delta: string, snapshot: string) => void;
}

export interface ParseResult<T> {
  data: T;
  ms: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  model: string;
}

/**
 * Claude provider with typed (structured) outputs. Every response is schema-validated by the
 * SDK; callers still validate semantics (control ids, expressions) in the compiler.
 */
export class ClaudeProvider {
  private client: Anthropic | null = null;
  readonly available: boolean;
  readonly reason?: string | undefined;

  constructor(
    readonly config: ClaudeConfig,
    private readonly ledger: ModelLedger,
  ) {
    this.available = !!process.env.ANTHROPIC_API_KEY;
    if (!this.available) this.reason = "ANTHROPIC_API_KEY is not set";
  }

  modelFor(role: ClaudeRole): string {
    return role === "planner" ? this.config.plannerModel : this.config.helperModel;
  }

  private get api(): Anthropic {
    if (!this.available) throw new ModelUnavailableError(this.reason ?? "Claude unavailable");
    this.client ??= new Anthropic({ maxRetries: 2, timeout: 240_000 });
    return this.client;
  }

  async parse<T extends z.ZodType>(req: ParseRequest<T>): Promise<ParseResult<z.infer<T>>> {
    const model = this.modelFor(req.role);
    const price = priceFor(model);
    const projected = ((req.system.length + req.user.length) / 3.5 / 1e6) * price.input + ((req.maxTokens ?? 16_000) / 1e6) * price.output * 0.5;
    this.ledger.guard(projected);
    const start = performance.now();
    const useFallback = FALLBACK_MODELS.has(model);
    try {
      const response = await this.api.beta.messages.parse(
        {
          model,
          max_tokens: req.maxTokens ?? 16_000,
          system: req.system,
          messages: [{ role: "user", content: req.user }],
          output_config: { format: betaZodOutputFormat(req.schema), effort: req.effort ?? (req.role === "planner" ? this.config.plannerEffort : this.config.helperEffort) },
          ...(useFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
        },
        { signal: req.signal },
      );
      const ms = performance.now() - start;
      const u = response.usage;
      const cacheRead = u.cache_read_input_tokens ?? 0;
      const input = u.input_tokens + (u.cache_creation_input_tokens ?? 0) + cacheRead;
      const costUsd = ((u.input_tokens + (u.cache_creation_input_tokens ?? 0) * 1.25) / 1e6) * price.input + (cacheRead / 1e6) * (price.cacheRead ?? price.input * 0.1) + (u.output_tokens / 1e6) * price.output;
      const ok = response.stop_reason !== "refusal" && response.stop_reason !== "max_tokens" && response.parsed_output != null;
      this.ledger.record({ provider: "anthropic", model: response.model ?? model, purpose: req.purpose, ms, inputTokens: input, outputTokens: u.output_tokens, costUsd, ok, error: ok ? undefined : `stop_reason=${response.stop_reason}` });
      if (response.stop_reason === "refusal") throw new ModelOutputError("The model declined the request", "refusal");
      if (response.stop_reason === "max_tokens") throw new ModelOutputError("The model ran out of output tokens", "max_tokens");
      if (response.parsed_output == null) throw new ModelOutputError("Structured output failed to parse", response.stop_reason ?? null);
      return { data: response.parsed_output as z.infer<T>, ms, inputTokens: input, outputTokens: u.output_tokens, costUsd, model: response.model ?? model };
    } catch (err) {
      if (err instanceof ModelOutputError) throw err;
      const ms = performance.now() - start;
      this.ledger.record({ provider: "anthropic", model, purpose: req.purpose, ms, inputTokens: 0, outputTokens: 0, costUsd: 0, ok: false, error: (err as Error).message.slice(0, 200) });
      throw err;
    }
  }

  /**
   * Streaming variant of parse(): the structured JSON arrives incrementally through `onText`, so
   * callers can act on completed parts (e.g. compile plan steps) before generation finishes.
   */
  async streamParse<T extends z.ZodType>(req: StreamParseRequest<T>): Promise<ParseResult<z.infer<T>> & { firstTextMs: number | null }> {
    const model = this.modelFor(req.role);
    const price = priceFor(model);
    const projected = ((req.system.length + req.user.length) / 3.5 / 1e6) * price.input + ((req.maxTokens ?? 16_000) / 1e6) * price.output * 0.5;
    this.ledger.guard(projected);
    const start = performance.now();
    let firstTextMs: number | null = null;
    const useFallback = FALLBACK_MODELS.has(model);
    try {
      const stream = this.api.beta.messages.stream(
        {
          model,
          max_tokens: req.maxTokens ?? 16_000,
          system: req.system,
          messages: [{ role: "user", content: req.user }],
          output_config: { format: betaZodOutputFormat(req.schema), effort: req.effort ?? (req.role === "planner" ? this.config.plannerEffort : this.config.helperEffort) },
          ...(useFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
        },
        { signal: req.signal },
      );
      stream.on("text", (delta, snapshot) => {
        firstTextMs ??= performance.now() - start;
        req.onText?.(delta, snapshot);
      });
      const response = await stream.finalMessage();
      const ms = performance.now() - start;
      const u = response.usage;
      const cacheRead = u.cache_read_input_tokens ?? 0;
      const input = u.input_tokens + (u.cache_creation_input_tokens ?? 0) + cacheRead;
      const costUsd = ((u.input_tokens + (u.cache_creation_input_tokens ?? 0) * 1.25) / 1e6) * price.input + (cacheRead / 1e6) * (price.cacheRead ?? price.input * 0.1) + (u.output_tokens / 1e6) * price.output;
      let parsed: unknown = response.parsed_output;
      if (parsed == null) {
        const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
        const r = req.schema.safeParse((() => {
          try {
            return JSON.parse(text);
          } catch {
            return undefined;
          }
        })());
        parsed = r.success ? r.data : null;
      }
      const ok = response.stop_reason !== "refusal" && response.stop_reason !== "max_tokens" && parsed != null;
      this.ledger.record({ provider: "anthropic", model: response.model ?? model, purpose: req.purpose, ms, inputTokens: input, outputTokens: u.output_tokens, costUsd, ok, error: ok ? undefined : `stop_reason=${response.stop_reason}` });
      if (response.stop_reason === "refusal") throw new ModelOutputError("The model declined the request", "refusal");
      if (response.stop_reason === "max_tokens") throw new ModelOutputError("The model ran out of output tokens", "max_tokens");
      if (parsed == null) throw new ModelOutputError("Structured output failed to parse", response.stop_reason ?? null);
      return { data: parsed as z.infer<T>, ms, inputTokens: input, outputTokens: u.output_tokens, costUsd, model: response.model ?? model, firstTextMs };
    } catch (err) {
      if (err instanceof ModelOutputError) throw err;
      this.ledger.record({ provider: "anthropic", model, purpose: req.purpose, ms: performance.now() - start, inputTokens: 0, outputTokens: 0, costUsd: 0, ok: false, error: (err as Error).message.slice(0, 200) });
      throw err;
    }
  }
}
