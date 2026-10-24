import { describe, expect, it } from "vitest";
import type { DslPlan, EventPayload } from "@overclock/contracts";
import { reviewPlan, type Assessment } from "@overclock/swarm";

/** The review gate's verdicts, independent of any model or pipeline. */

const plan = (name: string): DslPlan => ({ strategy: { name, summary: "", rationale: "" }, phases: [], outcomes: [], assumptions: [], risks: [] });

async function review(assessments: (Assessment | Error)[], repair: (p: DslPlan) => DslPlan | Error = (p) => plan(`${p.strategy.name}+fixed`)) {
  const events: EventPayload[] = [];
  const assessed: string[] = [];
  const out = await reviewPlan({
    subject: "s",
    plan: plan("p"),
    compiled: "compiled:p",
    assess: async (p) => {
      assessed.push(p.strategy.name);
      const a = assessments.shift()!;
      if (a instanceof Error) throw a;
      return a;
    },
    repair: async (p) => {
      const r = repair(p);
      if (r instanceof Error) throw r;
      return { plan: r, compiled: `compiled:${r.strategy.name}` };
    },
    maxRepairs: 1,
    emit: (e) => events.push(e),
    now: () => 0,
  });
  return { out, events, assessed };
}

const statuses = (events: EventPayload[]) => events.flatMap((e) => (e.type === "review" ? [e.status] : []));

describe("reviewPlan", () => {
  it("passes a plan with no blocking finding without repairing it", async () => {
    const { out, events } = await review([{ available: true, problems: [] }]);
    expect(out).toMatchObject({ ok: true, rounds: 1, repaired: false, compiled: "compiled:p" });
    expect(statuses(events)).toEqual(["passed"]);
  });

  it("assesses the repaired plan itself, and passes it only when that assessment is clean", async () => {
    const { out, assessed } = await review([{ available: true, problems: ["high"] }, { available: true, problems: [] }]);
    expect(assessed).toEqual(["p", "p+fixed"]);
    expect(out).toMatchObject({ ok: true, rounds: 2, repaired: true, compiled: "compiled:p+fixed" });
  });

  it("rejects when the assessment can't run, or throws", async () => {
    expect((await review([{ available: false, problems: [] }])).out.ok).toBe(false);
    const thrown = await review([new Error("boom")]);
    expect(thrown.out.ok).toBe(false);
    expect(statuses(thrown.events)).toEqual(["unavailable", "rejected"]);
  });

  it("rejects when findings remain after the allowed repairs, or the repair fails", async () => {
    const remain = await review([{ available: true, problems: ["high"] }, { available: true, problems: ["high"] }]);
    expect(remain.out).toMatchObject({ ok: false, rounds: 2 });
    expect(statuses(remain.events)).toEqual(["risks", "risks", "rejected"]);
    const failed = await review([{ available: true, problems: ["high"] }], () => new Error("no compile"));
    expect(failed.out.ok).toBe(false);
    expect(failed.out.ok === false && failed.out.reason).toMatch(/repair failed: no compile/);
  });
});
