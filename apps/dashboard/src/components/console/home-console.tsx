"use client";

import { engine, errorMessage } from "@/lib/api";
import { ENGINE_URL } from "@/lib/config";
import { usePolling } from "@/lib/hooks";
import { Button } from "../ui/primitives";
import { CommandBar } from "./command-bar";
import { RunConsole } from "./run-console";

/** `/`: the most recently created run, or an empty state with the new-run form open. */
export function HomeConsole() {
  const { data, error, loading, reload } = usePolling((signal) => engine.listRuns(signal), 5000, []);
  const latest = data && data.length ? [...data].sort((a, b) => b.createdAt - a.createdAt)[0] : undefined;

  return (
    <div className="flex flex-col gap-3">
      {/* Mount the form once the first load settles so it opens by default only when there is no run. */}
      {!loading && <CommandBar defaultOpen={!latest} />}
      {latest ? (
        <RunConsole key={latest.runId} runId={latest.runId} />
      ) : loading ? (
        <div className="rounded-lg border border-line bg-panel px-3 py-8 text-center text-xs text-dim">Looking for runs…</div>
      ) : error && !data ? (
        <div className="rounded-lg border border-bad/40 bg-panel px-4 py-8 text-center">
          <p className="text-sm text-fg">The engine is not reachable.</p>
          <p className="mt-1 font-mono text-xs text-muted">
            {ENGINE_URL}: {errorMessage(error)}
          </p>
          <Button className="mt-3" size="sm" onClick={reload}>
            Retry
          </Button>
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-line bg-panel px-4 py-10 text-center">
          <p className="text-sm text-fg">No runs yet.</p>
          <p className="mt-1 text-xs text-muted">Load an arena scenario or describe a task above, then start a run. Discovery, compilation, and execution will stream in here.</p>
        </div>
      )}
    </div>
  );
}
