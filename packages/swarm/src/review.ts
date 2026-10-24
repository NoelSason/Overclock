import type { DslPlan, EventPayload } from "@overclock/contracts";
import type { CritiqueResult } from "@overclock/discovery";

/**
 * The review a plan passed before any of its writes could run. Stored with cached and published
 * plans, so a later run that reuses one knows whether it was reviewed.
 */
export type PlanReview = { status: "passed"; rounds: number } | { status: "not-required"; reason: string };

/** One assessment of one plan: the adversarial critique, plus any other check the caller runs with it (dry run). */
export interface Assessment {
  /** False when a check the policy requires could not run (critique unavailable after its retry). */
  available: boolean;
  /** Findings that block writes: high-severity risks, failed dry-run probes. */
  problems: string[];
  critique?: CritiqueResult | undefined;
}

export type ReviewOutcome<C> =
  | { ok: true; plan: DslPlan; compiled: C; critique: CritiqueResult | undefined; rounds: number; repaired: boolean }
  | { ok: false; reason: string; rounds: number };

/**
 * The write gate for a plan whose policy requires adversarial review. The plan passes only when an
 * assessment of that exact plan finds no blocking problem. Problems get a repair round, and the
 * repaired plan is assessed again from scratch. Fail-closed: an assessment that could not run, a
 * repair that fails or doesn't compile, or problems left after the last allowed repair reject the
 * plan, and the caller must not run any of its writes. Every round and the verdict are emitted as
 * `review` events, so the reason is visible in the run.
 */
export async function reviewPlan<C>(args: {
  subject: string;
  plan: DslPlan;
  compiled: C;
  assess: (plan: DslPlan, compiled: C) => Promise<Assessment>;
  repair: (plan: DslPlan, problems: string[]) => Promise<{ plan: DslPlan; compiled: C }>;
  maxRepairs: number;
  emit: (e: EventPayload) => void;
  now: () => number;
}): Promise<ReviewOutcome<C>> {
  let plan = args.plan;
  let compiled = args.compiled;
  const reject = (round: number, reason: string): ReviewOutcome<C> => {
    args.emit({ type: "review", subject: args.subject, round, status: "rejected", highRisks: 0, reason });
    args.emit({ type: "log", level: "error", message: `review rejected ${args.subject}: ${reason}; none of its writes run` });
    return { ok: false, reason, rounds: round };
  };
  for (let round = 1; ; round++) {
    const t0 = args.now();
    let a: Assessment;
    try {
      a = await args.assess(plan, compiled);
    } catch (err) {
      a = { available: false, problems: [`assessment failed: ${(err as Error).message}`] };
    }
    const ms = Math.round(args.now() - t0);
    if (!a.available) {
      args.emit({ type: "review", subject: args.subject, round, status: "unavailable", highRisks: 0, ms, reason: a.problems[0] ?? "critique unavailable after a retry" });
      return reject(round, "critique unavailable after a retry");
    }
    if (a.problems.length === 0) {
      args.emit({ type: "review", subject: args.subject, round, status: "passed", highRisks: 0, ms });
      return { ok: true, plan, compiled, critique: a.critique, rounds: round, repaired: round > 1 };
    }
    args.emit({ type: "review", subject: args.subject, round, status: "risks", highRisks: a.problems.length, ms, reason: a.problems.slice(0, 2).join("; ").slice(0, 300) });
    if (round > args.maxRepairs) return reject(round, `${a.problems.length} blocking finding(s) remain after ${args.maxRepairs} repair round(s): ${a.problems.slice(0, 2).join("; ").slice(0, 300)}`);
    try {
      ({ plan, compiled } = await args.repair(plan, a.problems));
    } catch (err) {
      return reject(round, `repair failed: ${(err as Error).message.slice(0, 300)}`);
    }
  }
}

/** A plan failed its required review; none of its writes ran. */
export class ReviewRejectedError extends Error {
  constructor(readonly reason: string) {
    super(`review rejected the plan; no write ran: ${reason}`);
  }
}

/** Blocking findings in a critique: every high-severity risk (unimplemented rules are high). */
export function blockingRisks(critique: CritiqueResult): string[] {
  return critique.risks.filter((r) => r.severity === "high").map((r) => `[verifier] step ${r.stepId}: ${r.issue} — ${r.suggestion}`);
}
