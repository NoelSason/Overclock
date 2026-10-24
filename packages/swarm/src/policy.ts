import type { AppModel, RunConfig } from "@overclock/contracts";

export interface PolicyDecision {
  intelligence: "single-planner" | "parallel-scout" | "warm-cache" | "network-import";
  candidates: number;
  catalog: boolean;
  critique: boolean;
  dryRun: boolean;
  reason: string;
  features: Record<string, number | string | boolean>;
}

/**
 * Adaptive intelligence budget. Discovery costs wall time (scout catalogs, extra candidates,
 * critique, dry runs) and it only pays off when the task is large enough for a better plan to
 * save more than that overhead. Small or single-app tasks get one planner; tasks with
 * structurally different strategies available get competing candidates.
 */
export function decidePolicy(config: RunConfig, models: AppModel[], directives: number, cacheHit: boolean): PolicyDecision {
  const n = config.records.length;
  const tables = models.reduce((s, m) => s + m.features.listTables.filter((t) => t.paginated).length, 0);
  const features = { records: n, apps: models.length, paginatedTables: tables, strategyDirectives: directives, cacheHit, requested: config.intelligence };
  const competitive = config.ablation.competitiveSynthesis !== false;
  const probes = config.ablation.dryRunProbes !== false;
  if (cacheHit && config.cache === "warm") return { intelligence: "warm-cache", candidates: 0, catalog: false, critique: false, dryRun: false, reason: "warm start: app fingerprints match a previously compiled program for this task", features };
  // Modes B and C are defined as one planner with no discovery swarm.
  if (config.mode === "compiled-single" || config.mode === "compiled-parallel") return { intelligence: "single-planner", candidates: 1, catalog: false, critique: false, dryRun: false, reason: `${config.mode}: one planner, no discovery swarm (mode definition)`, features };
  if (config.intelligence === "single-planner") return { intelligence: "single-planner", candidates: 1, catalog: false, critique: false, dryRun: false, reason: "single-planner mode requested", features };
  if (config.intelligence === "parallel-scout") {
    const k = competitive ? Math.min(3, directives) : 1;
    return { intelligence: "parallel-scout", candidates: k, catalog: true, critique: true, dryRun: probes, reason: `parallel-scout mode requested: ${k} competing candidate(s)`, features };
  }
  // adaptive
  if (n <= 5) return { intelligence: "single-planner", candidates: 1, catalog: false, critique: false, dryRun: probes, reason: `small task (${n} records): competing candidates cost more planning time than they can save; one planner plus a dry-run probe`, features };
  if (!competitive || directives <= 1) return { intelligence: "parallel-scout", candidates: 1, catalog: models.length > 1, critique: true, dryRun: probes, reason: directives <= 1 ? "only one structurally different strategy is available for these apps; verify and probe a single candidate" : "competitive synthesis disabled (ablation)", features };
  const k = Math.min(3, directives);
  return { intelligence: "parallel-scout", candidates: k, catalog: models.length > 1, critique: true, dryRun: probes, reason: `${n} records across ${models.length} app(s) with ${tables} paginated list(s): ${k} structurally different strategies can change the page-load count by an order of magnitude, so compete them`, features };
}
