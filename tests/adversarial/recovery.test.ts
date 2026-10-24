import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { z } from "zod";
import { AmbiguousLocatorError, BrowserManager, BrowserWorker, LocatorNotFoundError, runSegment, UnexpectedDialogError, type RecordScope, type SegmentResult } from "@overclock/browser-runtime";
import type { ActionNode, AppControl, SemanticLocator } from "@overclock/contracts";
import { ClaudeProvider, claudeConfigFromEnv, JevProvider, jevConfigFromEnv, ModelLedger, type ParseRequest, type ParseResult } from "@overclock/models";
import { RecoveryEngine, type DeepModel, type RecoveryDeps, type RecoveryEvent, type RepairPlan } from "@overclock/recovery";
import { loadEnv } from "@overclock/telemetry";
import { startMiniVariantApp, type MiniVariantApp, type MiniVariants } from "../fixtures/mini-app-variants";
import { loc, node } from "../fixtures/ir";

let app: MiniVariantApp;
let browser: BrowserManager;

beforeAll(async () => {
  app = await startMiniVariantApp();
  browser = new BrowserManager({ headless: true });
});
afterAll(async () => {
  await browser.close();
  await app.close();
});

const SEGMENT = "seg-edit";
const cid = (id: string) => `mini.items_id_edit.${id}`;
const withId = (l: SemanticLocator, controlId: string): SemanticLocator => ({ ...l, controlId });

/**
 * Hand-written IR (test-only), shaped like compiler output: ranked semantic locators carrying the
 * app-model control id. `positional` swaps the field locators for structural CSS paths, as a
 * recorded script would have, so that reordering the form breaks them.
 */
function editSegment(opts: { positional?: boolean } = {}): ActionNode[] {
  const status = opts.positional ? loc({ kind: "css", selector: "#edit-form .form-grid > div:nth-of-type(1) > select" }) : loc({ kind: "label", text: "Status", exact: true });
  const note = opts.positional ? loc({ kind: "css", selector: "#edit-form .form-grid > div:nth-of-type(2) > input" }) : loc({ kind: "label", text: "Add note", exact: true });
  return [
    node({ id: "open_edit", type: "navigate", app: "mini", url: { template: "/items/{$rec.id}/edit" } }),
    node({ id: "set_status", type: "select", app: "mini", effect: "local-write", target: withId(status, cid("status")), input: { expr: "$rec.status" } }),
    node({ id: "add_note", type: "fill", app: "mini", effect: "local-write", target: withId(note, cid("add_note")), input: { template: "Reconciled {$rec.id}" } }),
    node({
      id: "save",
      type: "click",
      app: "mini",
      effect: "remote-write",
      retryPolicy: "verify-before-retry",
      target: withId(loc({ kind: "role", role: "button", name: "Save", exact: true }), cid("save_button")),
      verify: {
        url: { template: "/items/{$rec.id}" },
        fields: [
          { name: "status", target: loc({ kind: "testId", id: "status" }), equals: { expr: "$rec.status" }, attr: "text" },
          { name: "notes", target: loc({ kind: "testId", id: "notes" }), equals: { template: "Reconciled {$rec.id}" }, attr: "text" },
        ],
      },
    }),
  ];
}

interface Harness {
  engine: RecoveryEngine;
  events: RecoveryEvent[];
  overrides: Map<string, SemanticLocator>;
}

function harness(deps: Partial<RecoveryDeps> = {}): Harness {
  const events: RecoveryEvent[] = [];
  return { engine: new RecoveryEngine({ emit: (e) => events.push(e), ...deps }), events, overrides: new Map() };
}

const workers: BrowserWorker[] = [];
async function newWorker(id = "w"): Promise<BrowserWorker> {
  const ctx = await browser.newContext({ allowedOrigins: [app.origin] });
  const w = new BrowserWorker(id, ctx, new Map([["mini", app.origin]]), () => undefined);
  workers.push(w);
  return w;
}
afterAll(async () => {
  for (const w of workers) await w.close();
});

function scope(rec: Record<string, unknown>): RecordScope {
  return { key: String(rec.id), rec, input: {}, out: {}, phase: {} };
}

function runRecord(h: Harness, w: BrowserWorker, rec: { id: string; status: string }, nodes: ActionNode[] = editSegment()): Promise<SegmentResult> {
  return runSegment(w, { taskId: `t-${rec.id}`, segmentId: SEGMENT, app: "mini", nodes, scope: scope(rec), allowedOrigins: new Set([app.origin]), locatorOverrides: h.overrides }, h.engine.hooks());
}

function timeline(events: RecoveryEvent[]): string {
  return events.map((e) => `  L${e.level} ${e.phase.padEnd(9)} ${e.ms !== undefined ? `${e.ms.toFixed(1).padStart(7)} ms` : "          "}${e.propagatedTo !== undefined ? ` (propagatedTo ${e.propagatedTo})` : ""}  ${e.reason}`).join("\n");
}

interface VariantCase {
  name: string;
  variants: MiniVariants;
  positional?: boolean;
  /** The announcement is per browser context, so record 2 needs a fresh context to see it again. */
  freshWorker?: boolean;
}

const RECOVERABLE: VariantCase[] = [
  { name: "renamed save button", variants: { saveLabel: "Update record" } },
  { name: "reordered fields (positional locators)", variants: { reorderFields: true }, positional: true },
  { name: "confirmation modal after submit", variants: { confirmModal: true } },
  { name: "announcement modal on first view", variants: { announcement: true }, freshWorker: true },
  { name: "status field in a hidden tab", variants: { statusInTab: true } },
  { name: "renamed field label (Status -> Ticket state)", variants: { statusLabel: "Ticket state" } },
  { name: "every surprise at once", variants: { saveLabel: "Apply changes", confirmModal: true, announcement: true, statusInTab: true, statusLabel: "Ticket state" }, freshWorker: true },
];

describe("localized recovery without network (L0/L1)", () => {
  for (const c of RECOVERABLE) {
    it(`recovers from: ${c.name}; record 2 reuses the repair with zero observations`, async () => {
      app.reset();
      app.setVariants(c.variants);
      const h = harness();
      const nodes = editSegment({ positional: c.positional });
      const w1 = await newWorker();

      const t1 = performance.now();
      const r1 = await runRecord(h, w1, { id: "I-2", status: "closed" }, nodes);
      const ms1 = performance.now() - t1;
      expect(r1.receipts).toHaveLength(1);
      expect(r1.receipts[0]!.readBack.ok).toBe(true);
      expect(app.items.get("I-2")).toMatchObject({ status: "closed", notes: ["Reconciled I-2"] });
      expect(r1.repairs).toBeGreaterThan(0);
      expect(r1.modelCalls).toBe(0);
      const s1 = h.engine.stats();
      expect(s1.escalations).toBe(0);
      expect(s1.modelCalls).toBe(0);
      expect(h.events.filter((e) => e.phase === "succeeded").every((e) => e.level <= 1)).toBe(true);
      const firstRecordEvents = h.events.length;

      const w2 = c.freshWorker ? await newWorker() : w1;
      const t2 = performance.now();
      const r2 = await runRecord(h, w2, { id: "I-4", status: "archived" }, nodes);
      const ms2 = performance.now() - t2;
      expect(r2.receipts[0]!.readBack.ok).toBe(true);
      expect(app.items.get("I-4")).toMatchObject({ status: "archived", notes: ["Reconciled I-4"] });
      const s2 = h.engine.stats();
      // Repair once, apply everywhere: no new observation, no new L1 attempt, no model call.
      expect(s2.observations).toBe(s1.observations);
      expect(s2.byLevel[1]!.attempts).toBe(s1.byLevel[1]!.attempts);
      expect(s2.modelCalls).toBe(0);
      expect(s2.propagated).toBeGreaterThan(s1.propagated);
      expect(h.events.slice(firstRecordEvents).every((e) => e.level === 0)).toBe(true);
      expect(app.writes).toBe(2);

      console.log(
        `[recovery] ${c.name}: record 1 ${ms1.toFixed(0)} ms (${r1.repairs} repair(s), ${s1.observations} observation(s)), record 2 ${ms2.toFixed(0)} ms (${r2.repairs} hook repair(s), propagated ${s2.propagated})\n${timeline(h.events)}`,
      );
    });
  }

  it("uses the app model (field name) to break a tie that labels alone cannot", async () => {
    app.reset();
    app.setVariants({ ambiguousStatus: true });
    const info: AppControl = {
      id: cid("status"),
      app: "mini",
      page: "/items/:id/edit",
      role: "combobox",
      name: "Status",
      label: "Status",
      param: "status",
      kind: "select",
      options: [
        { value: "open", label: "Open" },
        { value: "closed", label: "Closed" },
        { value: "archived", label: "Archived" },
      ],
      locator: withId(loc({ kind: "label", text: "Status", exact: true }), cid("status")),
    };
    const h = harness({ lookupControl: (id) => (id === info.id ? info : undefined) });
    const r = await runRecord(h, await newWorker(), { id: "I-3", status: "archived" });
    expect(r.receipts[0]!.readBack.ok).toBe(true);
    expect(app.items.get("I-3")).toMatchObject({ status: "archived", reopenStatus: "open" });
    expect(h.engine.stats().byLevel[1]!.successes).toBe(1);
    console.log(`[recovery] ambiguous status with app-model field name:\n${timeline(h.events)}`);
  });
});

describe("recovery refuses to guess", () => {
  it("escalates a pair of identical save buttons in two forms", async () => {
    app.reset();
    app.setVariants({ duplicateSave: true });
    const h = harness();
    const err = await runRecord(h, await newWorker(), { id: "I-2", status: "closed" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AmbiguousLocatorError);
    expect(app.writes).toBe(0);
    expect(app.items.get("I-2")!.notes).toEqual([]);
    const esc = h.events.filter((e) => e.phase === "escalated");
    expect(esc).toHaveLength(1);
    expect(esc[0]!.level).toBe(4);
    expect(esc[0]!.reason).toMatch(/ambiguous/i);
    console.log(`[recovery] identical buttons:\n${timeline(h.events)}`);
  });

  it("escalates a dialog whose only action is Delete, and never clicks it", async () => {
    app.reset();
    app.setVariants({ deleteOnlyDialog: true });
    const h = harness();
    const err = await runRecord(h, await newWorker(), { id: "I-2", status: "closed" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnexpectedDialogError);
    expect(app.deletes).toBe(0);
    expect(app.writes).toBe(0);
    expect(app.items.has("I-2")).toBe(true);
    const esc = h.events.filter((e) => e.phase === "escalated");
    expect(esc).toHaveLength(1);
    expect(esc[0]!.reason).toMatch(/irreversible|cannot be undone/i);
    console.log(`[recovery] delete-only dialog:\n${timeline(h.events)}`);
  });

  it("escalates two equally plausible status fields when no model is available", async () => {
    app.reset();
    app.setVariants({ ambiguousStatus: true });
    const h = harness();
    const err = await runRecord(h, await newWorker(), { id: "I-2", status: "closed" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LocatorNotFoundError);
    expect(app.writes).toBe(0);
    expect(h.events.at(-1)).toMatchObject({ phase: "escalated", level: 4 });
    expect(h.events.at(-1)!.reason).toMatch(/no repair model/i);
  });
});

function stubClaude(answer: (user: string) => Promise<RepairPlan>): DeepModel & { calls: number } {
  const s = {
    available: true,
    calls: 0,
    async parse<T extends z.ZodType>(req: ParseRequest<T>): Promise<ParseResult<z.infer<T>>> {
      s.calls++;
      const data = await answer(req.user);
      return { data: data as z.infer<T>, ms: 1, inputTokens: 0, outputTokens: 0, costUsd: 0, model: "stub" };
    },
  };
  return s;
}

/** Stub planner: picks the observation id of the "Current state" dropdown from the prompt. */
const pickCurrentState = async (user: string): Promise<RepairPlan> => {
  await new Promise((r) => setTimeout(r, 800));
  const id = /^\s+(c\d+) combobox label="Current state"/m.exec(user)?.[1];
  return id ? { kind: "repair", controlId: id, preludeClicks: [], rationale: "the record's current status" } : { kind: "impossible", reason: "no status field" };
};

describe("concurrent repairs", () => {
  it("dedupes two workers hitting the same broken locator into one model-assisted repair, with suspension callbacks", async () => {
    app.reset();
    app.setVariants({ ambiguousStatus: true });
    const starts: string[] = [];
    const ends: string[] = [];
    const claude = stubClaude(pickCurrentState);
    const h = harness({ claude, onRepairStart: (k) => starts.push(k), onRepairEnd: (k) => ends.push(k) });
    const [wa, wb] = await Promise.all([newWorker("wa"), newWorker("wb")]);
    const [ra, rb] = await Promise.all([runRecord(h, wa, { id: "I-5", status: "closed" }), runRecord(h, wb, { id: "I-7", status: "archived" })]);
    expect(ra.receipts[0]!.readBack.ok).toBe(true);
    expect(rb.receipts[0]!.readBack.ok).toBe(true);
    expect(app.items.get("I-5")).toMatchObject({ status: "closed", reopenStatus: "open" });
    expect(app.items.get("I-7")).toMatchObject({ status: "archived", reopenStatus: "open" });
    expect(claude.calls).toBe(1);
    expect(ra.modelCalls + rb.modelCalls).toBe(1);
    const s = h.engine.stats();
    expect(s.deduped).toBe(1);
    expect(s.modelCalls).toBe(1);
    expect(s.observations).toBe(1);
    expect(s.byLevel[3]!.successes).toBe(1);
    expect(starts).toEqual([SEGMENT]);
    expect(ends).toEqual([SEGMENT]);

    // A third record on the same template uses the override: no hook call, no model call.
    const rc = await runRecord(h, wa, { id: "I-8", status: "closed" });
    expect(rc.repairs).toBe(0);
    expect(h.engine.stats().modelCalls).toBe(1);
    console.log(`[recovery] concurrent dedupe:\n${timeline(h.events)}`);
  });

  it("calls onRepairEnd even when the model-assisted repair fails", async () => {
    app.reset();
    app.setVariants({ ambiguousStatus: true });
    const starts: string[] = [];
    const ends: string[] = [];
    const claude = stubClaude(async () => ({ kind: "repair", controlId: "c999", preludeClicks: [], rationale: "invented" }));
    const h = harness({ claude, onRepairStart: (k) => starts.push(k), onRepairEnd: (k) => ends.push(k) });
    const err = await runRecord(h, await newWorker(), { id: "I-2", status: "closed" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LocatorNotFoundError);
    expect(starts).toEqual([SEGMENT]);
    expect(ends).toEqual([SEGMENT]);
    expect(h.events.some((e) => e.level === 3 && e.phase === "failed" && /not in the observation/.test(e.reason))).toBe(true);
    expect(app.writes).toBe(0);
  });
});

const LIVE = process.env.OVERCLOCK_LIVE === "1";

describe.skipIf(!LIVE)("live model tiers (OVERCLOCK_LIVE=1)", () => {
  let ledger: ModelLedger;
  beforeAll(() => {
    loadEnv();
    // Hard cap for every live call in this file.
    ledger = new ModelLedger(0.5);
  });
  afterAll(() => {
    const t = ledger.totals();
    console.log(`[recovery live] ${t.calls} model call(s), $${t.costUsd.toFixed(4)}, ${t.failures} failure(s)`);
    for (const c of ledger.calls) console.log(`  ${c.provider} ${c.model} ${c.purpose} ${c.ms.toFixed(0)} ms in=${c.inputTokens} out=${c.outputTokens} $${c.costUsd.toFixed(4)} ${c.ok ? "ok" : c.error}`);
  });

  async function liveCase(label: string, deps: Partial<RecoveryDeps>): Promise<{ h: Harness; result: SegmentResult | null; error: unknown }> {
    app.reset();
    app.setVariants({ ambiguousStatus: true });
    const h = harness(deps);
    let result: SegmentResult | null = null;
    let error: unknown = null;
    try {
      result = await runRecord(h, await newWorker(), { id: "I-2", status: "closed" });
    } catch (e) {
      error = e;
    }
    console.log(`[recovery live] ${label}: ${result ? "recovered" : `escalated (${(error as Error).name})`}\n${timeline(h.events)}`);
    // Whatever the model says, recovery never writes the wrong field.
    expect(app.items.get("I-2")!.reopenStatus).toBe("open");
    if (result) expect(result.receipts[0]!.readBack.ok).toBe(true);
    else expect(app.writes).toBe(0);
    return { h, result, error };
  }

  it("L2: Jev chooses among ambiguous observed candidates", async () => {
    const jev = new JevProvider(jevConfigFromEnv(), ledger);
    expect(jev.usable).toBe(true);
    const { h, result } = await liveCase("L2 Jev choose", { jev });
    const l2 = h.events.filter((e) => e.level === 2 && e.phase !== "started");
    expect(l2.length).toBeGreaterThan(0);
    if (result) expect(h.engine.stats().byLevel[2]!.successes).toBe(1);
  });

  it("L2 vision: Jev with a screenshot", async () => {
    const jev = new JevProvider(jevConfigFromEnv(), ledger);
    const { h } = await liveCase("L2 Jev choose + screenshot", { jev, useVision: true });
    expect(h.events.some((e) => e.level === 2 && e.phase !== "started")).toBe(true);
  });

  it("L3: Claude recompiles the failing step against the observation", async () => {
    const claude = new ClaudeProvider(claudeConfigFromEnv(), ledger);
    expect(claude.available).toBe(true);
    const { h, result } = await liveCase("L3 Claude", { claude });
    expect(result).not.toBeNull();
    expect(h.engine.stats().byLevel[3]!.successes).toBe(1);
    expect(h.engine.stats().modelCalls).toBe(1);
  });
});
