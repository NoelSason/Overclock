/**
 * Per-run timing breakdown for the planner-speed comparison. Reads benchmark result files and the
 * run events from the engine that executed each run. Usage: tsx speed-analyze.ts <engineUrl>=<result.json> ...
 */
import { readFileSync } from "node:fs";

type Ev = { type: string; t: number; [k: string]: unknown };
const rows: Record<string, unknown>[] = [];
for (const arg of process.argv.slice(2)) {
  const [engine, file] = arg.split("=") as [string, string];
  const res = JSON.parse(readFileSync(file, "utf8")) as { runs: Record<string, any>[] };
  for (const r of res.runs) {
    const events: Ev[] = [];
    for (let after = 0; ; ) {
      const page = (await (await fetch(`${engine}/api/runs/${r.runId}/events?after=${after}&limit=1000`)).json()) as { events: (Ev & { seq: number })[]; nextSeq: number };
      events.push(...page.events);
      if (!page.events.length || page.nextSeq === after) break;
      after = page.nextSeq;
    }
    const calls = events.filter((e) => e.type === "model.call");
    const byPurpose = (re: RegExp) => calls.filter((c) => re.test(String(c.purpose)));
    const tps = (c: Ev) => (typeof c.ttftMs === "number" && (c.ms as number) > (c.ttftMs as number) ? (c.outputTokens as number) / (((c.ms as number) - (c.ttftMs as number)) / 1000) : null);
    const plannerCalls = byPurpose(/^planner/);
    const stage = (name: string) => r.summary?.stageMs?.[name] ?? null;
    const logs = events.filter((e) => e.type === "log").map((e) => String(e.message));
    rows.push({
      engine: engine.replace("http://127.0.0.1:", ":"),
      runId: r.runId,
      correct: r.check ? `${r.check.correctRecords}/${r.check.totalRecords}` : "?",
      wallS: +(r.wallMs / 1000).toFixed(1),
      firstVerifiedS: r.firstVerifiedMs != null ? +(r.firstVerifiedMs / 1000).toFixed(1) : null,
      planningS: stage("planning") != null ? +(stage("planning") / 1000).toFixed(1) : null,
      critiqueS: stage("critique") != null ? +(stage("critique") / 1000).toFixed(1) : null,
      cost: +r.costUsd.toFixed(3),
      calls: r.modelCalls,
      tokens: r.inputTokens + r.outputTokens,
      dup: r.duplicateWrites,
      collateral: r.collateralWrites,
      verifiedButWrong: r.verifiedButWrong,
      model: plannerCalls.map((c) => `${c.purpose}[${c.speed ?? "?"}] ${(Number(c.ms) / 1000).toFixed(1)}s ttft=${c.ttftMs != null ? (Number(c.ttftMs) / 1000).toFixed(1) : "-"}s out=${c.outputTokens} ${tps(c)?.toFixed(0) ?? "-"}tok/s${c.ok ? "" : " FAILED " + String(c.error).slice(0, 80)}`).join(" | "),
      critique: byPurpose(/critique/).map((c) => `${c.purpose} ${(Number(c.ms) / 1000).toFixed(1)}s out=${c.outputTokens}${c.ok ? "" : " FAILED"}`).join(" | "),
      fallbacks: logs.filter((m) => /streaming fallback|fast mode unavailable|critique unavailable/.test(m)).map((m) => m.slice(0, 140)),
      repairs: logs.filter((m) => /edit\(s\) to the streamed plan|full re-plan/.test(m)).map((m) => m.slice(0, 120)),
    });
  }
}
console.log(JSON.stringify(rows, null, 2));
