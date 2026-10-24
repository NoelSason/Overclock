import { box, choice, Image, noul, TypeSafeClient, type Questions } from "@typesafe-ai/sdk";
import { priceFor, type ModelLedger } from "./ledger";
import { ModelUnavailableError } from "./claude";

export interface JevConfig {
  model: string;
  visionModel: string;
}

export function jevConfigFromEnv(): JevConfig {
  return { model: process.env.OVERCLOCK_JEV_MODEL || "jev-latest", visionModel: process.env.OVERCLOCK_JEV_VISION_MODEL || "jev-preview" };
}

export interface ChoiceAnswer<L extends string> {
  label: L;
  confidence: number;
  probabilities: Record<L, number>;
  ms: number;
}

export interface BoxAnswer {
  box: { top: number; bottom: number; left: number; right: number };
  confidence: number | null;
  ms: number;
}

const IMAGES_HEADER = { "TypeSafe-Danger-Zone-Images": "true" };

/**
 * Jev (TypeSafe System One) provider: the reflex path. Bounded, typed decisions over observed
 * candidates — never free-form text, never invented targets. Image questions use the
 * experimental images header; every caller must have a DOM-only fallback.
 */
export class JevProvider {
  private client: TypeSafeClient | null = null;
  readonly available: boolean;
  readonly reason?: string | undefined;
  enabled = true;

  constructor(
    readonly config: JevConfig,
    private readonly ledger: ModelLedger,
  ) {
    this.available = !!process.env.TYPESAFE_API_KEY;
    if (!this.available) this.reason = "TYPESAFE_API_KEY is not set";
  }

  get usable(): boolean {
    return this.available && this.enabled;
  }

  private get api(): TypeSafeClient {
    if (!this.usable) throw new ModelUnavailableError(this.reason ?? "Jev disabled for this run");
    this.client ??= new TypeSafeClient({ timeout: 20_000 });
    return this.client;
  }

  async listModels(): Promise<string[]> {
    const cards = await this.api.models.list();
    return cards.map((c) => c.name);
  }

  private async call<Q extends Questions>(purpose: string, model: string, state: unknown, questions: Q, opts: { images?: boolean; signal?: AbortSignal } = {}) {
    this.ledger.guard(((JSON.stringify(state ?? "").length / 3.5) * priceFor(model).input) / 1e6);
    const start = performance.now();
    try {
      const r = await this.api.systemOne({ state: state as never, questions, model }, { signal: opts.signal, headers: opts.images ? IMAGES_HEADER : undefined, timeout: 20_000 });
      const ms = performance.now() - start;
      const input = r.usage.input_tokens ?? 0;
      this.ledger.record({ provider: "typesafe", model: r.model, purpose, ms, inputTokens: input, outputTokens: r.usage.output_tokens ?? 0, costUsd: (input / 1e6) * priceFor(r.model).input, ok: true });
      return { r, ms };
    } catch (err) {
      this.ledger.record({ provider: "typesafe", model, purpose, ms: performance.now() - start, inputTokens: 0, outputTokens: 0, costUsd: 0, ok: false, error: (err as Error).message.slice(0, 200) });
      throw err;
    }
  }

  /** Pick one label among observed alternatives. Labels are caller-defined ids (e.g. candidate ids). */
  async choose<L extends string>(purpose: string, args: { state: unknown; instructions: string; options: Record<L, string>; screenshot?: Buffer; signal?: AbortSignal }): Promise<ChoiceAnswer<L>> {
    const criteria = args.options as Record<string, string>;
    const state = args.screenshot ? { context: args.state, screenshot: new Image(args.screenshot) } : args.state;
    const { r, ms } = await this.call(purpose, this.config.model, state, { pick: choice(args.instructions, criteria) }, { images: !!args.screenshot, signal: args.signal });
    const a = r.answers.pick;
    return { label: a.choice as L, confidence: a.confidence, probabilities: a.probabilities as Record<L, number>, ms };
  }

  /** Several independent choice questions about the same state, evaluated in one request. */
  async chooseMany<K extends string>(purpose: string, args: { state: unknown; questions: Record<K, { instructions: string; options: Record<string, string> }>; signal?: AbortSignal }): Promise<Record<K, { label: string; confidence: number }> & { ms: number }> {
    const qs: Questions = {};
    for (const [k, q] of Object.entries(args.questions) as [K, { instructions: string; options: Record<string, string> }][]) qs[k] = choice(q.instructions, q.options);
    const { r, ms } = await this.call(purpose, this.config.model, args.state, qs, { signal: args.signal });
    const out: Record<string, { label: string; confidence: number }> = {};
    for (const [k, a] of Object.entries(r.answers)) {
      const ans = a as { choice: string; confidence: number };
      out[k] = { label: ans.choice, confidence: ans.confidence };
    }
    return Object.assign(out as Record<K, { label: string; confidence: number }>, { ms });
  }

  async yesNo(purpose: string, args: { state: unknown; question: string; screenshot?: Buffer; signal?: AbortSignal }): Promise<{ p: number; ms: number }> {
    const state = args.screenshot ? { context: args.state, screenshot: new Image(args.screenshot) } : args.state;
    const { r, ms } = await this.call(purpose, this.config.model, state, { q: noul(args.question) }, { images: !!args.screenshot, signal: args.signal });
    return { p: r.answers.q.noul, ms };
  }

  /** Locate something in a screenshot (vision fallback, perception tier 5). */
  async locate(purpose: string, args: { screenshot: Buffer; instructions: string; signal?: AbortSignal }): Promise<BoxAnswer> {
    const { r, ms } = await this.call(purpose, this.config.visionModel, new Image(args.screenshot), { target: box(args.instructions) }, { images: true, signal: args.signal });
    const a = r.answers.target;
    return { box: { top: a.box.top, bottom: a.box.bottom, left: a.box.left, right: a.box.right }, confidence: a.confidence ?? null, ms };
  }
}
