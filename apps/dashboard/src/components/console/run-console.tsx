"use client";

import { useCallback, useState } from "react";
import { useRunStore } from "@/lib/hooks";
import { ApprovalsPanel } from "./approvals-panel";
import { ArtifactDrawer, InterferenceDrawer, ProgramDrawer } from "./drawers";
import { ExecutionGraph } from "./execution-graph";
import { FragmentsPanel } from "./fragments-panel";
import { PipelineTimeline } from "./pipeline-timeline";
import { RunHeader } from "./run-header";
import { StrategyPanel } from "./strategy-panel";
import { SwarmMap, type ArtifactRef } from "./swarm-map";
import { TaskHeatmap } from "./task-heatmap";
import { Telemetry } from "./telemetry";
import { WorkerWall } from "./worker-wall";

/**
 * Live view of one run. One RunStore feeds every panel; each panel subscribes to the slices of
 * the view it reads, so a burst of one event type only re-renders the panels that show it.
 */
export function RunConsole({ runId }: { runId: string }) {
  const store = useRunStore(runId);
  const [artifact, setArtifact] = useState<ArtifactRef | null>(null);
  const [interference, setInterference] = useState(false);
  const [program, setProgram] = useState(false);
  const closeArtifact = useCallback(() => setArtifact(null), []);
  const closeInterference = useCallback(() => setInterference(false), []);
  const closeProgram = useCallback(() => setProgram(false), []);

  if (!store) return <div className="rounded-lg border border-line bg-panel px-3 py-6 text-center text-xs text-dim">Connecting to run {runId}…</div>;

  return (
    <div className="flex flex-col gap-3" data-testid="run-console">
      <RunHeader store={store} onOpenInterference={() => setInterference(true)} />
      <PipelineTimeline store={store} />
      <div className="grid gap-3 xl:grid-cols-[minmax(300px,340px)_minmax(0,1fr)_minmax(300px,360px)]">
        <div className="order-3 flex min-w-0 flex-col gap-3 xl:order-1">
          <SwarmMap store={store} onOpenArtifact={setArtifact} />
          <StrategyPanel store={store} />
        </div>
        <div className="order-1 flex min-w-0 flex-col gap-3 xl:order-2">
          <ExecutionGraph store={store} onOpenProgram={() => setProgram(true)} />
          <FragmentsPanel store={store} />
          <TaskHeatmap store={store} />
        </div>
        <div className="order-2 flex min-w-0 flex-col gap-3 xl:order-3">
          <ApprovalsPanel store={store} />
          <WorkerWall store={store} />
        </div>
      </div>
      <Telemetry store={store} />
      <ArtifactDrawer runId={runId} artifact={artifact} onClose={closeArtifact} />
      <InterferenceDrawer open={interference} onClose={closeInterference} />
      <ProgramDrawer runId={runId} open={program} onClose={closeProgram} />
    </div>
  );
}
