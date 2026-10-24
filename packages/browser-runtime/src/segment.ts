import type { Page } from "playwright";
import type { ActionNode, SemanticLocator } from "@overclock/contracts";
import { evaluateBool } from "@overclock/compiler";
import { checkPostconditions, checkPreconditions, executeAction, exprScope, openDialogText, type ActionEnv, type ActionOutcome, type RecordScope } from "./actions";
import { AmbiguousLocatorError, ApprovalRequiredError, CancelledError, HiddenTargetError, LocatorNotFoundError, RuntimeError, UnexpectedDialogError } from "./errors";
import { resolveLocator } from "./locate";
import { readBack, type ReadBackResult } from "./readback";
import type { BrowserWorker } from "./worker";

export interface ActionRecord {
  taskId: string;
  nodeId: string;
  actionType: string;
  ms: number;
  ok: boolean;
  modelCalls: number;
  locatorTier?: number | undefined;
  detail?: string | undefined;
}

export interface RepairResult {
  /** Replacement locator for the failing node (or `${nodeId}#field`). */
  locator?: SemanticLocator;
  /** For dialog interference: control to click to clear it (or to confirm, for writes). */
  dismiss?: SemanticLocator;
  /** Whether the dismiss control confirms the pending write (vs cancelling the dialog). */
  confirmsWrite?: boolean;
  /**
   * Read-only clicks (e.g. the tab that reveals a hidden field), run in order before the node is
   * retried. They are kept in the template's override map under `${nodeId}#prelude:<i>` and
   * replayed before the node on every later record, so a hidden-tab repair costs nothing again.
   */
  prelude?: SemanticLocator[];
  level: number;
  modelCalls: number;
  detail: string;
}

export interface RepairArgs {
  node: ActionNode;
  env: ActionEnv;
  error: RuntimeError;
  attempt: number;
  taskId: string;
  segmentId?: string | undefined;
}

/** A node succeeded using repairs learned on an earlier record of the same template. */
export interface ReuseInfo {
  taskId: string;
  segmentId?: string | undefined;
  nodeId: string;
  /** Override-map keys that were in effect (`nodeId`, `nodeId#field`, `nodeId#prelude:<i>`). */
  keys: string[];
}

export interface SegmentHooks {
  signal?: AbortSignal | undefined;
  onAction?(rec: ActionRecord): void;
  onOp?(op: string, node: ActionNode): void;
  /**
   * Recovery hook: called when a node cannot locate its target, finds it hidden, or is blocked by
   * a dialog (including one that is already open right after a navigation). Returns a repair
   * (applied, then the node is retried) or null to give up.
   */
  repair?(args: RepairArgs): Promise<RepairResult | null>;
  /** Called when a node succeeds through a learned override without needing a new repair. */
  onReuse?(info: ReuseInfo): void;
  /** Called before nodes that require approval; resolves true when approved. */
  approve?(node: ActionNode): Promise<boolean>;
}

export interface SegmentInput {
  taskId: string;
  /** Segment template id; recovery keys learned rules and repair dedupe on it. */
  segmentId?: string | undefined;
  app: string | undefined;
  nodes: ActionNode[];
  scope: RecordScope;
  allowedOrigins: Set<string>;
  /** Shared by every record of one segment template: a repair learned once applies everywhere. */
  locatorOverrides: Map<string, SemanticLocator>;
  defaultTimeoutMs?: number;
}

export interface WriteReceipt {
  nodeId: string;
  readBack: ReadBackResult;
  writeStatus: number | undefined;
}

export interface SegmentResult {
  outputs: Record<string, unknown>;
  receipts: WriteReceipt[];
  skipped: string[];
  actions: number;
  repairs: number;
  modelCalls: number;
  ms: number;
}

export class VerificationFailedError extends RuntimeError {
  constructor(
    message: string,
    nodeId: string,
    readonly readBack: ReadBackResult,
  ) {
    super(message, nodeId);
  }
}

const MAX_REPAIRS_PER_NODE = 3;
const MAX_LOAD_DIALOGS = 3;

export function preludeKey(nodeId: string, i: number): string {
  return `${nodeId}#prelude:${i}`;
}

function isWrite(node: ActionNode): boolean {
  return node.effect === "remote-write" || node.effect === "irreversible";
}

function isRepairable(err: unknown): err is RuntimeError {
  return err instanceof LocatorNotFoundError || err instanceof AmbiguousLocatorError || err instanceof UnexpectedDialogError || err instanceof HiddenTargetError;
}

/** A Playwright action timeout caused by a modal overlay (e.g. an inert page) becomes typed dialog interference. */
async function typedError(page: Page, node: ActionNode, err: unknown): Promise<unknown> {
  if (err instanceof Error && !(err instanceof RuntimeError) && err.name === "TimeoutError") {
    const text = await openDialogText(page);
    if (text) return new UnexpectedDialogError(`A dialog is blocking the page: ${text.slice(0, 120)}`, node.id, text);
  }
  return err;
}

/** Override keys learned on earlier records that apply to this node. */
function learnedKeys(overrides: Map<string, SemanticLocator>, node: ActionNode): string[] {
  const keys = [node.id, ...(node.fields ?? []).map((f) => `${node.id}#${f.name}`)].filter((k) => overrides.has(k));
  for (let i = 0; overrides.has(preludeKey(node.id, i)); i++) keys.push(preludeKey(node.id, i));
  return keys;
}

function clearPrelude(overrides: Map<string, SemanticLocator>, nodeId: string): void {
  for (let i = 0; overrides.has(preludeKey(nodeId, i)); i++) overrides.delete(preludeKey(nodeId, i));
}

async function clickControl(page: Page, loc: SemanticLocator, nodeId: string, timeoutMs: number): Promise<void> {
  const r = await resolveLocator(page, loc, { timeoutMs, nodeId });
  await r.locator.click({ timeout: 3000 });
}

/**
 * Execute one segment (a basic block on a single app page) on a worker.
 *
 * Fast path: deterministic Playwright actions, zero model calls. Locator failures, hidden
 * targets, and dialog interference go through the recovery hook; writes are always followed by a
 * fresh read-back. Typed errors propagate to the scheduler, which owns retry, reconciliation, and
 * invalidation.
 */
export async function runSegment(worker: BrowserWorker, input: SegmentInput, hooks: SegmentHooks = {}): Promise<SegmentResult> {
  const start = performance.now();
  const app = input.app ?? input.nodes.find((n) => n.app)?.app;
  const page = app ? await worker.pageFor(app) : worker.currentPage();
  if (!page) throw new RuntimeError("Segment has no app and the worker has no current page");
  const env: ActionEnv = {
    page,
    origin: app ? worker.originOf(app) : new URL(page.url()).origin,
    allowedOrigins: input.allowedOrigins,
    scope: input.scope,
    locatorOverrides: input.locatorOverrides,
    defaultTimeoutMs: input.defaultTimeoutMs ?? 10_000,
  };
  const overrides = input.locatorOverrides;
  const result: SegmentResult = { outputs: {}, receipts: [], skipped: [], actions: 0, repairs: 0, modelCalls: 0, ms: 0 };

  const fail = (node: ActionNode, modelCalls: number, err: unknown) =>
    hooks.onAction?.({ taskId: input.taskId, nodeId: node.id, actionType: node.type, ms: 0, ok: false, modelCalls, detail: (err as Error).message.slice(0, 200) });

  /** Replay learned read-only pre-clicks; a stale one (control gone) is forgotten. */
  const replayPrelude = async (node: ActionNode): Promise<boolean> => {
    if (!overrides.has(preludeKey(node.id, 0))) return false;
    for (let i = 0; ; i++) {
      const loc = overrides.get(preludeKey(node.id, i));
      if (!loc) return true;
      try {
        await clickControl(page, loc, node.id, 300);
      } catch {
        clearPrelude(overrides, node.id);
        return false;
      }
    }
  };

  /** Apply a repair. Returns the outcome when confirming a dialog completed the pending write. */
  const applyRepair = async (node: ActionNode, err: RuntimeError, repair: RepairResult): Promise<ActionOutcome | null> => {
    if (repair.locator) {
      const key = err.nodeId && err.nodeId !== node.id ? err.nodeId : node.id;
      overrides.set(key, repair.locator);
    }
    if (repair.prelude?.length) {
      for (const loc of repair.prelude) await clickControl(page, loc, node.id, 1500);
      clearPrelude(overrides, node.id);
      repair.prelude.forEach((loc, i) => overrides.set(preludeKey(node.id, i), loc));
    }
    if (repair.dismiss) {
      const d = await resolveLocator(page, repair.dismiss, { timeoutMs: 2000, nodeId: node.id });
      if (repair.confirmsWrite && isWrite(node) && err instanceof UnexpectedDialogError) {
        // The original submit already fired and opened a confirmation; confirming completes it.
        const confirmNode: ActionNode = { ...node, target: repair.dismiss, preconditions: [] };
        overrides.set(node.id + "#confirm", repair.dismiss);
        return executeAction({ ...env, locatorOverrides: new Map([[confirmNode.id, repair.dismiss]]) }, confirmNode);
      }
      await d.locator.click({ timeout: 3000 });
      await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    }
    return null;
  };

  /**
   * Dialogs that are already open when a page loads (announcements, cookie notices) make the page
   * inert: fills silently do nothing and clicks time out. Clear them before the next action.
   */
  const clearLoadDialogs = async (node: ActionNode): Promise<number> => {
    const repairHook = hooks.repair;
    if (!repairHook) return 0;
    let calls = 0;
    for (let i = 0; ; i++) {
      const text = await openDialogText(page);
      if (!text) return calls;
      const err = new UnexpectedDialogError(`A dialog is open after the page loaded: ${text.slice(0, 120)}`, node.id, text);
      if (i >= MAX_LOAD_DIALOGS) {
        fail(node, calls, err);
        throw err;
      }
      const repair = await repairHook({ node, env, error: err, attempt: i, taskId: input.taskId, segmentId: input.segmentId });
      if (repair) {
        result.repairs++;
        calls += repair.modelCalls;
        result.modelCalls += repair.modelCalls;
      }
      if (!repair || repair.confirmsWrite) {
        fail(node, calls, err);
        throw err;
      }
      // No dismiss control means the dialog already closed; the next round re-checks.
      if (repair.dismiss) {
        try {
          await clickControl(page, repair.dismiss, node.id, 2000);
        } catch {
          // Stale dismiss control: the next round re-asks recovery with a higher attempt number.
        }
        await page.waitForLoadState("domcontentloaded").catch(() => undefined);
      }
    }
  };

  for (const node of input.nodes) {
    if (hooks.signal?.aborted) throw new CancelledError("Cancelled", node.id);
    const scope = exprScope(input.scope);
    if (node.when && !evaluateBool(node.when, scope)) {
      input.scope.out[node.id] = null;
      result.skipped.push(node.id);
      continue;
    }
    if (node.requiresApproval) {
      const ok = hooks.approve ? await hooks.approve(node) : false;
      if (!ok) throw new ApprovalRequiredError(`Node ${node.id} requires approval`, node.id);
    }
    hooks.onOp?.(node.type, node);
    const learned = learnedKeys(overrides, node);
    if (!(await replayPrelude(node))) {
      const stale = learned.findIndex((k) => k.startsWith(node.id + "#prelude:"));
      if (stale >= 0) learned.splice(stale);
    }
    await checkPreconditions(env, node);

    let outcome: ActionOutcome | null = null;
    let modelCalls = 0;
    let nodeRepairs = 0;
    let pending: RuntimeError | null = null;
    for (let attempt = 0; ; attempt++) {
      let err: unknown;
      if (pending) {
        err = pending;
        pending = null;
      } else {
        try {
          outcome = await executeAction(env, node);
          break;
        } catch (e) {
          err = await typedError(page, node, e);
        }
      }
      if (!isRepairable(err) || !hooks.repair || attempt >= MAX_REPAIRS_PER_NODE) {
        fail(node, modelCalls, err);
        throw err;
      }
      const repair = await hooks.repair({ node, env, error: err, attempt, taskId: input.taskId, segmentId: input.segmentId });
      if (!repair) {
        fail(node, modelCalls, err);
        throw err;
      }
      nodeRepairs++;
      result.repairs++;
      modelCalls += repair.modelCalls;
      result.modelCalls += repair.modelCalls;
      try {
        const completed = await applyRepair(node, err, repair);
        if (completed) {
          outcome = completed;
          break;
        }
      } catch (applyErr) {
        // Write outcomes (uncertain, rejected) and other failures are never retried here.
        if (!isRepairable(applyErr)) throw applyErr;
        // Confirming raised another dialog: that one is the failure to repair next.
        if (applyErr instanceof UnexpectedDialogError) pending = applyErr;
        // Otherwise the repair could not be applied (stale rule). Ask again; if the dialog is still
        // open, re-raise it without re-running the node so a pending submit is not clicked twice.
        else pending = err instanceof UnexpectedDialogError && (await openDialogText(page)) ? err : null;
      }
    }
    if (node.type === "navigate") modelCalls += await clearLoadDialogs(node);
    await checkPostconditions(env, node);
    if (outcome.output !== undefined) {
      input.scope.out[node.id] = outcome.output;
      result.outputs[node.id] = outcome.output;
    }
    result.actions++;
    hooks.onAction?.({ taskId: input.taskId, nodeId: node.id, actionType: node.type, ms: outcome.ms, ok: true, modelCalls, locatorTier: outcome.locatorTier ?? undefined });
    if (learned.length && nodeRepairs === 0) hooks.onReuse?.({ taskId: input.taskId, segmentId: input.segmentId, nodeId: node.id, keys: learned });

    if (node.verify && isWrite(node)) {
      hooks.onOp?.("verify", node);
      const rb = await readBack(env, node.verify, { timeoutMs: node.timeoutMs });
      result.receipts.push({ nodeId: node.id, readBack: rb, writeStatus: outcome.writeStatus });
      hooks.onAction?.({ taskId: input.taskId, nodeId: node.id + ":verify", actionType: "verify", ms: rb.ms, ok: rb.ok, modelCalls: 0 });
      if (!rb.ok) {
        const diff = rb.fields.filter((f) => !f.ok).map((f) => `${f.name}: expected ${JSON.stringify(f.expected)} got ${JSON.stringify(f.actual)}`);
        throw new VerificationFailedError(`Read-back mismatch after ${node.id}: ${diff.join("; ")}`, node.id, rb);
      }
    }
  }
  result.ms = performance.now() - start;
  return result;
}
