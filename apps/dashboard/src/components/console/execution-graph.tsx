"use client";

import type { FragmentState, SegmentTemplate, TaskState } from "@overclock/contracts";
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import { memo, useMemo } from "react";
import { FRAGMENT_STYLE, runningSegments, segmentFragmentStates } from "@/lib/derive";
import { fmtInt, fmtMs } from "@/lib/format";
import { NODE_H, NODE_W, edgeKey, programGraph } from "@/lib/graph";
import { useSlicesThrottled } from "@/lib/hooks";
import type { RunStore } from "@/lib/run-store";
import { CATEGORY, CATEGORY_ORDER, TASK_CATEGORY, type StateCategory } from "@/lib/states";
import { Button, Empty, Panel, cx } from "../ui/primitives";

interface SegmentData extends Record<string, unknown> {
  segment: SegmentTemplate;
  counts: Partial<Record<TaskState, number>>;
  fragment?: { state: FragmentState; reason?: string | undefined } | undefined;
  critical: boolean;
  workers: number;
}
interface PhaseData extends Record<string, unknown> {
  label: string;
  kind: string;
  segments: number;
}

type SegmentNodeType = Node<SegmentData, "segment">;
type PhaseNodeType = Node<PhaseData, "phase">;

function categoryCounts(counts: Partial<Record<TaskState, number>>): [StateCategory, number][] {
  const by = new Map<StateCategory, number>();
  for (const [state, n] of Object.entries(counts) as [TaskState, number][]) by.set(TASK_CATEGORY[state], (by.get(TASK_CATEGORY[state]) ?? 0) + n);
  return CATEGORY_ORDER.filter((c) => by.has(c)).map((c) => [c, by.get(c)!]);
}

const SegmentNode = memo(function SegmentNode({ data }: NodeProps<SegmentNodeType>) {
  const { segment, counts, fragment, critical, workers } = data;
  const cats = categoryCounts(counts);
  const total = cats.reduce((s, [, n]) => s + n, 0);
  const frag = fragment ? FRAGMENT_STYLE[fragment.state] : null;
  return (
    <div
      data-testid={`segment-${segment.id}`}
      className={cx("flex h-full flex-col rounded-md border bg-panel px-2.5 py-2 text-left transition-[border-color,box-shadow] duration-300", critical && "shadow-[0_0_0_1px_#3d8bff,0_0_16px_-4px_#3d8bff]")}
      style={{ width: NODE_W, height: NODE_H, borderColor: frag?.color ?? (critical ? "#3d8bff" : "#2a3440"), borderStyle: frag?.dashed ? "dashed" : "solid", borderWidth: frag ? 1.5 : 1 }}
      title={`${segment.label}${fragment ? `\nfragment: ${fragment.state}${fragment.reason ? ` (${fragment.reason})` : ""}` : ""}\nestimated ${fmtMs(segment.estimatedMs)}`}
    >
      <Handle type="target" position={Position.Left} />
      <div className="flex items-center gap-1.5 text-[10px] font-medium tracking-wide uppercase">
        <span className={cx(segment.kind === "write" ? "text-warn" : segment.kind === "compute" ? "text-violet" : "text-accent-soft")}>{segment.kind}</span>
        <span className="truncate text-muted">{segment.app ?? "compute"}</span>
        {critical && <span className="text-accent-soft">critical</span>}
        {frag && (
          <span className="ml-auto rounded px-1 normal-case" style={{ color: frag.color, background: `${frag.color}1f` }}>
            {frag.label}
          </span>
        )}
      </div>
      <div className="mt-1 line-clamp-2 text-[11.5px] leading-4 text-fg">{segment.label}</div>
      <div className="mt-auto">
        <div className="flex h-1.5 overflow-hidden rounded-sm bg-sunken" aria-hidden>
          {cats.map(([c, n]) => (
            <span key={c} style={{ width: `${(n / Math.max(1, total)) * 100}%`, background: CATEGORY[c].color }} className="transition-[width] duration-300" />
          ))}
        </div>
        <div className="tnum mt-1 flex gap-2 font-mono text-[10.5px]">
          {cats.length === 0 ? (
            <span className="text-dim">no tasks</span>
          ) : (
            cats.slice(0, 4).map(([c, n]) => (
              <span key={c} style={{ color: CATEGORY[c].color }} title={CATEGORY[c].label}>
                {fmtInt(n)}
              </span>
            ))
          )}
          {workers > 0 && <span className="ml-auto text-accent-soft">{workers}w</span>}
        </div>
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
});

const PhaseNode = memo(function PhaseNode({ data }: NodeProps<PhaseNodeType>) {
  return (
    <div className="h-full w-full rounded-lg border border-line bg-white/[0.015]">
      <div className="flex items-center gap-2 px-3 pt-2 text-[10.5px] tracking-wide text-muted uppercase">
        <span className="font-semibold text-fg normal-case">{data.label}</span>
        <span>{data.kind}</span>
        <span className="text-dim">{data.segments} seg</span>
      </div>
    </div>
  );
});

const nodeTypes = { segment: SegmentNode, phase: PhaseNode };

/** Template-level execution graph: phases as groups, segments with live per-state task counts. */
export function ExecutionGraph({ store, onOpenProgram }: { store: RunStore; onOpenProgram: () => void }) {
  const version = useSlicesThrottled(store, ["program", "tasks", "fragments", "workers"], 200);
  const program = store.view.program;
  const graph = program ? programGraph(program) : null;

  const edges = useMemo<Edge[]>(() => {
    if (!graph) return [];
    return graph.edges.map((e) => {
      const crit = graph.critical.edgeKeys.has(edgeKey(e.from, e.to));
      return {
        id: edgeKey(e.from, e.to),
        source: e.from,
        target: e.to,
        type: "smoothstep",
        style: { stroke: crit ? "#3d8bff" : "#3a4554", strokeWidth: crit ? 2 : 1.25, strokeDasharray: e.implicit ? "4 4" : undefined },
        markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: crit ? "#3d8bff" : "#3a4554" },
      };
    });
  }, [graph]);

  const nodes = useMemo<(SegmentNodeType | PhaseNodeType)[]>(() => {
    if (!graph) return [];
    const view = store.view;
    const fragments = segmentFragmentStates(view);
    const running = runningSegments(view);
    const phaseNodes: PhaseNodeType[] = graph.layout.phases.map((b) => ({
      id: `phase:${b.phase.id}`,
      type: "phase",
      position: { x: b.x, y: b.y },
      width: b.width,
      height: b.height,
      data: { label: b.phase.id, kind: b.phase.kind, segments: b.phase.segmentIds.length },
      draggable: false,
      selectable: false,
    }));
    const segNodes: SegmentNodeType[] = graph.layout.segments.map((p) => ({
      id: p.segment.id,
      type: "segment",
      parentId: `phase:${p.segment.phaseId}`,
      extent: "parent",
      position: { x: p.x, y: p.y },
      width: NODE_W,
      height: NODE_H,
      draggable: false,
      data: {
        segment: p.segment,
        counts: { ...(view.segmentCounts[p.segment.id] ?? {}) },
        fragment: fragments.get(p.segment.id),
        critical: graph.critical.segmentIds.has(p.segment.id),
        workers: running.get(p.segment.id) ?? 0,
      },
    }));
    return [...phaseNodes, ...segNodes];
    // `version` is the change signal: the view is mutated in place.
  }, [graph, store, version]);

  const passes = program?.passes ?? [];
  return (
    <Panel
      id="graph"
      title="Execution graph"
      subtitle={program ? `${program.segments.length} segments · ${program.nodeCount} IR nodes · compiled in ${fmtMs(program.compileMs)}${program.patches ? ` · ${program.patches} patches` : ""}` : undefined}
      actions={
        program ? (
          <>
            {graph && graph.critical.totalMs > 0 && (
              <span className="text-[11px] text-muted">
                critical path <span className="tnum font-mono text-accent-soft">{fmtMs(graph.critical.totalMs)}</span> est.
              </span>
            )}
            <Button size="sm" variant="ghost" onClick={onOpenProgram} aria-haspopup="dialog">
              View IR
            </Button>
          </>
        ) : null
      }
      bodyClassName="p-0"
    >
      {!program ? (
        <div className="p-3">
          <Empty className="h-[200px]">The execution graph appears once the strategy is compiled.</Empty>
        </div>
      ) : (
        <>
          <div className="w-full" style={{ height: 440 }}>
            <ReactFlow
              key={program.programId}
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              colorMode="dark"
              fitView
              fitViewOptions={{ padding: 0.06 }}
              minZoom={0.2}
              maxZoom={1.6}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable={false}
              zoomOnScroll={false}
              panOnScroll
              proOptions={{ hideAttribution: false }}
            >
              <Background gap={24} size={1} color="#161c23" />
              <Controls showInteractive={false} position="bottom-right" />
            </ReactFlow>
          </div>
          <Legend />
          {passes.length > 0 && <Passes passes={passes} />}
        </>
      )}
    </Panel>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-3 py-2 text-[11px] text-muted">
      {CATEGORY_ORDER.map((c) => (
        <span key={c} className="inline-flex items-center gap-1">
          <span aria-hidden className="h-2 w-2 rounded-sm" style={{ background: CATEGORY[c].color }} />
          {CATEGORY[c].label}
        </span>
      ))}
      <span className="mx-1 h-3 w-px bg-line" aria-hidden />
      {(["released", "canary", "deferred", "validated", "rejected"] as FragmentState[]).map((f) => (
        <span key={f} className="inline-flex items-center gap-1">
          <span aria-hidden className="h-2.5 w-3.5 rounded-sm border-[1.5px]" style={{ borderColor: FRAGMENT_STYLE[f].color, borderStyle: FRAGMENT_STYLE[f].dashed ? "dashed" : "solid" }} />
          {f}
        </span>
      ))}
      <span className="inline-flex items-center gap-1">
        <span aria-hidden className="h-0.5 w-4 bg-accent" />
        critical path
      </span>
    </div>
  );
}

function Passes({ passes }: { passes: { name: string; ms: number; changes: number; detail: string }[] }) {
  return (
    <details className="border-t border-line px-3 py-2">
      <summary className="cursor-pointer text-[11px] font-medium text-muted hover:text-fg">Compiler passes ({passes.length})</summary>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="text-[11px] text-muted">
            <tr>
              <th scope="col" className="py-1 pr-3 font-medium">
                Pass
              </th>
              <th scope="col" className="py-1 pr-3 text-right font-medium">
                Time
              </th>
              <th scope="col" className="py-1 pr-3 text-right font-medium">
                Changes
              </th>
              <th scope="col" className="py-1 font-medium">
                Detail
              </th>
            </tr>
          </thead>
          <tbody>
            {passes.map((p) => (
              <tr key={p.name} className="border-t border-line align-top">
                <td className="py-1 pr-3 font-mono text-fg">{p.name}</td>
                <td className="tnum py-1 pr-3 text-right font-mono text-muted">{fmtMs(p.ms)}</td>
                <td className="tnum py-1 pr-3 text-right font-mono text-fg">{fmtInt(p.changes)}</td>
                <td className="py-1 text-muted">{p.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
