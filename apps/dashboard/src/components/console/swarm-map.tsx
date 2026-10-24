"use client";

import type { AgentRole, AgentView, ArtifactSummary, RunView } from "@overclock/contracts";
import { fmtMs } from "@/lib/format";
import { useSlicesThrottled } from "@/lib/hooks";
import type { RunStore } from "@/lib/run-store";
import { Badge, Empty, Panel, cx, type Tone } from "../ui/primitives";

const ROLE: Record<AgentRole, { label: string; order: number }> = {
  "ui-scout": { label: "UI Scout", order: 0 },
  "workflow-scout": { label: "Workflow Scout", order: 1 },
  "dependency-scout": { label: "Dependency Scout", order: 2 },
  "optimization-scout": { label: "Optimization Scout", order: 3 },
  "adversarial-verifier": { label: "Adversarial Verifier", order: 4 },
  planner: { label: "Planner", order: 5 },
  repair: { label: "Repair", order: 6 },
};

const STATUS_TONE: Record<AgentView["status"], Tone> = { running: "accent", done: "ok", failed: "bad" };
const RECENT_PAGES = 4;

export interface ArtifactRef {
  agentId: string;
  agentLabel: string;
  artifact: ArtifactSummary;
}

/** Discovery swarm: intelligence policy, then one card per agent with live scout pages and artifacts. */
export function SwarmMap({ store, onOpenArtifact }: { store: RunStore; onOpenArtifact: (a: ArtifactRef) => void }) {
  // Agent elapsed times advance with any event, so follow the whole stream at a modest rate.
  useSlicesThrottled(store, ["swarm", "stages", "tasks", "workers", "telemetry"], 250);
  const view = store.view;
  const agents = Object.values(view.agents).sort((a, b) => ROLE[a.role].order - ROLE[b.role].order || a.startedT - b.startedT);
  const pagesByAgent = groupPages(view);
  const routesByApp = discoveredRoutes(view);

  return (
    <Panel id="swarm" title="Discovery swarm" subtitle={agents.length ? `${agents.length} agents` : undefined} bodyClassName="flex flex-col gap-3 p-3">
      <PolicyBlock view={view} />
      {routesByApp.length > 0 && (
        <div aria-label="Discovered routes per app" className="flex flex-wrap gap-1.5">
          {routesByApp.map(([app, n]) => (
            <span key={app} className="inline-flex items-center gap-1.5 rounded border border-line bg-raised px-1.5 py-0.5 text-[11px]">
              <span className="text-muted">{app}</span>
              <span data-testid={`routes-${app}`} className="tnum font-mono text-fg">
                {n}
              </span>
              <span className="text-dim">routes</span>
            </span>
          ))}
        </div>
      )}
      {agents.length === 0 ? (
        <Empty>No agents have started.</Empty>
      ) : (
        <ul className="flex flex-col gap-2">
          {agents.map((a) => (
            <AgentCard key={a.id} agent={a} lastT={view.lastT} pages={pagesByAgent.get(a.id)} onOpenArtifact={onOpenArtifact} />
          ))}
        </ul>
      )}
    </Panel>
  );
}

function groupPages(view: RunView): Map<string, { pages: RunView["scoutPages"]; total: number }> {
  const out = new Map<string, { pages: RunView["scoutPages"]; total: number }>();
  for (const p of view.scoutPages) {
    const g = out.get(p.agentId) ?? { pages: [], total: 0 };
    g.pages.push(p);
    g.total++;
    out.set(p.agentId, g);
  }
  return out;
}

function discoveredRoutes(view: RunView): [string, number][] {
  const byApp = new Map<string, Set<string>>();
  for (const p of view.scoutPages) {
    const set = byApp.get(p.app) ?? new Set<string>();
    set.add(p.routePattern);
    byApp.set(p.app, set);
  }
  return [...byApp].map(([app, s]) => [app, s.size] as [string, number]).sort((a, b) => a[0].localeCompare(b[0]));
}

function PolicyBlock({ view }: { view: RunView }) {
  const p = view.policy;
  if (!p) return <div className="text-xs text-dim">Intelligence policy: not decided yet.</div>;
  const features = Object.entries(p.features);
  return (
    <div className="rounded-md border border-line bg-raised/60 p-2.5">
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-muted">Intelligence</span>
        <Badge tone="accent">{p.intelligence}</Badge>
        <span className="text-[11px] text-dim">{p.candidates} candidate{p.candidates === 1 ? "" : "s"}</span>
      </div>
      <p className="mt-1.5 text-xs text-fg">{p.reason}</p>
      {features.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {features.map(([k, val]) => (
            <span key={k} className="rounded bg-sunken px-1.5 py-px font-mono text-[10.5px] text-muted">
              {k}=<span className="text-fg">{String(val)}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function AgentCard({ agent, lastT, pages, onOpenArtifact }: { agent: AgentView; lastT: number; pages: { pages: RunView["scoutPages"]; total: number } | undefined; onOpenArtifact: (a: ArtifactRef) => void }) {
  const elapsed = agent.ms ?? (agent.endedT ?? lastT) - agent.startedT;
  const recent = pages ? pages.pages.slice(-RECENT_PAGES).reverse() : [];
  return (
    <li className={cx("rounded-md border bg-sunken/60 p-2.5", agent.status === "running" ? "border-accent/35" : agent.status === "failed" ? "border-bad/40" : "border-line")}>
      <div className="flex items-center gap-2">
        <span className="text-[10.5px] font-semibold tracking-wide text-muted uppercase">{ROLE[agent.role].label}</span>
        {agent.app && <Badge>{agent.app}</Badge>}
        <Badge tone={STATUS_TONE[agent.status]} className="ml-auto">
          {agent.status}
        </Badge>
      </div>
      <div className="mt-1 truncate text-[13px] text-fg" title={agent.label}>
        {agent.label}
      </div>
      <div className="mt-0.5 flex gap-2 text-[11px] text-dim">
        {agent.model && <span className="truncate font-mono">{agent.model}</span>}
        <span className="tnum ml-auto font-mono">{fmtMs(elapsed)}</span>
      </div>
      {agent.error && <p className="mt-1 text-[11px] text-bad">{agent.error}</p>}
      {pages && (
        <div className="mt-2">
          <div className="mb-1 text-[10.5px] text-dim">
            {pages.total} page{pages.total === 1 ? "" : "s"} observed
          </div>
          <ul aria-label={`${agent.label} recent pages`} className="flex flex-col gap-px overflow-hidden rounded border border-line">
            {recent.map((p) => (
              <li key={`${p.t}:${p.url}`} className={cx("grid grid-cols-[minmax(0,1fr)_auto_auto] gap-2 bg-panel px-1.5 py-0.5 font-mono text-[10.5px]", lastT - p.t < 2000 && "motion-safe:animate-[flash_1.2s_ease-out]")} title={p.url}>
                <span className="truncate text-fg">{p.routePattern}</span>
                <span className="tnum text-muted">{fmtMs(p.loadMs)}</span>
                <span className="tnum text-dim">{p.controls} ctl</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {agent.artifacts.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1">
          {agent.artifacts.map((art) => (
            <li key={art.artifactId}>
              <button type="button" onClick={() => onOpenArtifact({ agentId: agent.id, agentLabel: agent.label, artifact: art })} className="group w-full rounded border border-line bg-panel px-2 py-1.5 text-left hover:border-accent/50">
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-dim uppercase">{art.kind}</span>
                  <span className="truncate text-xs text-fg group-hover:text-accent-soft">{art.title}</span>
                </div>
                <p className="mt-0.5 line-clamp-2 text-[11px] text-muted">{art.summary}</p>
                {art.stats && (
                  <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5">
                    {Object.entries(art.stats).map(([k, val]) => (
                      <span key={k} className="font-mono text-[10.5px] text-dim">
                        {k} <span className="text-fg">{String(val)}</span>
                      </span>
                    ))}
                  </div>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
