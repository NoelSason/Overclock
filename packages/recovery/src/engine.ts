import type { Page } from "playwright";
import type { ActionNode, AppControl, EventPayload, ObservedControl, ObservedDialog, SemanticLocator } from "@overclock/contracts";
import { HiddenTargetError, preludeKey, resolveLocator, UnexpectedDialogError, type ActionEnv, type RepairArgs, type RepairResult, type ReuseInfo, type RuntimeError } from "@overclock/browser-runtime";
import { BudgetExceededError } from "@overclock/models";
import { observe, routePattern, type Observation } from "@overclock/perception";
import { describeLocator, describeTarget, failingLocator, intentOf, isWriteNode, locatorKey, type TargetDescriptor } from "./describe";
import { classifyButton, decideDialog, dialogButtons, matchDialog, raisedByWrite } from "./dialogs";
import { dialogScope, formOf, locatorForControl, locatorForFact, locatorForTable } from "./locators";
import { compatible, decide, eligible, rankCandidates, rankFacts, type Candidate } from "./match";
import { candidateAtPoint, candidateText, RECOMPILE_SYSTEM, renderObservation, RepairPlanSchema, screenshotForVision, type DeepModel, type ReflexModel } from "./models";
import { dialogRuleKey, locatorRuleKey, RuleBook, type FailureKind, type Rule } from "./rules";
import { IRREVERSIBLE, normalize } from "./text";

export type RecoveryEvent = Extract<EventPayload, { type: "recovery" }>;

export interface RecoveryDeps {
  /** Reflex path (fast typed choices). Optional; may be disabled per run (`jev.enabled = false`). */
  jev?: ReflexModel | undefined;
  /** Deep path for L3 (role "planner"). */
  claude?: DeepModel | undefined;
  emit(e: RecoveryEvent): void;
  /** The engine suspends leasing of that segment template while a model-assisted repair runs. */
  onRepairStart?(segmentKey: string): void;
  onRepairEnd?(segmentKey: string): void;
  /** Allow Jev image questions (screenshot-assisted choice and box-locate). */
  useVision?: boolean | undefined;
  /** App-model lookup for the failing control (options, field name, type) for sharper L1 matching. */
  lookupControl?(controlId: string): AppControl | undefined;
  /** Model calls allowed for the whole run; beyond it repairs escalate. Default 40. */
  maxModelCalls?: number | undefined;
}

export interface RepairRequest {
  node: ActionNode;
  env: ActionEnv;
  error: RuntimeError;
  attempt: number;
  taskId?: string | undefined;
  segmentId?: string | undefined;
}

export interface LevelStats {
  attempts: number;
  successes: number;
  ms: number;
}

export interface RecoveryStats {
  byLevel: Record<number, LevelStats>;
  modelCalls: number;
  /** Page observations taken (L1+). L0 rules and reused overrides take none. */
  observations: number;
  /** Later uses of learned repairs: L0 rule applications plus override reuse reported by runSegment. */
  propagated: number;
  rules: number;
  escalations: number;
  /** Repairs answered by a concurrent in-flight repair of the same failure. */
  deduped: number;
}

export interface RuleSummary {
  id: string;
  kind: Rule["kind"];
  key: string;
  detail: string;
  hits: number;
}

/** Thresholds for model answers: reads/navigation vs anything that writes. */
export const REFLEX_READ_CONFIDENCE = 0.7;
export const REFLEX_WRITE_CONFIDENCE = 0.85;

interface Ctx {
  node: ActionNode;
  env: ActionEnv;
  page: Page;
  error: RuntimeError;
  attempt: number;
  taskId: string;
  segmentKey: string;
  app: string;
  route: string;
  failure: FailureKind;
  /** Override-map key runSegment stores a replacement locator under. */
  key: string;
  current?: SemanticLocator | undefined;
  original?: SemanticLocator | undefined;
  desc?: TargetDescriptor | undefined;
  write: boolean;
  irreversible: boolean;
  /** The dialog was raised by this node's own submit. */
  afterWrite: boolean;
  dialogText: string;
  started: number;
}

type Plan =
  | { kind: "locator"; locator?: SemanticLocator | undefined; prelude: SemanticLocator[]; reason: string }
  | { kind: "dialog"; title: string; button: SemanticLocator; confirmsWrite: boolean; reason: string }
  | { kind: "noop"; reason: string };

interface L1Result {
  plan?: Plan | undefined;
  /** Observed candidates for the model tiers when L1 could not decide. */
  shortlist: ObservedControl[];
  dialog?: ObservedDialog | undefined;
  reason: string;
  /** Escalate immediately (irreversible, unsafe): no model tier may override this. */
  stop?: boolean | undefined;
}

interface Settled {
  result: RepairResult | null;
  ruleId?: string | undefined;
}

const LEVELS = [0, 1, 2, 3, 4];

/**
 * Localized recovery, cheapest level first:
 *  L0 learned rules (no observation, no model) ->
 *  L1 local perception refresh + deterministic matching ->
 *  L2 reflex model (Jev) choosing among observed candidates ->
 *  L3 local recompilation (Claude) of the failing node against the observation ->
 *  L4 escalate to a person.
 * Accepted repairs become L0 rules; concurrent repairs of the same failure share one attempt.
 */
export class RecoveryEngine {
  private readonly rules = new RuleBook();
  private readonly inflight = new Map<string, Promise<Settled>>();
  /** `${taskId}|${key}|${failure}` -> rule last applied for it (so a failing rule is dropped, not re-applied). */
  private readonly lastApplied = new Map<string, string>();
  /** `${segmentKey}|${overrideKey}` -> rule that produced the override (for reuse accounting). */
  private readonly overrideRule = new Map<string, string>();
  private readonly levels: Record<number, LevelStats> = Object.fromEntries(LEVELS.map((l) => [l, { attempts: 0, successes: 0, ms: 0 }]));
  private modelCalls = 0;
  private observations = 0;
  private propagated = 0;
  private escalations = 0;
  private deduped = 0;

  constructor(private readonly deps: RecoveryDeps) {}

  /** Hook implementations for runSegment. */
  hooks(): { repair: (a: RepairArgs) => Promise<RepairResult | null>; onReuse: (i: ReuseInfo) => void } {
    return { repair: (a) => this.repair(a), onReuse: (i) => this.noteReuse(i) };
  }

  stats(): RecoveryStats {
    const byLevel: Record<number, LevelStats> = {};
    for (const l of LEVELS) byLevel[l] = { ...this.levels[l]! };
    return { byLevel, modelCalls: this.modelCalls, observations: this.observations, propagated: this.propagated, rules: this.rules.size, escalations: this.escalations, deduped: this.deduped };
  }

  /** Learned rules with how many later uses each one served. */
  rulesSummary(): RuleSummary[] {
    return this.rules.all().map((r) => ({ id: r.id, kind: r.kind, key: r.key, detail: r.detail, hits: r.hits }));
  }

  /** Total later uses of learned repairs (the `propagatedTo` counter across all rules). */
  propagatedCount(): number {
    return this.propagated;
  }

  /** SegmentHooks.repair implementation. */
  async repair(args: RepairRequest): Promise<RepairResult | null> {
    const ctx = this.context(args);
    const l0 = this.applyRule(ctx);
    if (l0) return l0;
    const dk = this.dedupeKey(ctx);
    const running = this.inflight.get(dk);
    if (running) {
      this.deduped++;
      const shared = await running;
      if (!shared.result) return null;
      const rule = shared.ruleId ? this.rules.get(shared.ruleId) : undefined;
      if (rule) {
        rule.hits++;
        this.propagated++;
        this.lastApplied.set(this.taskKey(ctx), rule.id);
        this.mapOverrides(ctx, rule.id, shared.result);
      }
      this.emit(ctx, shared.result.level, "succeeded", `Shared the repair from a concurrent worker: ${shared.result.detail}`, { ms: performance.now() - ctx.started, propagatedTo: rule?.hits });
      return { ...shared.result, modelCalls: 0, detail: `${shared.result.detail} (shared with a concurrent repair)` };
    }
    const p = this.resolve(ctx).finally(() => this.inflight.delete(dk));
    this.inflight.set(dk, p);
    return (await p).result;
  }

  /** runSegment reports a node that succeeded through overrides learned on an earlier record. */
  noteReuse(info: ReuseInfo): void {
    const seen = new Set<string>();
    for (const k of info.keys) {
      const id = this.overrideRule.get(`${info.segmentId ?? ""}|${k}`) ?? this.overrideRule.get(`*|${k}`);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const rule = this.rules.get(id);
      if (!rule) continue;
      rule.hits++;
      this.propagated++;
      // One event on the first reuse, then every tenth: the counters carry the exact numbers.
      if (rule.hits === 1 || rule.hits % 10 === 0) {
        this.deps.emit({ type: "recovery", taskId: info.taskId, level: 0, phase: "succeeded", reason: `Reused a learned repair with no new observation: ${rule.detail}`, detail: `rule ${rule.id} on ${info.nodeId}`, ms: 0, propagatedTo: rule.hits });
      }
    }
  }

  // ---------------------------------------------------------------------------------------------

  private context(a: RepairRequest): Ctx {
    const page = a.env.page;
    let route = "/";
    try {
      route = routePattern(page.url());
    } catch {
      route = "/";
    }
    const app = a.node.app ?? (() => {
      try {
        return new URL(page.url()).host;
      } catch {
        return "app";
      }
    })();
    const failure: FailureKind = a.error instanceof UnexpectedDialogError ? "dialog" : a.error instanceof HiddenTargetError ? "hidden" : "relocate";
    const f = failingLocator(a.node, a.env, a.error.nodeId);
    const info = f.original?.controlId ? this.deps.lookupControl?.(f.original.controlId) : undefined;
    const desc = f.current ? describeTarget({ node: a.node, env: a.env, loc: f.original ?? f.current, field: f.field, info }) : undefined;
    // When an override replaced the original, its names are evidence too.
    if (desc && f.current && f.current !== f.original) for (const n of describeTarget({ node: a.node, env: a.env, loc: f.current, field: f.field }).names) if (!desc.names.includes(n)) desc.names.push(n);
    const dialogText = a.error instanceof UnexpectedDialogError ? a.error.dialogText : "";
    const write = isWriteNode(a.node);
    return {
      node: a.node,
      env: a.env,
      page,
      error: a.error,
      attempt: a.attempt,
      taskId: a.taskId ?? "unknown",
      segmentKey: a.segmentId ?? `${app}:${route}`,
      app,
      route,
      failure,
      key: f.key,
      current: f.current,
      original: f.original,
      desc,
      write,
      irreversible: a.node.effect === "irreversible",
      afterWrite: failure === "dialog" && write && raisedByWrite(a.error.message),
      dialogText,
      started: performance.now(),
    };
  }

  private taskKey(ctx: Ctx): string {
    return `${ctx.taskId}|${ctx.key}|${ctx.failure}`;
  }

  private dedupeKey(ctx: Ctx): string {
    const what = ctx.failure === "dialog" ? `${ctx.afterWrite ? "w" : "b"}:${normalize(ctx.dialogText).slice(0, 40)}` : ctx.key;
    return `${ctx.segmentKey}|${ctx.node.id}|${ctx.failure}|${what}`;
  }

  private targetKey(ctx: Ctx): string {
    return ctx.original ? locatorKey(ctx.original) : ctx.key;
  }

  private ruleKey(ctx: Ctx): string {
    return ctx.failure === "dialog" ? dialogRuleKey(ctx.app, ctx.route, ctx.afterWrite) : locatorRuleKey(ctx.app, ctx.route, ctx.failure, this.targetKey(ctx));
  }

  private reasonFor(ctx: Ctx): string {
    switch (ctx.failure) {
      case "dialog":
        return ctx.afterWrite ? `Submitting ${ctx.node.id} opened a dialog: ${ctx.dialogText.split("\n")[0]?.slice(0, 80)}` : `A dialog is blocking ${ctx.node.id}: ${ctx.dialogText.split("\n")[0]?.slice(0, 80)}`;
      case "hidden":
        return `${ctx.node.id}: target is on the page but hidden (${ctx.current ? describeLocator(ctx.current) : "no locator"})`;
      case "relocate":
        return `${ctx.node.id}: ${ctx.error.constructor.name === "AmbiguousLocatorError" ? "target is ambiguous" : "target not found"} (${ctx.current ? describeLocator(ctx.current) : "no locator"})`;
    }
  }

  private emit(ctx: Ctx, level: number, phase: RecoveryEvent["phase"], reason: string, extra: { detail?: string | undefined; ms?: number | undefined; propagatedTo?: number | undefined } = {}): void {
    const e: RecoveryEvent = { type: "recovery", taskId: ctx.taskId, level, phase, reason };
    if (extra.detail !== undefined) e.detail = extra.detail;
    if (extra.ms !== undefined) e.ms = Math.round(extra.ms * 10) / 10;
    if (extra.propagatedTo !== undefined) e.propagatedTo = extra.propagatedTo;
    this.deps.emit(e);
  }

  private bump(level: number, ok: boolean, ms: number): void {
    const s = this.levels[level]!;
    s.attempts++;
    if (ok) s.successes++;
    s.ms += ms;
  }

  private mapOverrides(ctx: Ctx, ruleId: string, r: RepairResult): void {
    if (r.locator) {
      this.overrideRule.set(`${ctx.segmentKey}|${ctx.key}`, ruleId);
      this.overrideRule.set(`*|${ctx.key}`, ruleId);
    }
    if (r.prelude?.length) {
      this.overrideRule.set(`${ctx.segmentKey}|${preludeKey(ctx.node.id, 0)}`, ruleId);
      this.overrideRule.set(`*|${preludeKey(ctx.node.id, 0)}`, ruleId);
    }
  }

  // L0 ------------------------------------------------------------------------------------------

  private applyRule(ctx: Ctx): RepairResult | null {
    const key = this.ruleKey(ctx);
    const rule = ctx.failure === "dialog" ? this.rules.dialog(key, ctx.dialogText) : this.rules.locator(key);
    if (!rule) return null;
    const tk = this.taskKey(ctx);
    // A rule that was just applied for this task and failed again is stale: drop it and re-derive.
    if (ctx.attempt > 0 && this.lastApplied.get(tk) === rule.id) {
      this.rules.forget(rule.id);
      this.emit(ctx, 0, "failed", `Learned rule no longer works and was dropped: ${rule.detail}`, { detail: `rule ${rule.id}` });
      this.bump(0, false, 0);
      return null;
    }
    let result: RepairResult;
    if (rule.kind === "dialog") {
      if (rule.confirmsWrite && (!ctx.afterWrite || ctx.irreversible)) return null;
      result = { dismiss: rule.button, confirmsWrite: rule.confirmsWrite, level: 0, modelCalls: 0, detail: `L0 rule ${rule.id}: ${rule.detail}` };
    } else {
      if (rule.locator && ctx.current && JSON.stringify(rule.locator.strategies) === JSON.stringify(ctx.current.strategies) && !rule.prelude?.length) {
        // The override in effect IS this rule and it failed: re-derive.
        this.rules.forget(rule.id);
        return null;
      }
      result = { level: 0, modelCalls: 0, detail: `L0 rule ${rule.id}: ${rule.detail}` };
      if (rule.locator) result.locator = rule.locator;
      if (rule.prelude?.length) result.prelude = rule.prelude;
    }
    rule.hits++;
    this.propagated++;
    this.lastApplied.set(tk, rule.id);
    this.mapOverrides(ctx, rule.id, result);
    const ms = performance.now() - ctx.started;
    this.bump(0, true, ms);
    this.emit(ctx, 0, "succeeded", `${this.reasonFor(ctx)}; applied learned rule: ${rule.detail}`, { detail: `rule ${rule.id}`, ms, propagatedTo: rule.hits });
    return result;
  }

  // L1 -> L4 ------------------------------------------------------------------------------------

  private async resolve(ctx: Ctx): Promise<Settled> {
    const reason = this.reasonFor(ctx);
    const t1 = performance.now();
    this.emit(ctx, 1, "started", reason);
    let obs: Observation;
    let l1: L1Result;
    try {
      obs = await observe(ctx.page);
      this.observations++;
      l1 = await this.deterministic(ctx, obs);
    } catch (err) {
      this.bump(1, false, performance.now() - t1);
      this.emit(ctx, 1, "failed", `Could not refresh perception: ${(err as Error).message.split("\n")[0]}`);
      return this.escalate(ctx, `${reason}; the page could not be observed`);
    }
    const l1ms = performance.now() - t1;
    this.bump(1, !!l1.plan, l1ms);
    if (l1.plan) {
      this.emit(ctx, 1, "succeeded", l1.reason, { ms: l1ms });
      return this.accept(ctx, l1.plan, 1, 0);
    }
    this.emit(ctx, 1, "failed", l1.reason, { ms: l1ms });
    if (l1.stop) return this.escalate(ctx, l1.reason);
    if (ctx.irreversible) return this.escalate(ctx, `${l1.reason}. The step cannot be undone, so it is not repaired by a model`);
    const jev = this.deps.jev?.usable ? this.deps.jev : undefined;
    const claude = this.deps.claude?.available ? this.deps.claude : undefined;
    if (!jev && !claude) return this.escalate(ctx, `${l1.reason}. No repair model is available`);
    if (this.modelCalls >= (this.deps.maxModelCalls ?? 40)) return this.escalate(ctx, `${l1.reason}. The repair model budget for this run is used up`);

    this.deps.onRepairStart?.(ctx.segmentKey);
    let calls = 0;
    try {
      if (jev && (l1.shortlist.length || this.deps.useVision)) {
        const r = await this.reflex(ctx, obs, l1, jev);
        calls += r.calls;
        if (r.plan) return this.accept(ctx, r.plan, 2, calls);
        if (r.budget) return this.escalate(ctx, `${l1.reason}. The model spend budget is exhausted`);
      }
      if (claude) {
        const r = await this.recompile(ctx, obs, l1, claude);
        calls += r.calls;
        if (r.plan) return this.accept(ctx, r.plan, 3, calls);
        if (r.budget) return this.escalate(ctx, `${l1.reason}. The model spend budget is exhausted`);
        return this.escalate(ctx, `${l1.reason}. Recompilation: ${r.reason}`, calls);
      }
      return this.escalate(ctx, `${l1.reason}. The reflex model was not confident enough`, calls);
    } finally {
      this.deps.onRepairEnd?.(ctx.segmentKey);
    }
  }

  private escalate(ctx: Ctx, reason: string, modelCalls = 0): Settled {
    this.escalations++;
    this.bump(4, false, 0);
    this.emit(ctx, 4, "escalated", reason, { ms: performance.now() - ctx.started, detail: modelCalls ? `${modelCalls} model call(s)` : undefined });
    return { result: null };
  }

  private accept(ctx: Ctx, plan: Plan, level: number, modelCalls: number): Settled {
    let result: RepairResult;
    let rule: Rule | undefined;
    if (plan.kind === "dialog") {
      result = { dismiss: plan.button, confirmsWrite: plan.confirmsWrite, level, modelCalls, detail: plan.reason };
      rule = this.rules.learnDialog(this.ruleKey(ctx), { title: plan.title, button: plan.button, confirmsWrite: plan.confirmsWrite, detail: plan.reason });
    } else if (plan.kind === "locator") {
      result = { level, modelCalls, detail: plan.reason };
      if (plan.locator) result.locator = plan.locator;
      if (plan.prelude.length) result.prelude = plan.prelude;
      rule = this.rules.learnLocator(this.ruleKey(ctx), { locator: plan.locator, prelude: plan.prelude.length ? plan.prelude : undefined, detail: plan.reason });
      this.mapOverrides(ctx, rule.id, result);
    } else {
      result = { level, modelCalls, detail: plan.reason };
    }
    if (rule) this.lastApplied.set(this.taskKey(ctx), rule.id);
    if (level > 1) this.emit(ctx, level, "succeeded", plan.reason, { ms: performance.now() - ctx.started, detail: `${modelCalls} model call(s)` });
    return { result, ruleId: rule?.id };
  }

  // L1 ------------------------------------------------------------------------------------------

  private async deterministic(ctx: Ctx, obs: Observation): Promise<L1Result> {
    if (ctx.failure === "dialog") return this.dialogL1(ctx, obs);
    if (!ctx.current || !ctx.desc) return { shortlist: [], reason: `${ctx.node.id} has no target to repair`, stop: true };
    if (ctx.failure === "hidden") {
      const revealed = await this.revealL1(ctx, obs);
      if (revealed) return revealed;
    }
    return this.relocateL1(ctx, obs, ctx.desc);
  }

  private dialogL1(ctx: Ctx, obs: Observation): L1Result | Promise<L1Result> {
    const dialog = matchDialog(obs, ctx.dialogText);
    if (!dialog) return { plan: { kind: "noop", reason: "The dialog closed on its own" }, shortlist: [], reason: "The dialog closed on its own" };
    const d = decideDialog({ obs, dialog, afterWrite: ctx.afterWrite, nodeIsWrite: ctx.write, nodeIrreversible: ctx.irreversible });
    switch (d.action) {
      case "confirm":
      case "dismiss":
        return this.dialogRole(ctx.page, dialog).then((role) => ({
          plan: { kind: "dialog" as const, title: dialog.title || dialog.text.slice(0, 40), button: locatorForControl(obs, d.button, { confidence: 0.95, dialogScope: dialogScope(dialog, role) }), confirmsWrite: d.action === "confirm", reason: d.reason },
          shortlist: [],
          dialog,
          reason: d.reason,
        }));
      case "ambiguous":
        return { shortlist: d.candidates, dialog, reason: d.reason };
      case "escalate":
        return { shortlist: [], dialog, reason: d.reason, stop: true };
    }
  }

  /** Role attribute of an observed dialog (dialog vs alertdialog), for scoping its buttons. */
  private async dialogRole(page: Page, d: ObservedDialog): Promise<string> {
    const idx = Number(d.id.slice(1));
    return page
      .evaluate((i) => {
        const el = document.querySelectorAll("[role=dialog],[role=alertdialog],dialog")[i];
        return el?.getAttribute("role") ?? "dialog";
      }, idx)
      .catch(() => "dialog");
  }

  /** Hidden target: the tab (or disclosure) that reveals it becomes a pre-click. */
  private async revealL1(ctx: Ctx, obs: Observation): Promise<L1Result | null> {
    const revealer = await revealerOf(ctx.page, ctx.current!);
    if (!revealer) return null;
    const tab = obs.controls.find((c) => (c.role === revealer.role || (revealer.role === "button" && c.tag === "summary")) && ((revealer.id && c.cssPath === `#${revealer.id}`) || normalize(c.name) === normalize(revealer.name)));
    if (!tab || tab.disabled) return null;
    const pre = locatorForControl(obs, tab, { confidence: 0.95 });
    const reason = `${ctx.node.id}: the target sits on the "${revealer.name}" ${revealer.role === "tab" ? "tab" : "section"}; selecting it first`;
    return { plan: { kind: "locator", prelude: [pre], reason }, shortlist: [], reason };
  }

  private relocateL1(ctx: Ctx, obs: Observation, d: TargetDescriptor): L1Result {
    const mctx = { write: ctx.write && d.kind === "button", irreversible: ctx.irreversible };
    if (d.kind === "table") return this.tableL1(ctx, obs);
    let ranked = rankCandidates(d, obs, mctx);
    // A hidden target only moves to a *visible* twin; the hidden original is what failed.
    if (ctx.failure === "hidden") ranked = ranked.filter((c) => c.control.visible);
    if (d.kind === "value") {
      const facts = rankFacts(d, obs);
      const bestFact = facts[0];
      const bestField = ranked[0];
      if (bestFact && (!bestField || bestFact.score > bestField.score)) {
        const margin = bestFact.score - Math.max(facts[1]?.score ?? 0, bestField?.score ?? 0);
        if (bestFact.score >= 0.6 && margin >= 0.15) {
          const loc = locatorForFact(obs, bestFact.idx, { controlId: ctx.original?.controlId, confidence: bestFact.score });
          const reason = `${ctx.node.id}: value now labelled "${bestFact.label}" (score ${bestFact.score.toFixed(2)})`;
          if (loc) return { plan: { kind: "locator", locator: loc, prelude: [], reason }, shortlist: [], reason };
        }
        return { shortlist: ranked.slice(0, 6).map((c) => c.control), reason: `${ctx.node.id}: no clear match for the value (best "${bestFact.label}" ${bestFact.score.toFixed(2)})` };
      }
    }
    const dec = decide(ranked);
    if (dec.pick && ctx.irreversible && !d.names.some((n) => normalize(n) === normalize(dec.pick!.control.name))) {
      return { shortlist: [], reason: `${ctx.node.id} cannot be undone and its control was renamed (${dec.reason}); a person must confirm the new control`, stop: true };
    }
    if (dec.pick) {
      const plan = this.planFor(ctx, obs, dec.pick.control, dec.pick.score, `${ctx.node.id}: matched ${dec.reason}`);
      if (plan) return { plan, shortlist: [], reason: plan.reason };
      return { shortlist: [], reason: `${ctx.node.id}: matched control is on a hidden tab that cannot be selected`, stop: true };
    }
    if (ctx.irreversible) return { shortlist: [], reason: `${ctx.node.id} cannot be undone and no exact match exists (${dec.reason})`, stop: true };
    return { shortlist: dec.shortlist.map((c) => c.control), reason: `${ctx.node.id}: ${dec.reason}` };
  }

  private tableL1(ctx: Ctx, obs: Observation): L1Result {
    const want = Object.values(ctx.node.table?.columns ?? {}).map((h) => normalize(h));
    const fits = obs.tables.map((t, i) => ({ i, t })).filter(({ t }) => want.every((w) => t.headers.some((h) => normalize(h) === w)));
    if (fits.length === 1) {
      const loc = locatorForTable(obs, fits[0]!.i, { controlId: ctx.original?.controlId, confidence: 0.9 });
      const reason = `${ctx.node.id}: the only table with columns ${want.join(", ")}`;
      if (loc) return { plan: { kind: "locator", locator: loc, prelude: [], reason }, shortlist: [], reason };
    }
    return { shortlist: [], reason: fits.length ? `${fits.length} tables have the required columns` : `no table has the columns ${want.join(", ")}`, stop: true };
  }

  /** Locator (+ tab pre-click when the control sits on a hidden tab) for an accepted control. */
  private planFor(ctx: Ctx, obs: Observation, c: ObservedControl, confidence: number, reason: string): Plan | null {
    const prelude: SemanticLocator[] = [];
    if (!c.visible && c.tabPanel) {
      const tab = obs.controls.find((t) => t.role === "tab" && normalize(t.name) === normalize(c.tabPanel));
      if (!tab) return null;
      prelude.push(locatorForControl(obs, tab, { confidence: 0.95 }));
    }
    return { kind: "locator", locator: locatorForControl(obs, c, { controlId: ctx.original?.controlId, confidence }), prelude, reason };
  }

  /** Model answers must name an observed candidate that is still structurally valid. */
  private corroborate(ctx: Ctx, obs: Observation, c: ObservedControl, dialog: ObservedDialog | undefined): { ok: true; plan: Promise<Plan | null> | Plan | null } | { ok: false; why: string } {
    if (ctx.failure === "dialog") {
      if (!dialog || !dialog.controlIds.includes(c.id)) return { ok: false, why: `${c.id} is not a button of the open dialog` };
      const cls = classifyButton(c.name, ctx.afterWrite);
      if (cls === "irreversible") return { ok: false, why: `"${c.name}" cannot be undone` };
      const confirms = ctx.afterWrite;
      if (confirms && (cls === "cancel" || cls === "dismiss")) return { ok: false, why: `"${c.name}" would cancel the submitted edit` };
      if (!confirms && cls === "confirm") return { ok: false, why: `"${c.name}" would confirm something this step never asked for` };
      return {
        ok: true,
        plan: this.dialogRole(ctx.page, dialog).then((role) => ({ kind: "dialog" as const, title: dialog.title || dialog.text.slice(0, 40), button: locatorForControl(obs, c, { confidence: 0.85, dialogScope: dialogScope(dialog, role) }), confirmsWrite: confirms, reason: "" })),
      };
    }
    const d = ctx.desc;
    if (!d) return { ok: false, why: "no target descriptor" };
    if (!compatible(d.kind, c)) return { ok: false, why: `${c.id} (${c.role}) is not a ${d.kind}` };
    const pool = eligible(d, obs, { write: ctx.write && d.kind === "button", irreversible: ctx.irreversible });
    if (!pool.some((p) => p.id === c.id)) return { ok: false, why: `${c.id} fails the structural checks for this step (disabled, in a dialog, destructive, or not a form submit)` };
    if (ctx.failure === "hidden" && !c.visible && !c.tabPanel) return { ok: false, why: `${c.id} is hidden` };
    if (d.kind === "select" && d.desired && !(c.options ?? []).some((o) => normalize(o.value) === normalize(d.desired) || normalize(o.label) === normalize(d.desired))) return { ok: false, why: `${c.id} does not offer "${d.desired}"` };
    if (ctx.write && d.kind === "button" && d.scopeCss) {
      const f = formOf(obs, c);
      const scoped = obs.forms.find((x) => x.cssPath === d.scopeCss);
      if (scoped && f?.id !== scoped.id) return { ok: false, why: `${c.id} submits a different form than the step's` };
    }
    return { ok: true, plan: this.planFor(ctx, obs, c, 0.85, "") };
  }

  private writeish(ctx: Ctx): boolean {
    if (ctx.failure === "dialog") return ctx.afterWrite;
    return ctx.write || ctx.node.effect === "local-write" || ctx.node.type === "fill" || ctx.node.type === "select";
  }

  // L2 ------------------------------------------------------------------------------------------

  /**
   * Role-focused question for Jev: what the step does, what it was recorded against, and which
   * observed control now plays that role. Phrasing calibrated live (see models.ts optionText).
   */
  private reflexQuestion(ctx: Ctx, obs: Observation, l1: L1Result): { task: string; instructions: string; intent: string } {
    if (ctx.failure === "dialog") {
      const d = l1.dialog;
      const about = `a dialog titled "${d?.title ?? ""}" ("${(d?.text ?? ctx.dialogText).slice(0, 200)}")`;
      return ctx.afterWrite
        ? { task: `A browser automation step submitted the edit form on this page, and ${about} opened.`, instructions: "Which dialog button confirms the submitted edit?", intent: "the dialog button that confirms the submitted edit" }
        : { task: `${about[0]!.toUpperCase()}${about.slice(1)} is covering the page while a browser automation step tries to continue.`, instructions: "Which dialog button closes this dialog without changing anything?", intent: "the dialog button that closes the dialog without changing anything" };
    }
    const d = ctx.desc!;
    const name = d.label ?? d.names[0] ?? "the original control";
    const broken = ctx.failure === "hidden" ? "is hidden" : ctx.error.constructor.name === "AmbiguousLocatorError" ? "now matches several controls" : "can no longer be found";
    const noun = d.kind === "select" ? "dropdown" : d.kind === "field" ? "text field" : d.kind === "value" ? "field" : d.kind;
    const recorded = `It was recorded against a ${noun} labelled "${name}", which ${broken}.`;
    switch (d.kind) {
      case "select":
      case "field":
      case "checkbox":
        return { task: `A browser automation step sets the "${name}" ${noun} on this page${d.desired ? ` to "${d.desired}"` : ""}. ${recorded}`, instructions: `Which ${noun} on the page now holds the "${name}" value that the step must set?`, intent: intentOf(ctx.node, d) };
      case "button":
        if (ctx.write) return { task: `A browser automation step submits the form being edited on this page. ${recorded}`, instructions: "Which button on the page now submits the form being edited?", intent: intentOf(ctx.node, d) };
        return { task: `A browser automation step clicks "${name}"${ctx.node.description ? ` (${ctx.node.description})` : ""} on this page. ${recorded}`, instructions: `Which button on the page now does what "${name}" did?`, intent: intentOf(ctx.node, d) };
      case "value":
        return { task: `A browser automation step reads the "${name}" value on this page. ${recorded}`, instructions: `Which field on the page now shows the "${name}" value?`, intent: intentOf(ctx.node, d) };
      default:
        return { task: `A browser automation step uses the ${noun} "${name}" on this page. ${recorded}`, instructions: `Which ${noun} on the page now does what "${name}" did?`, intent: intentOf(ctx.node, d) };
    }
    void obs;
  }

  private async reflex(ctx: Ctx, obs: Observation, l1: L1Result, jev: ReflexModel): Promise<{ plan?: Plan; calls: number; budget?: boolean }> {
    const t = performance.now();
    const writeish = this.writeish(ctx);
    const threshold = writeish ? REFLEX_WRITE_CONFIDENCE : REFLEX_READ_CONFIDENCE;
    const qn = this.reflexQuestion(ctx, obs, l1);
    const intent = qn.intent;
    this.emit(ctx, 2, "started", `Asking the reflex model for ${intent} among ${l1.shortlist.length} observed candidate(s)`);
    let calls = 0;
    const shot = this.deps.useVision ? await screenshotForVision(ctx.page) : null;
    const fail = (why: string) => {
      const ms = performance.now() - t;
      this.bump(2, false, ms);
      this.emit(ctx, 2, "failed", why, { ms, detail: `${calls} model call(s)` });
    };
    if (l1.shortlist.length) {
      const state = { task: qn.task, page: { title: obs.title, url: obs.url } };
      try {
        calls++;
        this.modelCalls++;
        let picked: { c: ObservedControl | undefined; confidence: number; margin: number; ms: number; label: string };
        if (l1.shortlist.length === 1) {
          // One candidate: a choice question is meaningless, so ask whether it fits.
          const only = l1.shortlist[0]!;
          const yn = await jev.yesNo("recovery.reflex", { state, question: `Is ${optionText(obs, only, l1.shortlist)} the control the step needs? ${qn.instructions}`, ...(shot ? { screenshot: shot.image } : {}) });
          picked = { c: only, confidence: yn.p, margin: 1, ms: yn.ms, label: only.id };
        } else {
          const options: Record<string, string> = {};
          for (const c of l1.shortlist) options[c.id] = optionText(obs, c, l1.shortlist);
          const ans = await jev.choose("recovery.reflex", { state, instructions: qn.instructions, options, ...(shot ? { screenshot: shot.image } : {}) });
          const probs = Object.values(ans.probabilities as Record<string, number>).sort((a, b) => b - a);
          picked = { c: l1.shortlist.find((x) => x.id === ans.label), confidence: ans.confidence, margin: (probs[0] ?? 0) - (probs[1] ?? 0), ms: ans.ms, label: ans.label };
        }
        const c = picked.c;
        if (!c) {
          fail(`Reflex model chose "${picked.label}", which is not a candidate`);
        } else if (picked.confidence < threshold) {
          fail(`Reflex model chose ${c.id} "${c.label ?? c.name}" with confidence ${picked.confidence.toFixed(2)} < ${threshold}`);
        } else if (writeish && picked.margin < 0.5) {
          fail(`Reflex model chose ${c.id} "${c.label ?? c.name}" but the runner-up is close (probability margin ${picked.margin.toFixed(2)} < 0.5)`);
        } else {
          const v = this.corroborate(ctx, obs, c, l1.dialog);
          const plan = v.ok ? await v.plan : null;
          if (v.ok && plan) {
            plan.reason = `Reflex model chose ${c.id} "${c.label ?? c.name}" (confidence ${ans.confidence.toFixed(2)}, ${Math.round(ans.ms)} ms${shot ? ", with screenshot" : ""})`;
            const ms = performance.now() - t;
            this.bump(2, true, ms);
            return { plan, calls };
          }
          fail(`Reflex answer ${c.id} rejected: ${v.ok ? "its hidden tab cannot be selected" : v.why}`);
        }
      } catch (err) {
        if (err instanceof BudgetExceededError) {
          calls--;
          this.modelCalls--;
          fail(err.message);
          return { calls, budget: true };
        }
        fail(`Reflex model call failed: ${(err as Error).message.slice(0, 160)}`);
      }
    }
    // Vision tier: locate on a screenshot, map the point to an element, re-verify its identity.
    if (shot && !ctx.irreversible && ctx.failure !== "dialog" && ctx.desc) {
      const pool = rankCandidates(ctx.desc, obs, { write: ctx.write && ctx.desc.kind === "button", irreversible: ctx.irreversible }).map((c: Candidate) => c.control).filter((c) => c.visible);
      if (pool.length) {
        const tv = performance.now();
        this.emit(ctx, 2, "started", `Locating ${intent} on a screenshot`);
        try {
          calls++;
          this.modelCalls++;
          const box = await jev.locate("recovery.vision", { screenshot: shot.image, instructions: intent });
          const x = ((box.box.left + box.box.right) / 2) * shot.width;
          const y = ((box.box.top + box.box.bottom) / 2) * shot.height;
          const i = await candidateAtPoint(ctx.page, x, y, pool.map((c) => c.cssPath));
          const c = i >= 0 ? pool[i] : undefined;
          const conf = box.confidence;
          const enough = conf === null ? !this.writeish(ctx) : conf >= threshold;
          if (c && enough) {
            const v = this.corroborate(ctx, obs, c, undefined);
            const plan = v.ok ? await v.plan : null;
            if (plan) {
              plan.reason = `Vision located ${c.id} "${c.label ?? c.name}" at (${Math.round(x)}, ${Math.round(y)})${conf !== null ? `, confidence ${conf.toFixed(2)}` : ""}`;
              const ms = performance.now() - tv;
              this.bump(2, true, ms);
              return { plan, calls };
            }
          }
          const ms = performance.now() - tv;
          this.bump(2, false, ms);
          this.emit(ctx, 2, "failed", c ? `Vision located ${c.id} but ${enough ? "it failed re-verification" : `confidence ${conf?.toFixed(2)} is below ${threshold}`}` : `Vision box at (${Math.round(x)}, ${Math.round(y)}) is not on a candidate control`, { ms });
        } catch (err) {
          if (err instanceof BudgetExceededError) {
            calls--;
            this.modelCalls--;
            return { calls, budget: true };
          }
          this.bump(2, false, performance.now() - tv);
          this.emit(ctx, 2, "failed", `Vision call failed: ${(err as Error).message.slice(0, 160)}`);
        }
      }
    }
    return { calls };
  }

  // L3 ------------------------------------------------------------------------------------------

  private async recompile(ctx: Ctx, obs: Observation, l1: L1Result, claude: DeepModel): Promise<{ plan?: Plan; calls: number; reason: string; budget?: boolean }> {
    const t = performance.now();
    this.emit(ctx, 3, "started", `Recompiling ${ctx.node.id} against the current page`);
    const d = ctx.desc;
    const intent = ctx.failure === "dialog" ? (ctx.afterWrite ? "confirm the edit this step just submitted, via the open dialog" : "close the open informational dialog without changing anything") : d ? intentOf(ctx.node, d) : ctx.node.id;
    const user = [
      "<failing_step>",
      `id: ${ctx.node.id}`,
      `type: ${ctx.node.type}`,
      `effect: ${ctx.node.effect}`,
      ctx.node.description ? `description: ${ctx.node.description}` : "",
      d ? `original target: ${d.summary}` : "",
      d?.desired ? `value to select: ${JSON.stringify(d.desired)}` : "",
      `intent: ${intent}`,
      `error: ${ctx.error.constructor.name}: ${ctx.error.message.slice(0, 240)}`,
      `deterministic matching: ${l1.reason}`,
      l1.shortlist.length ? `deterministic shortlist: ${l1.shortlist.map((c) => c.id).join(", ")}` : "",
      "</failing_step>",
      "<page_observation>",
      renderObservation(obs),
      "</page_observation>",
    ]
      .filter(Boolean)
      .join("\n");
    let calls = 0;
    const fail = (why: string) => {
      const ms = performance.now() - t;
      this.bump(3, false, ms);
      this.emit(ctx, 3, "failed", why, { ms, detail: `${calls} model call(s)` });
      return { calls, reason: why };
    };
    try {
      calls++;
      this.modelCalls++;
      const res = await claude.parse({ role: "planner", purpose: "recovery.recompile", system: RECOMPILE_SYSTEM, user, schema: RepairPlanSchema, maxTokens: 2000, effort: "low" });
      const out = res.data;
      if (out.kind === "impossible") return fail(`Model found no safe repair: ${out.reason.slice(0, 200)}`);
      const c = obs.controls.find((x) => x.id === out.controlId);
      if (!c) return fail(`Model answered ${out.controlId}, which is not in the observation`);
      const v = this.corroborate(ctx, obs, c, l1.dialog);
      if (!v.ok) return fail(`Model answer ${c.id} rejected: ${v.why}`);
      const plan = await v.plan;
      if (!plan) return fail(`Model answer ${c.id} sits on a hidden tab that cannot be selected`);
      if (plan.kind === "locator") {
        for (const id of out.preludeClicks) {
          const p = obs.controls.find((x) => x.id === id);
          if (!p) return fail(`Model pre-click ${id} is not in the observation`);
          if (p.role !== "tab" || p.disabled || IRREVERSIBLE.test(p.name)) return fail(`Model pre-click ${id} is not a tab`);
          if (!plan.prelude.some((x) => x.evidence.some((e) => e.controlId === p.id))) plan.prelude.push(locatorForControl(obs, p, { confidence: 0.85 }));
        }
      }
      plan.reason = `Recompiled ${ctx.node.id} onto ${c.id} "${c.label ?? c.name}": ${out.rationale.slice(0, 200)} (${Math.round(res.ms)} ms, $${res.costUsd.toFixed(4)})`;
      const ms = performance.now() - t;
      this.bump(3, true, ms);
      return { plan, calls, reason: plan.reason };
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        calls--;
        this.modelCalls--;
        return { ...fail(err.message), budget: true };
      }
      return fail(`Recompilation call failed: ${(err as Error).message.slice(0, 200)}`);
    }
  }
}

/** The tab (or <details> summary) that reveals a hidden element. */
async function revealerOf(page: Page, loc: SemanticLocator): Promise<{ id: string | null; name: string; role: string } | null> {
  try {
    const r = await resolveLocator(page, loc, { timeoutMs: 300, allowFirst: true });
    return await r.locator.evaluate((el) => {
      const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
      const panel = el.closest("[role=tabpanel]");
      if (panel) {
        let tab: Element | null = panel.id ? document.querySelector(`[role=tab][aria-controls~="${CSS.escape(panel.id)}"]`) : null;
        const by = panel.getAttribute("aria-labelledby");
        if (!tab && by) tab = document.getElementById(by.split(/\s+/)[0] ?? "");
        if (tab) return { id: tab.id || null, name: clean(tab.getAttribute("aria-label") || tab.textContent), role: "tab" };
      }
      const det = el.closest("details:not([open])");
      const summary = det?.querySelector(":scope > summary");
      if (summary) return { id: summary.id || null, name: clean(summary.textContent), role: "button" };
      return null;
    });
  } catch {
    return null;
  }
}
