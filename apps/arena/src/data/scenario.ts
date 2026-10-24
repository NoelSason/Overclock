import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { CheckResult, PublicScenario, ScenarioRequest, TaskTemplateId } from "@overclock/contracts";
import type { HoldoutApp } from "../holdout/meta";
import { emptyHoldout } from "../holdout/model";
import { applyHoldoutEdit, isHoldoutEntityKind, type HoldoutEntityKind } from "../holdout/task";
import type { ClassicApp } from "./apps";
import { appendEntries, check, entityMap } from "./checker";
import { generate } from "./generate";
import { cloneDataset, type Dataset } from "./model";
import { expectedOutcome, TEMPLATES, type EntityKey } from "./rules";
import type { ArenaStore } from "./store";

export interface ScenarioState {
  scenarioId: string;
  template: TaskTemplateId;
  seed: number;
  records: number;
  recordKeys: string[];
  /** Snapshot the scenario starts from; judge edits to unprocessed records are applied here too. */
  base: Dataset;
  /** Pristine generated dataset (reset restores this and discards judge edits). */
  initial?: Dataset;
  createdAt: number;
  judgeEdits: { at: number; entity: string; patch: Record<string, unknown> }[];
}

/** App name -> origin. The holdout app's origin is optional so older callers keep working. */
export type AppOrigins = Record<ClassicApp, string> & Partial<Record<HoldoutApp, string>>;

export type JudgeEntity = "order" | "ticket" | "customer" | HoldoutEntityKind;

/** Holdout seeds (>= 9000) and the holdout template are never used while developing prompts. */
export const HOLDOUT_SEED_MIN = 9000;

export class ScenarioManager {
  private state: ScenarioState | null = null;

  constructor(
    private readonly store: ArenaStore,
    private readonly origins: AppOrigins,
    private readonly dataDir: string,
  ) {
    mkdirSync(dataDir, { recursive: true });
    const saved = join(dataDir, "scenario.json");
    if (existsSync(saved)) {
      try {
        const state = JSON.parse(readFileSync(saved, "utf8")) as ScenarioState;
        // Snapshots saved before the fourth app existed have no holdout tables.
        state.base.holdout ??= emptyHoldout();
        if (state.initial) state.initial.holdout ??= emptyHoldout();
        this.state = state;
      } catch {
        this.state = null;
      }
    }
  }

  get current(): ScenarioState | null {
    return this.state;
  }

  private persist(): void {
    if (this.state) writeFileSync(join(this.dataDir, "scenario.json"), JSON.stringify(this.state));
  }

  load(req: ScenarioRequest): PublicScenario {
    const { dataset, recordKeys } = generate(req.template, req.seed, req.records);
    this.state = {
      scenarioId: `${req.template}-s${req.seed}-n${req.records}`,
      template: req.template,
      seed: req.seed,
      records: req.records,
      recordKeys,
      base: cloneDataset(dataset),
      initial: cloneDataset(dataset),
      createdAt: Date.now(),
      judgeEdits: [],
    };
    this.store.load(dataset);
    this.persist();
    return this.publicScenario()!;
  }

  /** Restore the starting snapshot (every benchmark mode starts from identical state). */
  reset(): PublicScenario | null {
    if (!this.state) return null;
    if (this.state.initial) this.state.base = cloneDataset(this.state.initial);
    this.state.judgeEdits = [];
    this.store.load(cloneDataset(this.state.base));
    this.persist();
    return this.publicScenario();
  }

  publicScenario(): PublicScenario | null {
    const s = this.state;
    if (!s) return null;
    const t = TEMPLATES[s.template];
    const appOrigin = (name: string) => this.origins[name as keyof AppOrigins] ?? "";
    return {
      scenarioId: s.scenarioId,
      seed: s.seed,
      template: s.template,
      title: t.title,
      goal: t.goal(s.recordKeys.length),
      records: s.recordKeys.map((k) => ({ [t.recordField]: k })),
      applications: t.apps.map((name) => ({ name, origin: appOrigin(name) })),
      holdout: t.holdout || s.seed >= HOLDOUT_SEED_MIN,
    };
  }

  check(): CheckResult | null {
    const s = this.state;
    if (!s) return null;
    return check(s.scenarioId, s.base, this.store.dump(), expectedOutcome(s.template, s.base, s.recordKeys));
  }

  /** Records whose entities have not been written since the scenario started. */
  untouchedRecords(): string[] {
    const s = this.state;
    if (!s) return [];
    const exp = expectedOutcome(s.template, s.base, s.recordKeys);
    const cur = this.store.dump();
    const versionOf = (d: Dataset) => new Map([...entityMap(d)].map(([k, v]) => [k, v.version]));
    const version = versionOf(cur);
    const baseVersion = versionOf(s.base);
    const baseAppends = new Set(appendEntries(s.base).map((a) => a.id));
    const appended = new Set<EntityKey>(appendEntries(cur).filter((a) => !baseAppends.has(a.id)).map((a) => a.key));
    return exp.records.filter((r) => r.entities.every((e) => version.get(e.key) === baseVersion.get(e.key) && !appended.has(e.key))).map((r) => r.recordKey);
  }

  /**
   * Judge interference: change source data of a record that has not been processed yet. The
   * change is applied to the live database and to the base snapshot, so the oracle's expected
   * outcome follows the new data (a correct agent must notice the change before writing).
   */
  editRecord(entity: JudgeEntity, id: string, patch: Record<string, string | number>): boolean {
    const s = this.state;
    if (!s) return false;
    let ok = false;
    if (isHoldoutEntityKind(entity)) {
      ok = applyHoldoutEdit(this.store.holdout, s.base.holdout, entity, id, patch);
    } else if (entity === "order") {
      ok = !!this.store.orders.update(id, patch);
      const b = s.base.orders.find((o) => o.id === id);
      if (b) Object.assign(b, patch, { version: b.version + 1 });
    } else if (entity === "ticket") {
      ok = !!this.store.support.update(id, patch);
      const b = s.base.tickets.find((t) => t.id === id);
      if (b) Object.assign(b, patch, { version: b.version + 1 });
    } else {
      ok = !!this.store.crm.update(id, patch);
      const b = s.base.customers.find((c) => c.id === id);
      if (b) Object.assign(b, patch, { version: b.version + 1 });
    }
    s.judgeEdits.push({ at: Date.now(), entity: `${entity}:${id}`, patch });
    this.persist();
    return ok;
  }

  /** Expected outcome summary for the judge console (counts only; never exposed to the agent). */
  expectationSummary(): { records: number; needChange: number; escalations: number; notes: number } | null {
    const s = this.state;
    if (!s) return null;
    const exp = expectedOutcome(s.template, s.base, s.recordKeys);
    return {
      records: exp.records.length,
      needChange: exp.records.filter((r) => r.needsChange).length,
      escalations: exp.records.filter((r) => r.escalated).length,
      notes: exp.records.reduce((n, r) => n + r.notes.length + (r.appends?.length ?? 0), 0),
    };
  }
}
