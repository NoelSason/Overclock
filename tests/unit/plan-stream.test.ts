import { describe, expect, it } from "vitest";
import { PlanStreamWatcher } from "../../packages/discovery/src/stream";

const plan = {
  strategy: { name: "s", summary: "with \"quotes\" and {braces} [brackets]", rationale: "r" },
  phases: [
    { id: "p1", kind: "foreach", over: "$input.records", key: "$rec.id", dependsOn: [], steps: [{ id: "a", op: "goto", app: "X", url: "/x/{$rec.id}" }, { id: "b", op: "extract", fields: [{ name: "f", control: "c", parse: "string" }] }] },
    { id: "p2", kind: "once", dependsOn: ["p1"], steps: [{ id: "c", op: "compute", assign: [{ name: "n", expr: "len($phase.p1)" }] }] },
  ],
  outcomes: [],
  assumptions: [],
  risks: [],
};

function run(text: string, chunk: number) {
  const events: string[] = [];
  const w = new PlanStreamWatcher({
    onPhaseHeader: (i, h) => events.push(`header ${i} ${h.id} ${JSON.stringify(h.dependsOn)}`),
    onStep: (p, s, step) => events.push(`step ${p}.${s} ${step.id}`),
    onPhaseEnd: (i, ph) => events.push(`end ${i} ${(ph.steps as unknown[]).length}`),
  });
  for (let i = 0; i < text.length; i += chunk) w.push(text.slice(i, i + chunk));
  return events;
}

describe("plan stream watcher", () => {
  it("reports headers, steps, and phase ends in stream order regardless of chunking", () => {
    const text = JSON.stringify(plan, null, 2);
    const expected = ["header 0 p1 []", "step 0.0 a", "step 0.1 b", "end 0 2", 'header 1 p2 ["p1"]', "step 1.0 c", "end 1 1"];
    for (const chunk of [1, 3, 7, 64, 10_000]) expect(run(text, chunk)).toEqual(expected);
  });

  it("tolerates leading prose and reports headers at phase end when steps come first", () => {
    const odd = { phases: [{ steps: [{ id: "a", op: "goto", app: "X", url: "/" }], id: "p1", kind: "once", dependsOn: [] }] };
    const ev = run("Here is the plan:\n" + JSON.stringify(odd), 5);
    expect(ev).toEqual(["step 0.0 a", "header 0 p1 []", "end 0 1"]);
  });
});
