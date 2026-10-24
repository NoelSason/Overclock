"use client";

import type { EngineHealth } from "@overclock/contracts";
import { createContext, useContext, type ReactNode } from "react";
import { engine, errorMessage } from "@/lib/api";
import { ENGINE_URL } from "@/lib/config";
import { usePolling } from "@/lib/hooks";
import { Dot, cx } from "./ui/primitives";

interface HealthState {
  health: EngineHealth | null;
  /** Set when the engine could not be reached on the last poll. */
  error: string | null;
  loading: boolean;
}

const HealthContext = createContext<HealthState>({ health: null, error: null, loading: true });

export function HealthProvider({ children }: { children: ReactNode }) {
  const { data, error, loading } = usePolling((signal) => engine.health(signal), 10_000, []);
  return <HealthContext value={{ health: data, error: error ? errorMessage(error) : null, loading }}>{children}</HealthContext>;
}

export const useHealth = () => useContext(HealthContext);

function Capability({ name, available, detail, reason }: { name: string; available: boolean | undefined; detail?: string | undefined; reason?: string | undefined }) {
  const label = available === undefined ? "unknown" : available ? "available" : "unavailable";
  return (
    <span title={[`${name}: ${label}`, detail, !available ? reason : undefined].filter(Boolean).join(" · ")} className={cx("inline-flex items-center gap-1.5 rounded border border-line px-1.5 py-0.5 text-[11px]", available ? "text-muted" : "text-dim")}>
      <Dot color={available === undefined ? "#4a5566" : available ? "#2fd27a" : "#f0524f"} />
      <span className={cx(!available && available !== undefined && "line-through decoration-dim")}>{name}</span>
    </span>
  );
}

/** Engine reachability and model/browser availability, shown in the top bar. */
export function HealthStrip() {
  const { health, error, loading } = useHealth();
  if (loading && !health) return <span className="text-[11px] text-dim">Checking engine…</span>;
  if (error && !health)
    return (
      <span className="inline-flex items-center gap-1.5 text-[11px] text-bad" title={`${ENGINE_URL}: ${error}`}>
        <Dot color="#f0524f" /> Engine offline
      </span>
    );
  const c = health?.capabilities;
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="health-strip">
      <span className={cx("inline-flex items-center gap-1.5 text-[11px]", error ? "text-warn" : "text-muted")} title={error ? `Last check failed: ${error}` : ENGINE_URL}>
        <Dot color={error ? "#f2b13c" : "#2fd27a"} /> Engine {health?.version ?? ""}
      </span>
      <Capability name="Claude" available={c?.anthropic.available} detail={c ? `planner ${c.anthropic.plannerModel}, helper ${c.anthropic.helperModel}` : undefined} reason={c?.anthropic.reason} />
      <Capability name="Jev" available={c?.typesafe.available} detail={c ? `${c.typesafe.model}, vision ${c.typesafe.visionModel}` : undefined} reason={c?.typesafe.reason} />
      <Capability name="Browser" available={c?.browser.available} reason={c?.browser.reason} />
    </div>
  );
}
