import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DslPlan, DslStep, normalizeModelOutput, normalizeModelPlan, type AppModel } from "@overclock/contracts";
import { defaultEstimator, hasErrors, IncrementalCompiler } from "@overclock/compiler";
import { PlanStreamWatcher } from "../../packages/discovery/src/stream";

/**
 * Regression: replay a recorded live planner stream (fixture) through the stream watcher and the
 * incremental compiler, in small chunks, exactly as the streaming pipeline consumes it.
 */
const fixture = JSON.parse(readFileSync(new URL("../fixtures/streams/t1-per-record.json", import.meta.url), "utf8")) as { text: string; models: AppModel[] };

describe("streamed plan replay (recorded live stream)", () => {
  it("releases every step of every phase, with writes only in complete write fragments", () => {
    const apps = fixture.models.map((m) => ({ name: m.app, origin: m.origin }));
    const ic = new IncrementalCompiler({ models: fixture.models, apps, goal: "g", inputs: { records: [{ orderId: "ORD-50064" }] }, programId: "p", strategyId: "s", estimate: defaultEstimator });
    const ids: string[] = [];
    const errors: string[] = [];
    const releaseTimes: { stepsSeen: number; segment: string; write: boolean }[] = [];
    let stepsSeen = 0;
    const w = new PlanStreamWatcher({
      onPhaseHeader: (i, h) => {
        const info = ic.addPhase(h);
        if (info) ids[i] = info.id;
      },
      onStep: (pi, _si, raw) => {
        stepsSeen++;
        const r = ic.addStep(ids[pi]!, normalizeModelOutput(DslStep, raw));
        for (const i of r.issues) if (i.severity === "error") errors.push(i.message);
        for (const x of r.released) releaseTimes.push({ stepsSeen, segment: x.segment.id, write: x.write });
      },
      onPhaseEnd: (pi) => {
        const r = ic.sealPhase(ids[pi]!);
        for (const i of r.issues) if (i.severity === "error") errors.push(i.message);
        for (const x of r.released) releaseTimes.push({ stepsSeen, segment: x.segment.id, write: x.write });
      },
      onError: (e) => errors.push(e.message),
    });
    for (let i = 0; i < fixture.text.length; i += 23) w.push(fixture.text.slice(i, i + 23));
    expect(errors).toEqual([]);
    const plan = normalizeModelPlan(JSON.parse(fixture.text));
    for (const p of plan.phases) expect(ic.unreleasedSteps(p.id)).toEqual([]);
    // The first read fragment is released after only a few steps of a ~40-step plan.
    expect(releaseTimes[0]!.stepsSeen).toBeLessThanOrEqual(4);
    expect(releaseTimes.some((r) => r.write)).toBe(true);
    expect(hasErrors(ic.finalize(DslPlan.parse(plan)))).toBe(false);
  });
});
