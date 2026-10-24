"use client";

import type { CheckResult } from "@overclock/contracts";
import { useState } from "react";
import { arena, errorMessage } from "@/lib/api";
import { fmtDate, fmtInt, fmtPct } from "@/lib/format";
import { Button, Panel, Stat } from "../ui/primitives";

/** Calls the arena's independent checker. Its numbers come from arena ground truth, not the engine. */
export function GroundTruth() {
  const [result, setResult] = useState<CheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const check = async () => {
    setBusy(true);
    setError(null);
    try {
      setResult(await arena.check());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      id="ground-truth"
      title="Independent checker"
      subtitle="arena ground truth, not engine-reported"
      actions={
        <Button size="sm" onClick={() => void check()} disabled={busy}>
          {busy ? "Checking…" : "Check ground truth"}
        </Button>
      }
    >
      {error && (
        <p role="alert" className="text-xs text-bad">
          Checker: {error}
        </p>
      )}
      {!result && !error && <p className="text-xs text-dim">Compares every record in the arena against its expected end state, including writes the task never asked for.</p>}
      {result && (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Accuracy" testId="check-accuracy" raw={result.accuracy} value={fmtPct(result.accuracy, 1)} sub={`${fmtInt(result.correctRecords)} / ${fmtInt(result.totalRecords)} records`} tone={result.accuracy >= 1 ? "ok" : result.accuracy >= 0.95 ? "warn" : "bad"} />
            <Stat label="Mismatches" raw={result.mismatches.length} value={fmtInt(result.mismatches.length)} tone={result.mismatches.length ? "bad" : "ok"} />
            <Stat label="Duplicate writes" raw={result.duplicateWrites} value={fmtInt(result.duplicateWrites)} tone={result.duplicateWrites ? "bad" : "ok"} />
            <Stat label="Collateral writes" raw={result.collateralWrites} value={fmtInt(result.collateralWrites)} tone={result.collateralWrites ? "bad" : "ok"} />
          </div>
          <div className="text-[11px] text-dim">
            Scenario {result.scenarioId} · {fmtInt(result.escalationExpected)} records expected escalation · checked {fmtDate(result.checkedAt)}
          </div>
          {result.mismatches.length > 0 && (
            <div className="max-h-[180px] overflow-auto rounded border border-line">
              <table className="w-full text-left text-[11px]">
                <thead className="sticky top-0 bg-raised text-muted">
                  <tr>
                    <th scope="col" className="px-2 py-1 font-medium">Record</th>
                    <th scope="col" className="px-2 py-1 font-medium">Field</th>
                    <th scope="col" className="px-2 py-1 font-medium">Expected</th>
                    <th scope="col" className="px-2 py-1 font-medium">Actual</th>
                  </tr>
                </thead>
                <tbody>
                  {result.mismatches.slice(0, 200).map((mm, i) => (
                    <tr key={i} className="border-t border-line font-mono">
                      <td className="px-2 py-1 text-fg">{mm.recordKey}</td>
                      <td className="px-2 py-1 text-muted">
                        {mm.entity}.{mm.field}
                      </td>
                      <td className="px-2 py-1 text-ok">{JSON.stringify(mm.expected)}</td>
                      <td className="px-2 py-1 text-bad">{JSON.stringify(mm.actual)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Panel>
  );
}
