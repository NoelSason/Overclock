import type { ActionNode, SemanticLocator } from "@overclock/contracts";
import { evaluateBool } from "@overclock/compiler";
import { checkPostconditions, checkPreconditions, executeAction, exprScope, type ActionEnv, type ActionOutcome, type RecordScope } from "./actions";
import { AmbiguousLocatorError, ApprovalRequiredError, CancelledError, LocatorNotFoundError, RuntimeError, UnexpectedDialogError } from "./errors";
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
  level: number;
  modelCalls: number;
  detail: string;
}

export interface SegmentHooks {
  signal?: AbortSignal | undefined;
  onAction?(rec: ActionRecord): void;
  onOp?(op: string, node: ActionNode): void;
  /**
   * Recovery hook: called when a node cannot locate its target or is blocked by a dialog.
   * Returns a repair (applied, then the node is retried) or null to give up.
   */
  repair?(args: { node: ActionNode; env: ActionEnv; error: RuntimeError; attempt: number }): Promise<RepairResult | null>;
  /** Called before nodes that require approval; resolves true when approved. */
  approve?(node: ActionNode): Promise<boolean>;
}

export interface SegmentInput {
  taskId: string;
  app: string | undefined;
  nodes: ActionNode[];
  scope: RecordScope;
  allowedOrigins: Set<string>;
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

const MAX_REPAIRS_PER_NODE = 2;

function isWrite(node: ActionNode): boolean {
  return node.effect === "remote-write" || node.effect === "irreversible";
}

/**
 * Execute one segment (a basic block on a single app page) on a worker.
 *
 * Fast path: deterministic Playwright actions, zero model calls. Locator failures and dialog
 * interference go through the recovery hook; writes are always followed by a fresh read-back.
 * Typed errors propagate to the scheduler, which owns retry, reconciliation, and invalidation.
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
  const result: SegmentResult = { outputs: {}, receipts: [], skipped: [], actions: 0, repairs: 0, modelCalls: 0, ms: 0 };

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
    await checkPreconditions(env, node);

    let outcome: ActionOutcome | null = null;
    let modelCalls = 0;
    for (let attempt = 0; ; attempt++) {
      try {
        outcome = await executeAction(env, node);
        break;
      } catch (err) {
        const repairable = err instanceof LocatorNotFoundError || err instanceof AmbiguousLocatorError || err instanceof UnexpectedDialogError;
        if (!repairable || !hooks.repair || attempt >= MAX_REPAIRS_PER_NODE) {
          hooks.onAction?.({ taskId: input.taskId, nodeId: node.id, actionType: node.type, ms: 0, ok: false, modelCalls, detail: (err as Error).message.slice(0, 200) });
          throw err;
        }
        const repair = await hooks.repair({ node, env, error: err, attempt });
        if (!repair) throw err;
        result.repairs++;
        modelCalls += repair.modelCalls;
        result.modelCalls += repair.modelCalls;
        if (repair.locator) {
          const key = err.nodeId && err.nodeId !== node.id ? err.nodeId : node.id;
          input.locatorOverrides.set(key, repair.locator);
        }
        if (repair.dismiss) {
          const d = await resolveLocator(page, repair.dismiss, { timeoutMs: 2000, nodeId: node.id });
          if (repair.confirmsWrite && isWrite(node) && err instanceof UnexpectedDialogError) {
            // The original submit already fired and opened a confirmation; confirming completes it.
            const confirmNode: ActionNode = { ...node, target: repair.dismiss, preconditions: [] };
            input.locatorOverrides.set(node.id + "#confirm", repair.dismiss);
            outcome = await executeAction({ ...env, locatorOverrides: new Map([[confirmNode.id, repair.dismiss]]) }, confirmNode);
            break;
          }
          await d.locator.click({ timeout: 3000 });
          await page.waitForLoadState("domcontentloaded").catch(() => undefined);
        }
      }
    }
    await checkPostconditions(env, node);
    if (outcome.output !== undefined) {
      input.scope.out[node.id] = outcome.output;
      result.outputs[node.id] = outcome.output;
    }
    result.actions++;
    hooks.onAction?.({ taskId: input.taskId, nodeId: node.id, actionType: node.type, ms: outcome.ms, ok: true, modelCalls, locatorTier: outcome.locatorTier ?? undefined });

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
