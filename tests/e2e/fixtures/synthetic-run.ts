/**
 * TEST-ONLY. Generates a synthetic but schema-valid Overclock run as a list of RunEvents, for the
 * dashboard replay server (replay-server.ts) and the Playwright test. Nothing here is measured;
 * it is a deterministic simulation (seeded PRNG) shaped like a streaming-mode (mode E) run:
 * scouts discover three apps while early fragments are already executing, writes are gated
 * until their phase is sealed / critiqued / canaried, and the optimizer switches an access path.
 */
import { RunConfigSchema, applyEvent, createRunView, deriveMetrics } from "@overclock/contracts";
import type { BenchmarkResultFile, BenchmarkRunRecord, CheckResult, EventPayload, PhaseTemplate, PublicScenario, RunEvent, RunSummary, SegmentTemplate, TaskState } from "@overclock/contracts";

export interface SyntheticRun {
  runId: string;
  events: RunEvent[];
  artifacts: Record<string, unknown>;
  program: unknown;
  scenario: PublicScenario;
  check: CheckResult;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BASE_TS = Date.UTC(2026, 9, 23, 18, 0, 0);
const APPS = [
  { name: "CRM", origin: "http://127.0.0.1:4101" },
  { name: "Orders", origin: "http://127.0.0.1:4102" },
  { name: "Support", origin: "http://127.0.0.1:4103" },
];

const PHASES: PhaseTemplate[] = [
  { id: "p0", kind: "once", dependsOn: [], segmentIds: ["p0.s1"] },
  { id: "p1", kind: "foreach", dependsOn: ["p0"], segmentIds: ["p1.s1", "p1.s2", "p1.s3", "p1.s4", "p1.s5", "p1.s6"] },
  { id: "p2", kind: "foreach", dependsOn: ["p1"], segmentIds: ["p2.s1"] },
];

const seg = (s: Omit<SegmentTemplate, "nodeIds" | "reads" | "writes"> & Partial<Pick<SegmentTemplate, "reads" | "writes">>, nodes: number): SegmentTemplate => ({
  nodeIds: Array.from({ length: nodes }, (_, i) => `${s.id}.n${i + 1}`),
  reads: s.reads ?? [],
  writes: s.writes ?? [],
  ...s,
});

const SEGMENTS: SegmentTemplate[] = [
  seg({ id: "p0.s1", phaseId: "p0", app: "Orders", dependsOn: [], effect: "read", kind: "scan", label: "Orders · open /orders → scan table", estimatedMs: 1800, reads: ["orders:list"] }, 2),
  seg({ id: "p1.s1", phaseId: "p1", app: "Orders", dependsOn: [], effect: "read", kind: "read", label: "Orders · open /orders/… → extract", estimatedMs: 420, reads: ["order:{orderId}"] }, 2),
  seg({ id: "p1.s2", phaseId: "p1", app: "CRM", dependsOn: [], effect: "read", kind: "read", label: "CRM · open /customers?email=… → scan table", estimatedMs: 520, reads: ["customer:{email}"] }, 2),
  seg({ id: "p1.s3", phaseId: "p1", app: "Support", dependsOn: [], effect: "read", kind: "read", label: "Support · open /tickets?order=… → extract", estimatedMs: 480, reads: ["ticket:{orderId}"] }, 2),
  seg({ id: "p1.s4", phaseId: "p1", dependsOn: ["p1.s1", "p1.s2", "p1.s3"], effect: "local-write", kind: "compute", label: "compute · decide corrections", estimatedMs: 40 }, 3),
  seg({ id: "p1.s5", phaseId: "p1", app: "Orders", dependsOn: ["p1.s4"], effect: "remote-write", kind: "write", label: "Orders · open /orders/…/edit → fill → submit", estimatedMs: 950, writes: ["order:{orderId}"] }, 4),
  seg({ id: "p1.s6", phaseId: "p1", app: "Support", dependsOn: ["p1.s4"], effect: "remote-write", kind: "write", label: "Support · open /tickets/…/edit → select → submit", estimatedMs: 1050, writes: ["ticket:{ticketId}"] }, 5),
  seg({ id: "p2.s1", phaseId: "p2", app: "CRM", dependsOn: [], effect: "remote-write", kind: "write", label: "CRM · open /customers/…/edit → select → submit", estimatedMs: 900, writes: ["customer:{customerId}"] }, 4),
];

interface Timed {
  t: number;
  order: number;
  payload: EventPayload;
}

class Timeline {
  readonly items: Timed[] = [];
  private n = 0;
  at(t: number, payload: EventPayload): void {
    this.items.push({ t: Math.round(t), order: this.n++, payload });
  }
}

interface SimTask {
  taskId: string;
  segment: SegmentTemplate;
  recordKey: string;
  deps: SimTask[];
  readyAt: number | null;
  doneAt: number | null;
  state: TaskState;
  skip: boolean;
  /** Extra time from an injected recovery. */
  recovery: null | { level: number; reason: string; ms: number; model: boolean };
  unconfirmed: boolean;
  approval: boolean;
}

export function generateSyntheticRun(opts: { runId?: string; records?: number; seed?: number; workers?: number } = {}): SyntheticRun {
  const runId = opts.runId ?? "run-replay-0001";
  const nRecords = opts.records ?? 60;
  const rng = mulberry32(opts.seed ?? 4242);
  const jitter = (base: number, spread = 0.3) => base * (1 - spread + rng() * spread * 2);
  const tl = new Timeline();
  const artifacts: Record<string, unknown> = {};
  const records = Array.from({ length: nRecords }, (_, i) => ({ orderId: `ORD-${1001 + i}`, customerEmail: `customer${(i * 7) % (nRecords - 5) + 1}@example.com` }));
  const customers = ["CUS-2004", "CUS-2011", "CUS-2019", "CUS-2027"];

  const config = RunConfigSchema.parse({
    goal: `Reconcile these ${nRecords} customer orders across CRM, Orders, and Support. Update mismatched records and verify every correction.`,
    applications: APPS,
    records,
    mode: "overclock",
    maxWorkers: opts.workers ?? 8,
    label: "replay fixture",
  });

  // ---- Discovery, planning, compilation (scripted) -------------------------------------------
  tl.at(0, { type: "run.created", config });
  tl.at(2, { type: "run.status", status: "discovering" });
  tl.at(3, { type: "stage", stage: "discovery", phase: "start", detail: "3 apps, no cached models" });
  tl.at(40, { type: "policy.decision", intelligence: "parallel-scout", candidates: 3, reason: "Three unfamiliar apps and a write-heavy goal: run the full scout swarm and compete three strategies.", features: { apps: 3, records: nRecords, cachedModels: 0, writeShare: 0.45, unfamiliar: true } });

  const agents: { id: string; role: "ui-scout" | "workflow-scout" | "dependency-scout" | "optimization-scout" | "adversarial-verifier"; label: string; model?: string; app?: string; start: number; end: number }[] = [
    { id: "scout-orders", role: "ui-scout", label: "Crawl Orders", app: "Orders", start: 60, end: 2300 },
    { id: "scout-crm", role: "ui-scout", label: "Crawl CRM", app: "CRM", start: 70, end: 4800 },
    { id: "scout-support", role: "ui-scout", label: "Crawl Support", app: "Support", start: 80, end: 8600 },
    { id: "workflow", role: "workflow-scout", label: "Draft execution strategies", model: "claude-opus-5-5", start: 1200, end: 3100 },
    { id: "deps", role: "dependency-scout", label: "Classify side effects", model: "jev-latest", start: 1300, end: 2900 },
    { id: "optimize", role: "optimization-scout", label: "Simulate strategy cost", start: 2000, end: 3000 },
    { id: "verifier", role: "adversarial-verifier", label: "Critique and dry-run write paths", model: "claude-opus-5-5", start: 4000, end: 8000 },
  ];
  for (const a of agents) tl.at(a.start, { type: "agent.started", agentId: a.id, role: a.role, label: a.label, model: a.model, app: a.app });

  const routes: Record<string, string[]> = {
    Orders: ["/orders", "/orders/:id", "/orders/:id/edit", "/orders?status=", "/orders?page="],
    CRM: ["/customers", "/customers?email=", "/customers/:id", "/customers/:id/edit", "/customers?page=", "/accounts/holds"],
    Support: ["/tickets", "/tickets?order=", "/tickets/:id", "/tickets/:id/edit", "/tickets/:id/notes", "/tickets?status=", "/queues"],
  };
  for (const a of agents.filter((x) => x.role === "ui-scout")) {
    const app = a.app!;
    const list = routes[app]!;
    let t = a.start + 120;
    let i = 0;
    while (t < a.end - 200) {
      const route = list[i % list.length]!;
      const loadMs = Math.round(jitter(app === "Support" ? 520 : 260));
      t += loadMs + jitter(240);
      const url = `${APPS.find((x) => x.name === app)!.origin}${route.replace(":id", String(100 + i)).replace(/=$/, `=${i}`)}`;
      tl.at(t, { type: "scout.page", agentId: a.id, app, url, routePattern: route, loadMs, controls: Math.round(jitter(app === "CRM" ? 34 : 22)) });
      i++;
    }
    const artifactId = `am-${app.toLowerCase()}`;
    artifacts[artifactId] = { kind: "app-model", app, origin: APPS.find((x) => x.name === app)!.origin, pages: list.map((r, k) => ({ routePattern: r, title: `${app} ${r}`, controls: 12 + k * 3, forms: r.endsWith("edit") ? 1 : 0, tables: r.includes(":id") ? 0 : 1 })), fingerprint: `fp-${app}-v1` };
    tl.at(a.end - 50, { type: "agent.artifact", agentId: a.id, artifact: { artifactId, kind: "app-model", title: `${app} app model`, summary: `${list.length} route patterns, edit forms and list tables mapped`, stats: { routes: list.length, forms: list.filter((r) => r.endsWith("edit")).length } } });
  }

  const call = (t: number, provider: "anthropic" | "typesafe", model: string, purpose: string, ms: number, input: number, output: number, cost: number) => tl.at(t + ms, { type: "model.call", provider, model, purpose, ms, inputTokens: input, outputTokens: output, costUsd: cost, ok: true });
  tl.at(1200, { type: "stage", stage: "planning", phase: "start" });
  for (let k = 0; k < 3; k++) call(1220 + k * 520, "anthropic", "claude-opus-5-5", "workflow-synthesis", Math.round(jitter(1300)), 6100 + k * 300, 1150, 0.046);
  for (let k = 0; k < 6; k++) call(1320 + k * 220, "typesafe", "jev-latest", "effect-classification", Math.round(jitter(90)), 900, 60, 0.0004);
  const candidates = [
    { id: "c-detail", name: "Per-record detail reads", summary: "Open each order, look up the customer by email in CRM, read the ticket, then write corrections." },
    { id: "c-scan", name: "Shared list scans + local joins", summary: "Scan the Orders, CRM and Support lists once, join locally, then visit only records that need writes." },
    { id: "c-seq", name: "Order-at-a-time pipeline", summary: "Process one order fully before the next; simplest locking, no parallel writes to one customer." },
  ];
  candidates.forEach((c, k) => tl.at(1700 + k * 500, { type: "candidate.proposed", candidateId: c.id, name: c.name, summary: c.summary, agentId: "workflow" }));
  const estimates = [
    { modelMs: 3900, browserCriticalPathMs: 21500, recoveryMs: 1200, coordinationMs: 900, verificationMs: 3400, workers: 8, modelCostUsd: 0.21 },
    { modelMs: 4300, browserCriticalPathMs: 17800, recoveryMs: 1400, coordinationMs: 1300, verificationMs: 3400, workers: 8, modelCostUsd: 0.24 },
    { modelMs: 3100, browserCriticalPathMs: 61000, recoveryMs: 900, coordinationMs: 200, verificationMs: 3400, workers: 1, modelCostUsd: 0.18 },
  ];
  candidates.forEach((c, k) => {
    const e = estimates[k]!;
    const totalMs = e.modelMs + e.browserCriticalPathMs + e.recoveryMs + e.coordinationMs + e.verificationMs;
    tl.at(2600 + k * 60, {
      type: "candidate.evaluated",
      candidateId: c.id,
      estimate: { ...e, totalMs, basis: [{ input: "Orders page load", source: "measured", value: 260 }, { input: "CRM page load", source: "measured", value: 270 }, { input: "Support page load", source: k === 1 ? "estimated" : "measured", value: 520 }, { input: "write verification", source: "default", value: 400 }] },
      valid: k !== 1,
      issues: k === 1 ? ["Support list not fully crawled yet: ticket list scan unverified"] : [],
    });
  });
  tl.at(2900, { type: "candidate.selected", candidateId: "c-detail", reason: "Lowest estimated wall time among valid candidates; the list-scan strategy is blocked until the Support crawl finishes.", ranking: [{ candidateId: "c-detail", totalMs: 30900 }, { candidateId: "c-scan", totalMs: 28200 }, { candidateId: "c-seq", totalMs: 68600 }] });
  artifacts["plans"] = { kind: "plan-candidates", candidates: candidates.map((c, k) => ({ ...c, estimate: estimates[k] })) };
  tl.at(3000, { type: "agent.artifact", agentId: "workflow", artifact: { artifactId: "plans", kind: "plan-candidates", title: "Three execution strategies", summary: "Detail reads, shared list scans, and an order-at-a-time pipeline", stats: { candidates: 3 } } });
  artifacts["effects"] = { kind: "effect-classification", nodes: SEGMENTS.map((s) => ({ segment: s.id, effect: s.effect, retry: s.kind === "write" ? "verify-before-retry" : "safe" })) };
  tl.at(2850, { type: "agent.artifact", agentId: "deps", artifact: { artifactId: "effects", kind: "effect-classification", title: "Side-effect classes", summary: "3 remote writes, 5 reads/computes; writes need read-back verification", stats: { writes: 3, reads: 5 } } });
  artifacts["costs"] = { kind: "cost-estimates", candidates: estimates };
  tl.at(2950, { type: "agent.artifact", agentId: "optimize", artifact: { artifactId: "costs", kind: "cost-estimates", title: "Simulated cost", summary: "Critical-path simulation for each candidate", stats: { simulated: 3 } } });
  tl.at(3200, { type: "stage", stage: "planning", phase: "end" });

  tl.at(2400, { type: "run.status", status: "compiling" });
  tl.at(2400, { type: "stage", stage: "compilation", phase: "start" });
  tl.at(2560, {
    type: "program.compiled",
    programId: "prog-1",
    strategy: "Per-record detail reads",
    phases: PHASES,
    segments: SEGMENTS,
    passes: [
      { name: "resolve-locators", ms: 14, changes: 41, detail: "41 control references bound to observed controls" },
      { name: "effect-analysis", ms: 3, changes: 3, detail: "3 remote writes need read-back" },
      { name: "dead-step-elimination", ms: 2, changes: 4, detail: "Removed 4 redundant navigations" },
      { name: "hoist-invariant-reads", ms: 4, changes: 1, detail: "Orders list scan hoisted out of the loop" },
      { name: "navigation-grouping", ms: 6, changes: 8, detail: "28 IR nodes grouped into 8 segments" },
      { name: "lock-inference", ms: 2, changes: 3, detail: "Per-customer and per-ticket locks" },
    ],
    nodeCount: 28,
    compileMs: 31,
  });
  artifacts["risk"] = { kind: "risk-report", findings: [{ severity: "high", segment: "p1.s6", issue: "Ticket notes are append-only: a retried submit duplicates the note", mitigation: "verify-before-retry with note read-back" }, { severity: "medium", segment: "p2.s1", issue: "Account hold must wait for every order of the customer", mitigation: "phase barrier (p2 after p1 sealed)" }] };
  tl.at(7900, { type: "agent.artifact", agentId: "verifier", artifact: { artifactId: "risk", kind: "risk-report", title: "Write-path critique", summary: "2 findings; both mitigated by verification and the phase barrier", stats: { high: 1, medium: 1 } } });
  artifacts["dry"] = { kind: "dry-run", probes: [{ segment: "p1.s5", record: "ORD-1001", ok: true, ms: 780 }, { segment: "p1.s6", record: "ORD-1003", ok: true, ms: 910, note: "confirm modal detected and handled" }] };
  tl.at(6400, { type: "agent.artifact", agentId: "verifier", artifact: { artifactId: "dry", kind: "dry-run", title: "Dry-run probes", summary: "2 write paths probed without committing", stats: { probes: 2, ok: 2 } } });
  for (let k = 0; k < 2; k++) call(4100 + k * 1800, "anthropic", "claude-opus-5-5", "critique", Math.round(jitter(1500)), 8200, 900, 0.058);
  tl.at(4200, { type: "stage", stage: "compilation", phase: "end" });
  tl.at(4000, { type: "stage", stage: "critique", phase: "start" });
  tl.at(8000, { type: "stage", stage: "critique", phase: "end" });
  tl.at(5000, { type: "stage", stage: "probe", phase: "start" });
  tl.at(6500, { type: "stage", stage: "probe", phase: "end" });
  for (const a of agents) tl.at(a.end, { type: "agent.finished", agentId: a.id, ok: true, ms: a.end - a.start });
  tl.at(9000, { type: "stage", stage: "discovery", phase: "end" });

  // Fragment lifecycle: when each segment may run (canary = first record only).
  const frag = (t: number, fragmentId: string, phaseId: string, segmentIds: string[], state: "compiled" | "validated" | "canary" | "released" | "deferred" | "revised", label: string, effect: string, reason?: string) => tl.at(t, { type: "fragment", fragmentId, phaseId, segmentIds, state, label, effect, reason });
  frag(2560, "f-scan", "p0", ["p0.s1"], "compiled", "Orders list scan", "read");
  frag(2700, "f-scan", "p0", ["p0.s1"], "validated", "Orders list scan", "read");
  frag(2880, "f-scan", "p0", ["p0.s1"], "released", "Orders list scan", "read");
  frag(2800, "f-reads", "p1", ["p1.s1", "p1.s2", "p1.s3"], "compiled", "Per-order reads (Orders, CRM, Support)", "read");
  frag(3100, "f-reads", "p1", ["p1.s1", "p1.s2", "p1.s3"], "validated", "Per-order reads (Orders, CRM, Support)", "read");
  frag(3200, "f-reads", "p1", ["p1.s1", "p1.s2", "p1.s3"], "canary", "Per-order reads (Orders, CRM, Support)", "read", "ORD-1001");
  frag(3000, "f-decide", "p1", ["p1.s4"], "compiled", "Decide corrections", "local-write");
  frag(3300, "f-decide", "p1", ["p1.s4"], "released", "Decide corrections", "local-write");
  frag(3400, "f-orders-write", "p1", ["p1.s5"], "compiled", "Fix order customer IDs", "remote-write");
  frag(3500, "f-orders-write", "p1", ["p1.s5"], "deferred", "Fix order customer IDs", "remote-write", "awaiting critique");
  frag(3600, "f-support-write", "p1", ["p1.s6"], "compiled", "Resolve and annotate tickets", "remote-write");
  frag(3700, "f-support-write", "p1", ["p1.s6"], "deferred", "Resolve and annotate tickets", "remote-write", "Support app not fully discovered");
  frag(4000, "f-holds", "p2", ["p2.s1"], "compiled", "Apply CRM account holds", "remote-write");
  frag(4100, "f-holds", "p2", ["p2.s1"], "deferred", "Apply CRM account holds", "remote-write", "phase not sealed");
  const releaseReadsAt = 3900;
  frag(releaseReadsAt, "f-reads", "p1", ["p1.s1", "p1.s2", "p1.s3"], "released", "Per-order reads (Orders, CRM, Support)", "read");
  const canaryOrdersAt = 6500;
  const releaseOrdersAt = 7600;
  frag(6300, "f-orders-write", "p1", ["p1.s5"], "validated", "Fix order customer IDs", "remote-write");
  frag(canaryOrdersAt, "f-orders-write", "p1", ["p1.s5"], "canary", "Fix order customer IDs", "remote-write", "canary verifying");
  frag(releaseOrdersAt, "f-orders-write", "p1", ["p1.s5"], "released", "Fix order customer IDs", "remote-write");
  const canarySupportAt = 8700;
  const releaseSupportAt = 9800;
  frag(8650, "f-support-write", "p1", ["p1.s6"], "validated", "Resolve and annotate tickets", "remote-write");
  frag(canarySupportAt, "f-support-write", "p1", ["p1.s6"], "canary", "Resolve and annotate tickets", "remote-write", "canary verifying");
  frag(releaseSupportAt, "f-support-write", "p1", ["p1.s6"], "released", "Resolve and annotate tickets", "remote-write");

  // ---- Execution (time-stepped simulation) ---------------------------------------------------
  const execStart = 2900;
  tl.at(execStart - 10, { type: "run.status", status: "running" });
  tl.at(execStart, { type: "stage", stage: "execution", phase: "start" });

  const tasks: SimTask[] = [];
  const byKey = new Map<string, SimTask>();
  const mk = (segment: SegmentTemplate, recordKey: string): SimTask => {
    const t: SimTask = { taskId: `${segment.id}:${recordKey}`, segment, recordKey, deps: [], readyAt: null, doneAt: null, state: "PENDING", skip: false, recovery: null, unconfirmed: false, approval: false };
    tasks.push(t);
    byKey.set(t.taskId, t);
    return t;
  };
  const scan = mk(SEGMENTS[0]!, "(run)");
  const p1: SimTask[] = [];
  for (const r of records) {
    const [s1, s2, s3, s4, s5, s6] = SEGMENTS.slice(1, 7).map((s) => mk(s, r.orderId)) as [SimTask, SimTask, SimTask, SimTask, SimTask, SimTask];
    s1.deps = [scan];
    s2.deps = [scan];
    s3.deps = [scan];
    s4.deps = [s1, s2, s3];
    s5.deps = [s4];
    s6.deps = [s4];
    s5.skip = rng() < 0.62;
    s6.skip = rng() < 0.45;
    p1.push(s1, s2, s3, s4, s5, s6);
  }
  const p2 = customers.map((c) => mk(SEGMENTS[7]!, c));
  for (const t of p2) t.deps = p1;
  const writes = tasks.filter((t) => t.segment.kind === "write" && !t.skip);
  writes[3]!.recovery = { level: 1, reason: "Save button renamed to Apply", ms: 380, model: false };
  writes[11]!.recovery = { level: 2, reason: "Confirmation modal appeared before save", ms: 640, model: true };
  writes[17]!.recovery = { level: 1, reason: "Edit form moved behind a Details tab", ms: 420, model: false };
  writes[22]!.unconfirmed = true;
  p2[1]!.approval = true;

  tl.at(2700, { type: "tasks.created", tasks: tasks.map((t) => ({ taskId: t.taskId, segmentId: t.segment.id, phaseId: t.segment.phaseId, recordKey: t.recordKey })) });

  const gate = (t: SimTask): number => {
    const id = t.segment.id;
    const first = t.recordKey === records[0]!.orderId;
    if (id === "p0.s1") return 2880;
    if (["p1.s1", "p1.s2", "p1.s3"].includes(id)) return first ? 3200 : releaseReadsAt;
    if (id === "p1.s4") return 3300;
    if (id === "p1.s5") return first ? canaryOrdersAt : releaseOrdersAt;
    if (id === "p1.s6") return first || t.recordKey === records[2]!.orderId ? canarySupportAt : releaseSupportAt;
    return 0;
  };

  const limits: Record<string, { t: number; limit: number; reason: string }[]> = {
    Orders: [{ t: execStart, limit: 2, reason: "initial" }, { t: 5200, limit: 3, reason: "p95 latency stable" }, { t: 8200, limit: 4, reason: "no errors in 40 requests" }],
    CRM: [{ t: execStart, limit: 2, reason: "initial" }, { t: 6000, limit: 3, reason: "p95 latency stable" }],
    Support: [{ t: execStart, limit: 2, reason: "initial" }, { t: 9800, limit: 3, reason: "p95 latency stable" }, { t: 16000, limit: 2, reason: "429 Too Many Requests from Support" }, { t: 21000, limit: 3, reason: "recovered after 5 s without 429" }],
  };
  for (const [app, hist] of Object.entries(limits)) for (const h of hist) tl.at(h.t, { type: "concurrency", app, limit: h.limit, reason: h.reason });
  const limitAt = (app: string, t: number) => {
    let l = 1;
    for (const h of limits[app] ?? []) if (h.t <= t) l = h.limit;
    return l;
  };

  const nWorkers = config.maxWorkers;
  const workers = Array.from({ length: nWorkers }, (_, i) => ({ id: `w${i + 1}`, freeAt: execStart + i * 40, task: null as SimTask | null, thumbs: 0 }));
  for (const w of workers) tl.at(w.freeAt, { type: "worker.state", workerId: w.id, state: "IDLE" });

  let reoptAt: number | null = null;
  const reoptT = 14000;
  const running = new Map<string, number>(); // app -> count, recomputed per step
  let lockConflicts = 0;
  let holdsReleased = false;
  for (let now = execStart; now < 200_000; now += 10) {
    if (tasks.every((t) => t.doneAt !== null && t.doneAt <= now)) break;
    if (reoptAt === null && now >= reoptT) {
      reoptAt = now;
      tl.at(now, { type: "stage", stage: "optimization", phase: "start", detail: "online re-optimization" });
      tl.at(now + 120, { type: "reopt.decision", switched: true, reason: "Measured CRM detail lookups (520 ms × remaining orders) exceed one shared customer-list scan plus local joins.", remainingMs: 16400, alternativeMs: 11200, alternative: "CRM list scan + local join" });
      tl.at(now + 130, { type: "stage", stage: "compilation", phase: "start", detail: "recompile CRM lookup" });
      tl.at(now + 300, { type: "program.patched", programId: "prog-1", segmentIds: ["p1.s2"], reason: "access path: per-record detail → shared list scan", level: 0 });
      frag(now + 310, "f-crm-scan", "p1", ["p1.s2"], "compiled", "CRM lookup via shared list scan", "read");
      frag(now + 380, "f-crm-scan", "p1", ["p1.s2"], "validated", "CRM lookup via shared list scan", "read");
      frag(now + 420, "f-crm-scan", "p1", ["p1.s2"], "released", "CRM lookup via shared list scan", "read");
      frag(now + 425, "f-reads", "p1", ["p1.s1", "p1.s3"], "released", "Per-order reads (Orders, Support)", "read", "CRM lookup moved to a shared scan");
      tl.at(now + 450, { type: "stage", stage: "compilation", phase: "end" });
      tl.at(now + 9000, { type: "reopt.decision", switched: false, reason: "Support writes dominate the remaining critical path; no cheaper access path found.", remainingMs: 6100, alternativeMs: 6900, alternative: "Batch ticket updates" });
      tl.at(now + 9050, { type: "stage", stage: "optimization", phase: "end" });
    }

    // Mark ready tasks.
    for (const t of tasks) {
      if (t.readyAt !== null) continue;
      if (!t.deps.every((d) => d.doneAt !== null && d.doneAt <= now)) continue;
      const g = gate(t);
      if (now < g) continue;
      if (t.segment.id === "p2.s1" && now < Math.max(...p1.map((x) => x.doneAt ?? Infinity)) + 50) continue;
      t.readyAt = now;
      if (t.skip) {
        t.doneAt = now + 5;
        tl.at(now, { type: "task.state", taskId: t.taskId, state: "READY" });
        tl.at(now + 5, { type: "task.state", taskId: t.taskId, state: "SKIPPED" });
        tl.at(now + 5, { type: "receipt", taskId: t.taskId, recordKey: t.recordKey, status: "SKIPPED", nodeId: t.segment.nodeIds.at(-1)!, fields: [] });
        continue;
      }
      tl.at(now, { type: "task.state", taskId: t.taskId, state: "READY" });
      if (!t.segment.app) {
        // Browser-free compute segment.
        tl.at(now + 2, { type: "task.state", taskId: t.taskId, state: "RUNNING", attempt: 1 });
        tl.at(now + 4, { type: "action", taskId: t.taskId, nodeId: t.segment.nodeIds[0]!, actionType: "compute", ms: 2, ok: true, modelCalls: 0 });
        const d = Math.round(jitter(30));
        tl.at(now + d, { type: "task.state", taskId: t.taskId, state: "COMPLETED", ms: d });
        t.doneAt = now + d;
      }
    }
    if (!holdsReleased && tasks.some((t) => t.segment.id === "p2.s1" && t.readyAt !== null)) {
      holdsReleased = true;
      frag(now, "f-holds", "p2", ["p2.s1"], "released", "Apply CRM account holds", "remote-write", "phase p1 sealed");
    }

    running.clear();
    for (const w of workers) if (w.task && w.freeAt > now && w.task.segment.app) running.set(w.task.segment.app, (running.get(w.task.segment.app) ?? 0) + 1);
    for (const w of workers) {
      if (w.freeAt > now) continue;
      w.task = null;
      const candidates = tasks.filter((t) => t.readyAt !== null && t.readyAt <= now && t.state === "PENDING" && !t.skip && t.segment.app && (running.get(t.segment.app) ?? 0) < limitAt(t.segment.app, now));
      // Critical-path priority: writes and the scan first, then reads by record order.
      candidates.sort((a, b) => Number(b.segment.kind === "write" || b.segment.kind === "scan") - Number(a.segment.kind === "write" || a.segment.kind === "scan") || (a.readyAt ?? 0) - (b.readyAt ?? 0));
      const t = candidates[0];
      if (!t) continue;
      const app = t.segment.app!;
      running.set(app, (running.get(app) ?? 0) + 1);
      t.state = "LEASED";
      w.task = t;
      const t0 = now;
      if (t.approval) {
        tl.at(t0, { type: "approval.requested", approvalId: "appr-1", taskId: t.taskId, nodeId: t.segment.nodeIds.at(-1)!, description: `Set ${t.recordKey} to on_hold: the customer has an open enterprise contract` });
        tl.at(t0, { type: "task.state", taskId: t.taskId, state: "NEEDS_APPROVAL" });
        tl.at(t0 + 2600, { type: "approval.resolved", approvalId: "appr-1", approved: true });
        tl.at(t0 + 2610, { type: "task.state", taskId: t.taskId, state: "READY" });
        t.approval = false;
        t.state = "PENDING";
        t.readyAt = t0 + 2610;
        w.task = null;
        running.set(app, (running.get(app) ?? 1) - 1);
        continue;
      }
      if (t.segment.kind === "write" && lockConflicts < 3 && rng() < 0.05) {
        lockConflicts++;
        tl.at(t0, { type: "lock.conflict", taskId: t.taskId, resource: `customer:${t.recordKey}`, holder: workers[(workers.indexOf(w) + 1) % workers.length]!.id });
      }
      const fast = t.segment.id === "p1.s2" && reoptAt !== null && t0 > reoptAt + 420;
      let d = Math.round(fast ? jitter(90) : jitter(t.segment.estimatedMs, 0.25));
      if (t.recovery) d += t.recovery.ms;
      tl.at(t0, { type: "task.state", taskId: t.taskId, state: "LEASED", workerId: w.id });
      tl.at(t0, { type: "worker.state", workerId: w.id, state: "LEASED", taskId: t.taskId, app, label: t.segment.label });
      tl.at(t0 + 15, { type: "worker.state", workerId: w.id, state: "EXECUTING", taskId: t.taskId, app, op: fast ? "join cached CRM list" : "navigate", label: t.segment.label });
      tl.at(t0 + 15, { type: "task.state", taskId: t.taskId, state: "RUNNING", workerId: w.id, attempt: 1 });
      w.thumbs++;
      tl.at(t0 + 60, { type: "worker.thumb", workerId: w.id, url: `/api/runs/${runId}/workers/${w.id}/thumb.jpg?v=${w.thumbs}` });
      const nav = Math.round(d * 0.35);
      tl.at(t0 + 15 + nav, { type: "action", taskId: t.taskId, nodeId: t.segment.nodeIds[0]!, actionType: fast ? "compute" : "navigate", ms: nav, ok: true, modelCalls: 0, locatorTier: 0 });
      const isWrite = t.segment.kind === "write";
      const actionTypes = isWrite ? ["fill", "click"] : t.segment.kind === "scan" ? ["extract"] : ["extract"];
      actionTypes.forEach((at, k) => tl.at(t0 + 15 + nav + (k + 1) * Math.round(d * 0.15), { type: "action", taskId: t.taskId, nodeId: t.segment.nodeIds[Math.min(k + 1, t.segment.nodeIds.length - 1)]!, actionType: at, ms: Math.round(d * 0.12), ok: true, modelCalls: 0, locatorTier: 0 }));
      if (t.recovery) {
        const r = t.recovery;
        const rs = t0 + Math.round(d * 0.45);
        tl.at(rs, { type: "task.state", taskId: t.taskId, state: "REPAIRING", workerId: w.id });
        tl.at(rs, { type: "worker.state", workerId: w.id, state: "REPAIRING", taskId: t.taskId, app, op: `L${r.level} repair` });
        tl.at(rs, { type: "recovery", taskId: t.taskId, level: r.level, phase: "started", reason: r.reason });
        if (r.model) call(rs + 20, "typesafe", "jev-preview", "recovery-vision", Math.round(r.ms * 0.6), 2400, 120, 0.0021);
        tl.at(rs + r.ms, { type: "action", taskId: t.taskId, nodeId: t.segment.nodeIds.at(-1)!, actionType: "click", ms: Math.round(r.ms * 0.3), ok: true, modelCalls: r.model ? 1 : 0, locatorTier: r.level + 1, detail: "relocated control" });
        tl.at(rs + r.ms, { type: "recovery", taskId: t.taskId, level: r.level, phase: "succeeded", reason: r.reason, ms: r.ms, propagatedTo: r.level === 1 ? Math.round(rng() * 12) + 4 : undefined });
        tl.at(rs + r.ms + 1, { type: "task.state", taskId: t.taskId, state: "RUNNING", workerId: w.id, attempt: 1 });
        tl.at(rs + r.ms + 1, { type: "worker.state", workerId: w.id, state: "EXECUTING", taskId: t.taskId, app, op: "submit" });
      }
      if (isWrite) {
        const afterRepair = t.recovery ? t0 + Math.round(d * 0.45) + t.recovery.ms + 10 : 0;
        const vs = Math.max(t0 + Math.round(d * 0.75), afterRepair);
        tl.at(vs, { type: "task.state", taskId: t.taskId, state: "VERIFYING", workerId: w.id });
        tl.at(vs, { type: "worker.state", workerId: w.id, state: "VERIFYING", taskId: t.taskId, app, op: "fresh read-back" });
        tl.at(Math.min(vs + Math.round(d * 0.2), t0 + d - 1), { type: "action", taskId: t.taskId, nodeId: t.segment.nodeIds.at(-1)!, actionType: "extract", ms: Math.round(d * 0.2), ok: true, modelCalls: 0, detail: "read-back" });
      }
      const end = t0 + d;
      if (isWrite) {
        if (t.unconfirmed) {
          tl.at(end - 40, { type: "recovery", taskId: t.taskId, level: 3, phase: "escalated", reason: "HTTP 500 after submit; read-back could not confirm the write", detail: "left for reconciliation" });
          tl.at(end, { type: "receipt", taskId: t.taskId, recordKey: t.recordKey, status: "UNCONFIRMED", nodeId: t.segment.nodeIds.at(-1)!, fields: [{ name: "status", expected: "resolved", actual: null }] });
          tl.at(end, { type: "task.state", taskId: t.taskId, state: "UNCONFIRMED", workerId: w.id, ms: d, error: "write could not be confirmed" });
        } else {
          tl.at(end, { type: "receipt", taskId: t.taskId, recordKey: t.recordKey, status: "VERIFIED", nodeId: t.segment.nodeIds.at(-1)!, fields: [{ name: t.segment.id === "p1.s5" ? "customerId" : t.segment.id === "p1.s6" ? "status" : "accountStatus", expected: "ok", actual: "ok" }] });
          tl.at(end, { type: "task.state", taskId: t.taskId, state: "VERIFIED", workerId: w.id, ms: d });
        }
      } else {
        tl.at(end, { type: "task.state", taskId: t.taskId, state: "COMPLETED", workerId: w.id, ms: d });
      }
      tl.at(end, { type: "worker.state", workerId: w.id, state: "COMPLETED", taskId: t.taskId, app });
      tl.at(end + 12, { type: "worker.state", workerId: w.id, state: "IDLE" });
      t.doneAt = end;
      w.freeAt = end + 12;
    }
  }
  const lastDone = Math.max(...tasks.map((t) => t.doneAt ?? 0));
  const invalidRecord = records[Math.floor(nRecords * 0.8)]!.orderId;
  tl.at(12_500, { type: "invalidation", taskId: `p1.s4:${invalidRecord}`, recordKey: invalidRecord, reason: "Source record edited during the run; decisions recomputed before any write", invalidated: [`p1.s4:${invalidRecord}`, `p1.s5:${invalidRecord}`, `p1.s6:${invalidRecord}`] });
  for (const w of workers) tl.at(lastDone + 30, { type: "worker.state", workerId: w.id, state: "STOPPED" });
  tl.at(lastDone + 40, { type: "stage", stage: "execution", phase: "end" });
  tl.at(lastDone + 50, { type: "log", level: "info", message: "All tasks reached a terminal state" });

  // ---- Assemble, then derive the summary from the same reducer the dashboard uses ------------
  const sorted = [...tl.items].sort((a, b) => a.t - b.t || a.order - b.order);
  const events: RunEvent[] = sorted.map((x, i) => ({ ...x.payload, runId, seq: i + 1, ts: BASE_TS + x.t, t: x.t }) as RunEvent);
  const view = createRunView(runId);
  for (const e of events) applyEvent(view, e);
  const m = deriveMetrics(view);
  const endT = lastDone + 60;
  const recordsVerified = records.filter((r) => !(view.recordReceipts[r.orderId]?.UNCONFIRMED || view.recordReceipts[r.orderId]?.FAILED)).length;
  const summary: RunSummary = {
    runId,
    mode: "overclock",
    status: "completed",
    wallMs: endT,
    discoveryMs: 9000,
    compileMs: 31,
    executionMs: endT - execStart,
    records: nRecords,
    tasks: tasks.length,
    verified: view.taskCounts.VERIFIED ?? 0,
    failed: view.taskCounts.FAILED ?? 0,
    unconfirmed: view.taskCounts.UNCONFIRMED ?? 0,
    skipped: view.taskCounts.SKIPPED ?? 0,
    needsApproval: view.taskCounts.NEEDS_APPROVAL ?? 0,
    recordsVerified,
    recoveries: view.recoveries.filter((r) => r.phase === "started" || r.phase === "escalated").length,
    modelCalls: view.modelCalls.count,
    inputTokens: view.modelCalls.inputTokens,
    outputTokens: view.modelCalls.outputTokens,
    modelCostUsd: view.modelCalls.costUsd,
    workerUtilization: m.utilization,
    maxConcurrency: nWorkers,
    strategy: "Per-record detail reads → CRM list scan",
    firstActionMs: m.firstActionMs,
    firstVerifiedMs: m.firstVerifiedMs,
    overlapMs: m.overlapMs,
    recoveryMs: writes.reduce((s, t) => s + (t.recovery?.ms ?? 0), 0),
    stageMs: view.stages.reduce<Record<string, number>>((acc, st) => ({ ...acc, [st.stage]: (acc[st.stage] ?? 0) + ((st.end ?? endT) - st.start) }), {}),
  };
  const tail: EventPayload[] = [
    { type: "run.status", status: "completed" },
    { type: "run.completed", summary },
  ];
  for (const p of tail) events.push({ ...p, runId, seq: events.length + 1, ts: BASE_TS + endT, t: endT } as RunEvent);

  const program = { programId: "prog-1", template: { phases: PHASES, segments: SEGMENTS }, ir: { version: "1.0", nodes: SEGMENTS.flatMap((s) => s.nodeIds.map((id) => ({ id, segment: s.id, effect: s.effect, app: s.app ?? null }))) } };

  const scenario: PublicScenario = { scenarioId: "t1-4242-60", seed: 4242, template: "t1-order-reconcile", title: "Reconcile orders across CRM, Orders, and Support", goal: config.goal, records, applications: APPS, holdout: false };
  const check: CheckResult = { scenarioId: scenario.scenarioId, totalRecords: nRecords, correctRecords: nRecords - 1, accuracy: (nRecords - 1) / nRecords, mismatches: [{ recordKey: writes[22]!.recordKey, entity: "ticket", field: "status", expected: "resolved", actual: "open" }], duplicateWrites: 0, collateralWrites: 0, escalationExpected: 3, checkedAt: BASE_TS + endT + 5000 };
  return { runId, events, artifacts, program, scenario, check };
}

/** TEST-ONLY benchmark file with obviously synthetic numbers (labelled as such in `notes`). */
export function generateBenchmarkFile(): BenchmarkResultFile {
  const rng = mulberry32(7);
  const runs: BenchmarkRunRecord[] = [];
  const add = (label: string, mode: string, n: number, wall: number, firstVerified: number | null, cache: "cold" | "warm", condition: string, holdout = false) => {
    for (let trial = 0; trial < n; trial++) {
      const wallMs = Math.round(wall * (0.9 + rng() * 0.2));
      const correct = 100 - (rng() < 0.2 ? 1 : 0);
      runs.push({
        suite: "fixture",
        label,
        mode,
        scenarioId: `t1-${4242 + trial}-100`,
        template: holdout ? "t3-crm-status-sync" : "t1-order-reconcile",
        seed: 4242 + trial,
        records: 100,
        trial,
        cache,
        holdout,
        runId: null,
        startedAt: BASE_TS + runs.length * 60_000,
        summary: null,
        check: { scenarioId: `t1-${4242 + trial}-100`, totalRecords: 100, correctRecords: correct, accuracy: correct / 100, mismatches: [], duplicateWrites: 0, collateralWrites: 0, escalationExpected: 4, checkedAt: BASE_TS },
        wallMs,
        discoveryMs: Math.round(wallMs * 0.2),
        compileMs: 40,
        executionMs: Math.round(wallMs * 0.75),
        correctPerMin: correct / (wallMs / 60_000),
        modelCalls: mode === "sequential-agent" ? 900 : 14,
        inputTokens: 90_000,
        outputTokens: 9_000,
        costUsd: mode === "sequential-agent" ? 4.2 : 0.3,
        workerUtilization: 0.7,
        maxConcurrency: mode === "compiled-single" || mode === "sequential-agent" ? 1 : 8,
        verifiedButWrong: 0,
        firstActionMs: firstVerified === null ? null : Math.round(firstVerified * 0.4),
        firstVerifiedMs: firstVerified === null ? null : Math.round(firstVerified * (0.9 + rng() * 0.2)),
        overlapMs: mode === "overclock" ? 6000 : 0,
        recoveryMs: 800,
        duplicateWrites: 0,
        collateralWrites: 0,
        condition,
        config: { goal: "fixture", applications: APPS, mode: mode as "overclock" },
      });
    }
  };
  add("sequential-agent", "sequential-agent", 1, 610_000, 21_000, "cold", "local");
  add("compiled-single", "compiled-single", 2, 140_000, 15_000, "cold", "local");
  add("parallel", "compiled-parallel", 3, 52_000, 14_500, "cold", "local");
  add("staged", "overclock-staged", 3, 41_000, 12_800, "cold", "local");
  add("overclock", "overclock", 5, 33_000, 6_600, "cold", "local");
  add("ablation:no-jev", "overclock", 2, 38_000, 7_900, "cold", "local");
  add("overclock", "overclock", 2, 21_000, 1_900, "warm", "local");
  add("parallel", "compiled-parallel", 2, 88_000, 26_000, "cold", "latency:150±100");
  add("overclock", "overclock", 2, 51_000, 11_000, "cold", "latency:150±100");
  return { version: 1, suite: "fixture", createdAt: BASE_TS, machine: { platform: "fixture", cpus: 8, memoryGb: 16, node: "24" }, budgetUsd: 50, spentUsd: 0, runs, notes: ["Synthetic fixture for dashboard tests. These numbers were not measured."] };
}
