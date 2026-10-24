# Overclock architecture

This document describes how Overclock turns a natural-language browser task into a verified,
parallel execution program, and what the code does today. Each section carries a status label:

- **Working (tested):** automated tests cover it.
- **Partial:** implemented, but untested end to end or with a known gap.
- **In progress:** code is being written or is not wired in yet.
- **Proposed:** design only.

Statuses reflect the repository on 2026-10-24. [`PROGRESS.md`](../PROGRESS.md) tracks changes.

## Components

| Package | Role | Status |
| --- | --- | --- |
| `packages/contracts` | Zod schemas and types for the IR, Procedure DSL, app model, events, reducer, run config, scenarios, and benchmark files. | Working (tested) |
| `packages/perception` | One `page.evaluate` round trip per page: controls, forms, tables, facts, dialogs, route patterns, structural fingerprints, ranked locators. | Working (tested) |
| `packages/discovery` | UI scout crawl, app-model rendering, planner prompt, operation catalogs, effect classification, critique, dry-run probes, plan stream watcher. | Partial |
| `packages/compiler` | Expression language, lowering, validation, optimizer passes, segment formation, incremental compiler. | Working (tested) |
| `packages/optimizer` | Latency model, list-scheduling simulator, cost model, worker recommendation, access-path detection. | Working (tested); access paths In progress |
| `packages/scheduler` | Per-record task expansion, dependencies, locks, release gates, invalidation, AIMD concurrency. | Working (tested); gates Partial |
| `packages/browser-runtime` | Shared Chromium, guarded contexts, sessions, locator resolution, actions, read-back, segment runner. | Working (tested) |
| `packages/recovery` | Localized repair ladder L0–L4 with learned rules. | L0/L1/L4 Working (tested); L2/L3 Partial |
| `packages/models` | Claude and Jev providers with a cost ledger and budget guard. | Partial (live only) |
| `packages/swarm` | Intelligence policy and the stage-gated pipeline (modes B, C, D). | Partial |
| `services/engine` | Run controller, executor, streaming pipeline (mode E), SQLite store, HTTP and SSE server, restart recovery. | Store and API Working (tested); executor Partial; mode E In progress |
| `packages/sdk`, `apps/cli` | TypeScript client and `pnpm cli`. | Working (tested) |
| `apps/dashboard` | Next.js run console and benchmark pages. | Working (tested against a replay server) |
| `apps/arena` | Three web apps, a judge console, variations, ground-truth checker, and a holdout app. | Working (tested) |
| `packages/benchmarks` | Mode A baseline, suites, harness, statistics, report generator. | Working (tested) |
| `packages/external-baselines` | Optional Stagehand baseline judged by the same checker. | Partial |
| `packages/network-*`, `services/network/*`, `scripts/network-*.ts` | Overclock Network. See [`NETWORK.md`](NETWORK.md). | In progress (capability layer tested; not wired into the engine) |

## Data flow

A run starts when a client posts a `RunConfig` to `POST /api/runs`. The config holds the goal,
the application bindings (`name` and `origin`), the input records, the mode, and ablation
switches. It never holds credentials.

1. The engine signs in to each app twice: once with the execution account and once with a
   read-only explorer account when the app has one.
2. Discovery crawls each app in a mutation-blocked context and builds an `AppModel`.
3. The planner writes a `DslPlan`. The compiler lowers it to an `ExecutionProgram` (the IR),
   validates it, optimizes it, and forms segments.
4. The scheduler expands every segment into one task per record and hands tasks to browser
   workers. A worker runs a segment with deterministic Playwright actions and no model calls.
5. Every write is followed by a read-back on a freshly loaded page. Receipts decide each
   record's outcome.
6. The run ends with a `RunSummary` and per-record `RecordOutcome`s from
   `GET /api/runs/:id/result`.

Mode A (`sequential-agent`) skips steps 2–4: one worker asks the helper model for every next
action. Its completions are model claims, so it never reports `VERIFIED`.

## Event model

**Status: Working (tested).** `tests/integration/engine-api.test.ts` covers persistence,
replay, restart recovery, paging, SSE resume, and backpressure.

Every state change is an event. `EventBus` redacts the payload, assigns a sequence number
(`seq`), a wall-clock time (`ts`), and a monotonic time since run start (`t`), persists the
event, and only then notifies subscribers. The engine and the dashboard build their view of a
run by applying the same events through the same reducer (`applyEvent` in
`packages/contracts/src/reducer.ts`), so the dashboard shows exactly what the engine recorded.
Replay is idempotent: events with `seq` at or below the last applied one are ignored.

| Group | Event types |
| --- | --- |
| Run | `run.created`, `run.status`, `run.completed`, `log` |
| Pipeline | `stage` (start and end of `discovery`, `planning`, `compilation`, `critique`, `probe`, `execution`, `optimization`), `scout.page`, `fragment` |
| Discovery and planning | `policy.decision`, `agent.started`, `agent.artifact`, `agent.finished`, `candidate.proposed`, `candidate.evaluated`, `candidate.selected`, `program.compiled`, `program.patched` |
| Execution | `tasks.created`, `task.state`, `worker.state`, `worker.thumb`, `action`, `receipt`, `lock.conflict`, `invalidation`, `concurrency`, `reopt.decision` |
| Recovery and approvals | `recovery`, `approval.requested`, `approval.resolved` |
| Models | `model.call` (provider, model, purpose, latency, tokens, cost, success) |
| Network | `network.lookup`, `network.import`, `network.publish`, `network.repair`, `network.update` |

Only mode E's access-path controller emits `reopt.decision`, and no engine code emits the
`network.*` family yet. Stage intervals may overlap. That overlap is what mode E produces and
what `overlapMs` measures.

**Storage.** `EngineStore` keeps one SQLite file per runtime (`node:sqlite`, WAL mode,
`synchronous=NORMAL`). The append-only `events` table is the source of truth. `appendEvent`
writes each event and every projection derived from it (runs, tasks, task transitions,
receipts, recoveries, model invocations, lock conflicts, stage intervals, scout pages,
fragments) in one transaction, so projections can't disagree with the log.

**Restart.** Runs that exist in the store but not in the live process are served read-only
by rebuilding their view from the event log. A run with no `run.completed` event is reported
`failed` with the reason "engine restarted during the run", and tasks that may have been
mid-write are reported `UNCONFIRMED`, because the engine can't know whether those writes
committed.

**API.** The engine serves `GET /api/health`, `POST /api/runs`, `GET /api/runs`,
`GET /api/runs/:id`, `GET /api/runs/:id/events?after=&limit=`, `GET /api/runs/:id/stream`
(server-sent events with `Last-Event-ID` resume and a 15 s heartbeat),
`POST /api/runs/:id/{cancel,pause,resume,approvals}`, `GET /api/runs/:id/{result,metrics,trace,program}`,
`GET /api/runs/:id/artifacts/:artifactId`, `GET /api/runs/:id/workers/:workerId/thumb.jpg`,
and `GET /api/benchmarks[/:name]`.

## IR and segments

**Status: Working (tested).** [`ACTION_IR.md`](ACTION_IR.md) is the full reference.

The planner produces the Procedure DSL: phases (`once` or `foreach` over a list) of typed steps
(`goto`, `fill`, `select`, `click`, `submit`, `extract`, `extractTable`, `compute`, `assert`,
`waitFor`). The compiler lowers it into IR `ActionNode`s with resolved semantic locators,
effects (`read`, `local-write`, `remote-write`, `irreversible`), retry policies, declared read
and write resources, preconditions, and read-back verification specs.

`compileProgram` then runs eight passes per scope:

| # | Pass | What it does |
| --- | --- | --- |
| 1 | `dependency-analysis` | Adds ordering edges for read-after-write, write-after-read, and write-after-write conflicts on declared resources. Only ever adds edges. |
| 2 | `redundant-observation-elimination` | Drops a navigate to the URL the page already shows when nothing changed the page, and aliases duplicate extractions. |
| 3 | `locator-reuse` | Counts target references that share a control. Reporting only: the runtime has no locator cache yet. |
| 4 | `common-subexpression-reuse` | Collapses identical pure computations. |
| 5 | `navigation-grouping` | Forms segments (see the following list). |
| 6 | `concurrency-extraction` | Reports intra-record parallelism (total work divided by critical path). |
| 7 | `resource-aware-scheduling` | Computes critical-path priorities (bottom levels) and flags write locks that don't vary per record, because those serialize every record. |
| 8 | `verification-placement` | Forces `verify-before-retry` on writes and warns when a write verifies on the page it edited or has no compare-and-swap guard. |

A **segment** is a maximal page chain on one app that one worker runs back to back. Segment
formation keeps three invariants:

- A segment contains at most one remote write, and the write is its last node. A retry after
  reconciliation therefore never repeats an earlier, already-committed write.
- A node joins its app's open chain only if it continues that page and the segment graph stays
  acyclic.
- Pure computations at join points become browser-free `compute` segments.

Segments are templates. The scheduler instantiates one task per record when a phase becomes
ready ("late foreach expansion"), so a phase can iterate over the outputs of an earlier phase.

## Safety gates

Overclock never trades a gate for speed. The gates fall into three layers.

**Compile time (Working, tested).** The compiler refuses to produce a program when any of
these hold: a step references a control nobody observed, a click targets a control classified
as a write, a write lacks declared resources or read-back verification, a write has retry
policy `safe`, an irreversible node lacks required approval, an app origin is not
allowlisted, an expression is outside the closed language, a `foreach` has no key or no
iteration bound, `$rec` appears outside a `foreach`, a phase reads `$phase.<id>` without
depending on it, or the dependency graph has a cycle. The full list is in
[`ACTION_IR.md`](ACTION_IR.md#validation-rules).

**Run time (Working, tested).** Every browser context enforces the origin allowlist.
Exploration contexts block every mutation. Execution pages are read-only while they run a read
segment: non-GET requests and risky GETs are aborted (`tests/integration/runtime.test.ts`).
Locator resolution refuses ambiguous targets. Irreversible nodes stop at `NEEDS_APPROVAL`. See
[`SECURITY.md`](SECURITY.md).

**Review gate (Working, tested).** When the policy requires a critique (modes D and E with more
than five records), `reviewPlan` (`packages/swarm/src/review.ts`) decides whether a plan's
writes may run: a critique of that exact plan must report no high-severity finding; findings
get one repair round, and the repaired plan is critiqued again. An unavailable critique, a
failed repair, or findings left after the repair reject the plan and fail the run with the
reason; every round is a `review` event. `tests/integration/review-gate.test.ts` runs both
pipelines against a fixture app with a scripted model, including the three paths that used to
skip the gate (a repaired plan after a streaming fallback or a critique in mode E, and a
candidate whose repair failed in mode D).

**Release gates (Partial).** In mode E, each segment template has a gate in the scheduler:

- `open`: every record's task may run.
- `canary`: one task at a time runs until one succeeds, then the gate opens.
- `deferred`: nothing runs until a safety condition clears.

The exact rules mode E applies are in [Cold-start pipelines](#cold-start-pipelines).

## Execution correctness

**Status: Working (tested).** The scheduler, locks, AIMD, read-back, and uncertain-write
detection are tested in isolation (`tests/unit/scheduler.test.ts`,
`tests/integration/runtime.test.ts`). The executor that combines them is tested end to end on
a fixture app with real perception, lowering, and compilation
(`tests/integration/entry-verification.test.ts`): successful, duplicate, rejected, and
ambiguous submissions, and the invalidation rule below.

### Task states

A task moves through `PENDING → READY → LEASED → RUNNING → VERIFYING → VERIFIED` (or
`COMPLETED` for reads). Side states are `REPAIRING`, `RECONCILING`, and `SUSPENDED`. Terminal
states are `VERIFIED`, `COMPLETED`, `FAILED`, `UNCONFIRMED`, `SKIPPED`, `NEEDS_APPROVAL`, and
`CANCELLED`. When a task fails terminally, its dependents are `SKIPPED`.

An irreversible step that needs approval is **parked** in `NEEDS_APPROVAL`: its locks are
released, its dependents keep waiting, and its phase stays open. Approving it puts it back in
the ready queue; rejecting it, or no decision within `OVERCLOCK_APPROVAL_WAIT_MS` (default 10
minutes), makes `NEEDS_APPROVAL` final and skips its dependents.

### Leases and the watchdog

A worker leases the highest-priority ready task whose app is under its concurrency cap and
whose locks are free. Priority is records in input order, and within a record the segment with
the longest remaining path (bottom level) first (`recordFirstPriority`), so records complete
progressively. Ordering by bottom level across all records ran every record's first read before
any record wrote: on warm 500-record runs the first verified write came at 6.4–6.6 s instead of
0.8–0.9 s, with the same wall time. `ablation.criticalPathPriority: false` orders by record only. The lease lasts `max(30 s, 8 × estimated segment time)`. Every 2 s a
watchdog finds expired leases and crashes the stalled worker's pages, so the task's own error
path runs, then extends the lease to avoid double handling.

### Locks

Each write segment declares resource keys such as `app:support:ticket:{$out.find.ticketId}`.
At lease time the scheduler renders the keys with the record's scope and acquires all of them
atomically, or none. A key it can't render becomes a prefix lock (`app:support:ticket:*`),
which is conservative. Two tasks holding the same key never run at the same time. Conflicts
emit `lock.conflict`.

The compiler also adds `page:<app>:<path>` resources for pages a write changes and pages a read
loads, so dependency analysis orders a record's read-after-write correctly.

### Compare-and-swap guards

A `submit` step lists guards: for each field it changes whose earlier value it read, the edit
form's current value must still equal the value read earlier. The compiler attaches guards to
the first interaction after the edit page loads, so they see the form before any fill changes
it. A failed guard raises `PreconditionFailedError`, which triggers invalidation.

### Read-back verification

After a write, the worker navigates fresh to the verification URL (never the form it
submitted) and compares each expected field. Values are whitespace-normalized. A field matches
when it is loosely equal (numbers and numeric strings compare equal) or equal ignoring case.
There is no substring matching. A mismatch raises `VerificationFailedError`.

Two rules make appended entries (notes, comments, log lines) verifiable without false
positives:

- **Exactly one matching entry.** Perception records a titled region with no form fields,
  definition lists, or tables (for example an "Internal notes" section) as one fact with role
  `region`. Verification against a region fact counts the region's innermost list items outside
  forms (or treats a region without a list as one entry) and passes only when exactly one entry,
  or an element inside it, has text equal to the expected value. An empty list, a longer entry
  that merely contains the text, a draft left in a form field, and the same text in another
  region don't match. Two or more matches is a **duplicate**.
- **Same entity.** The verification page must show the entity ids of the page the write
  targeted (the segment's last navigation before the write): a write on `/tickets/T-1/edit`
  can't be verified on `/tickets/T-2`.

A duplicate or a different entity fails the write without a retry, because another write can
only make the state worse.

### Uncertain writes and reconciliation

A write whose request returned 5xx, failed at the network layer, or got no response is
**uncertain**: it may or may not have committed. A worker crash after the write click is
treated the same way. The executor never retries an uncertain write blindly. It reconciles:

1. Load the verification page and compare.
2. If the state matches, record `VERIFIED` without a second write.
3. If the read-back shows a duplicate entry or a different entity, report `FAILED` without
   retrying.
4. If it doesn't match and the node's policy is `verify-before-retry`, retry with backoff (up
   to 3 attempts).
5. Otherwise report `UNCONFIRMED`.

A 429 or a 4xx response means the write was rejected before commit, so it is safe to handle
as a rejection.

### Invalidation

When a compare-and-swap guard fails or the app answers 409 (stale version), the data the write
was computed from has changed. The scheduler resets the write task and every upstream task of
the same record that is not a write and not already verified, discards their outputs, and
re-queues them so they read fresh state. Verified writes are never re-executed. A write task
that is still stale on its third attempt fails.

Invalidation is refused when a verified write of the same record used any of the reads it
would recompute. Re-reading after that write would decide again from the state the write
already changed. In a live run, that path skipped a record's note and still reported the
record `VERIFIED`. The task now fails instead
(`tests/integration/entry-verification.test.ts`, "regression: …").

### Failure handling

| Error | Executor response |
| --- | --- |
| Throttled (429 on a page or a write) | Report to AIMD; retry with backoff (base 800 ms), up to 6 attempts. |
| Navigation error or timeout | Retry with backoff (base 400 ms), up to 3 attempts. |
| Guard failure or 409 | Invalidate and re-read. |
| Uncertain write, or a crash after the write point | Reconcile by read-back. |
| Read-back mismatch | Retry up to 2 attempts, then `FAILED` with a receipt. Under a canary gate, two failures block the template. |
| Read-back duplicate entry or different entity | `FAILED` with a receipt, no retry. |
| Write blocked by the read-only guard | `FAILED`: a read fragment attempted a write. |
| Other 4xx on a write | `FAILED` (rejected). |
| Unrepaired locator or dialog failure | `NEEDS_APPROVAL` (escalated after recovery). |
| Irreversible node not approved | `approval.requested`, then parked in `NEEDS_APPROVAL` until approved, rejected, or expired. |
| Crash before any write | Retry after 200 ms. |

Backoff is `min(8 s, base × 2^(attempt − 1))` with ±25% jitter.

### Execution throughput

Measured on warm 500-record runs (no model calls), the limit was never the arena or the browser
pages: it was the engine's single Node thread and Chromium's main process, which every worker's
protocol traffic passes through. With one worker an action takes 6–20 ms; with 16 workers sharing
one browser and one thread it took 23–172 ms. What runs now:

- **Several browser processes** (`OVERCLOCK_BROWSERS`, default 4); a new worker context goes to
  the browser with the fewest open contexts.
- **Each behind its own Playwright server process** (`OVERCLOCK_BROWSER_SERVERS`, default on in
  the engine), so Playwright's server side runs on other cores. The route guard (allowlist,
  read-only pages, risky GETs) still runs in the engine for every request: route handlers are
  client side.
- **Fewer browser calls per action:** all fields of an extraction or a verification whose
  top-ranked strategy is an XPath (label-anchored facts) are resolved and read in one page call,
  with the semantics of Playwright's XPath engine (`document.evaluate`, element nodes only);
  other fields and click targets check "exactly one element matched" (and, for targets,
  visibility) in the same call that reads or locates them. A field or target that doesn't match
  exactly one element takes the full resolution path unchanged.
- **Single-page tables in one round of calls:** a table read issues, at the same moment, one call
  that matches and reads the table and one per strategy of its "next" control. The rows are used
  only for what the full path would decide on its first probes: the table's top strategy matched
  one element with rows and every column, and "next" resolves (first strategy with exactly one
  match, every earlier one with none) to a disabled control. An empty or still-rendering table,
  an ambiguous or missing control, a scoped locator, or a further page takes the full path. The
  two search reads per record dropped from 73 ms to 26 ms each. A collection field's entry count
  during verification is likewise one call when its top strategy matches one region.
- **One selector-engine setup per page at most.** Playwright sets up its injected selector
  engine once per document in each JavaScript world it uses, about 10 ms each: a page load costs
  about 4.5 ms, a load plus one locator call 15 ms, plus locator calls in both worlds 32 ms
  (uncontended). Actions run in Playwright's utility world, so a target's fast check is a strict
  `isVisible` (also utility world) rather than an evaluation in the page's main world; a fill
  tries text first (Playwright refuses a checkbox or radio at once, changing nothing) and asks
  what the element is only then; XPath reads and XPath entry counts use plain page evaluations,
  which need no selector engine. Order and verification pages now set up none, edit pages one,
  search pages one.
- **A faster cost simulation:** the list-scheduling simulator inserts newly ready tasks into its
  priority order instead of re-sorting the ready list at every event (a unit test checks it
  against the old algorithm). Choosing workers for 500 records took 270–320 ms and takes 65–120 ms.
- **No lingering waiters:** a write's response, network failure, and timeout are page listeners
  removed as soon as the write settles.
- **Constant-time scheduler counts** (active tasks per app).
- **Grouped commits for observability events** (worker states, browser actions), described in
  the store's durability note; task states and receipts are still committed before
  `appendEvent` returns.
- **No source-mapped stack traces** in the engine (`OVERCLOCK_SOURCE_MAPS=1` restores them):
  Playwright captures a stack for every browser call, and mapping it was the largest single cost.
- **A warm start for the first run:** the engine launches its browser pool when it starts
  (`OVERCLOCK_WARM_BROWSERS=0` launches on first use), logs in to every app concurrently, and
  logs the operator and explorer sessions in at the same time; a network import waits only for
  the operator session. Rebinding crawls the apps concurrently, one page each. For a runtime
  importing a capability, these cut the run from 3.3 s to 2.05 s (median, 5 seeds;
  [`NETWORK.md`](NETWORK.md#results)).

After these changes the machine is the limit: during a warm 500-record run it is 80–83% busy,
mostly in Chromium loading and rendering about 3,300 pages (one request each; the arena itself
uses 7–11% of a core and serves over 10,000 pages a second in isolation). More workers than about
16 don't help, and two engines splitting the records finish no sooner. Disabling the GPU process
(`--disable-gpu --disable-software-rasterizer`) measured slower (16.5 s against 14.8 s median)
and isn't used. With the single-page table reads, a warm 500-record run took a median 13.3 s
against 14.8 s for the previous code, in trials alternated between two engines under the same
machine load (3 each, all 500/500); the first verified write came at 6.6 s instead of 8.2 s.

Measured and not done:

- **Reading the redirect page instead of loading the verification page.** After a write, the
  arena redirects to the record's page with a flag (`/tickets/T-1?saved=1`), not to the exact
  verification URL. Accepting a different query would let a page whose content depends on the
  query stand in for the record's page, so every write is still verified by a fresh load of the
  exact URL.
- **Not waiting for the write's redirect to commit** (Playwright's `noWaitAfter`), since the
  verification replaces that page anyway. Chromium lets the pending form navigation commit over
  a later page load, so the verification load was interrupted, twice in a row in tests. Stopping
  the redirect first with the DevTools protocol's `Page.stopLoading` failed differently: the
  DevTools session detached when the submission moved to a new page target. The click therefore
  still waits for the redirect, which rules out both races.
- **Skipping the route guard for plain GETs.** Interception costs about 1 ms per page load, and
  route patterns match URLs, not methods, so excluding GETs would also let a read-only page's
  POST through.
- **No selector engine on search pages either.** Search pages need role and text strategies to
  find "next", and reproducing those engines outside Playwright isn't worth the risk of a wrong
  last-page decision, so they keep one setup.
- **A shorter viewport.** 16 concurrent pages loading arena pages ran 224–228 pages a second at
  both 1280×860 and 1280×400, so drawing area isn't the cost. That rate is also the ceiling: a
  warm 500-record run needs about 3,700 page loads and already sustains about 300 a second across
  4 browsers, so only fewer page loads would make it much faster.
- **Dropping the page-lifetime network listeners** that `settle()` counts requests with: 16
  routed pages loaded 293–311 pages a second with them and 296–301 without, so they cost nothing
  measurable.
- **More workers or browsers.** Alternating trials on the current code: 4 browsers with 16 workers
  (the defaults) ran 13.1 s and 14.6 s; 24 workers 13.5 s and 14.8 s; 8 browsers 14.5–15.4 s.
- **Starting the holds phase before the order writes finish.** Holds reads only the orders'
  decisions, but a write's freshness check can invalidate a record and recompute its decision;
  the phase barrier is what keeps holds from writing from a stale aggregate.
- **Serving searches from a list scan.** The list tables carry the search results' columns, but
  a scan can't prove it returns the rows the server's search would.

### Adaptive concurrency (AIMD)

Each app gets its own additive-increase, multiplicative-decrease controller. Every 2.5 s
window it compares throughput and median latency with the previous window:

- It starts in slow start: it doubles the limit after each healthy window until the first
  congestion signal, then adds one slot per healthy window (error rate at most 25%).
- Only windows in which most completions found the app at its limit count. A window in which
  the app had idle slots (no more work was ready) neither signals congestion nor grows the
  limit, and isn't used as the baseline for the next comparison.
- When median latency rose more than 25% without at least 3% more throughput, it holds,
  because the extra load is queueing at the server rather than doing work.
- After two throttles (429s or timeouts) in a window, or an error rate above 25%, it halves the
  limit and cools down for two windows.

The worker pool grows to match the caps, up to `maxWorkers`.

### Record outcomes

A record's outcome is its worst task state: `UNCONFIRMED` dominates `FAILED`, which dominates
`NEEDS_APPROVAL`. A record whose write segments were all correctly skipped (no change needed)
is `SKIPPED`. `VERIFIED` means every write for the record was read back and matched.

## Recovery levels

**Status:** L0, L1, and L4 Working (tested) in `tests/adversarial/recovery.test.ts`; L2 and L3
Partial (live tests exist behind `OVERCLOCK_LIVE=1`).

Recovery runs inside `runSegment` when a node can't find its target, finds it hidden, finds it
ambiguous, or is blocked by a dialog (including one already open after a navigation). It is
localized: it repairs one node of one segment template, and every other worker keeps running.

| Level | What it does | Model calls |
| --- | --- | --- |
| L0 | Apply a rule learned earlier in this run: a replacement locator, a tab to click first, or a dialog button. | 0, no observation |
| L1 | Observe the page once and match deterministically: renamed buttons, relabeled fields, controls moved behind a tab, informational dialogs, confirmation dialogs after a submit. | 0 |
| L2 | Ask Jev to choose among the observed candidates. Confidence must reach 0.7 for reads and 0.85 for anything that writes, with a margin of 0.5 for writes. | Jev |
| L3 | Ask Claude (the planner model) to recompile the failing node against the observation. Its answer must name a control in the observation and pass the same corroboration checks as L1. | Claude |
| L4 | Escalate to a person. The task ends in `NEEDS_APPROVAL`. | 0 |

Rules that keep recovery safe:

- An irreversible node is never repaired by a model. If its control was renamed, a person
  must confirm the new one.
- A dialog that describes an irreversible action is never confirmed, and a dialog whose only
  action is destructive is never clicked.
- A dialog that asks for input escalates.
- When two candidates are equally plausible and no model is available, recovery escalates
  instead of guessing.
- Concurrent workers hitting the same failure share one repair. While a model-assisted repair
  (L2 or L3) runs, the scheduler suspends leasing of that one segment template; other
  templates keep running.
- Each accepted repair becomes an L0 rule keyed by app, route pattern, and control (or dialog
  title). Later records reuse it with no observation and no model call.
- A run may spend at most 40 model calls on repair; beyond that, repairs escalate.

Rules live in memory for one run; they are not persisted. The vision fallback (Jev with a
screenshot) exists in the recovery engine but the engine does not enable it.

## Cost model and online optimization

**Status:** cost model and selection Working (tested) in `tests/unit/optimizer.test.ts`;
online latency updates and AIMD Partial (wired in the executor, untested there); access-path
substitution In progress (wired into mode E, untested); other strategy re-optimization
Proposed.

### Expected cost

```text
ExpectedCost = remaining model time
             + browser critical path      (list-scheduling simulation)
             + expected recovery time     (tasks × failure rate × repair cost / workers)
             + coordination overhead      (tasks × 1 ms; the coordinator is one event loop)
```

Verification time is part of the browser critical path; it is reported separately and not
counted twice. Each estimate lists which inputs were measured, estimated, or defaulted.

The **latency model** starts from defaults (250 ms per navigation, 450 ms per write) and is
seeded by page loads the scouts and dry-run probes measured. During execution it updates from
every action (exponentially weighted averages per app, per action type, and per segment).

The **simulator** runs an event-driven list schedule of the expanded task DAG: W identical
workers, per-app caps, phase barriers, the executor's task priority, and serialized per-run
constant locks.

**Worker choice.** `recommendWorkers` simulates 1, 2, 4, 6, 8, 12, 16, 24, and 32 workers (up
to `maxWorkers`) and picks the smallest count within 6% of the best makespan.

**Candidate selection.** The optimization scout ranks valid candidates by expected total time
and records the reason, for example "X is 41% faster than Y". A candidate whose dry run failed
is invalid.

### Online optimization

- **Latency updates and AIMD** run during every execution today.
- **Access-path substitution (In progress).** This is the query-optimizer idea applied to
  browser reads. In mode E, `AccessPathController` (`services/engine/src/accessPaths.ts`)
  watches every released fragment:
  1. `findAccessPathCandidates` flags per-record detail-read segments (navigate to
     `/entity/{key}`, then extract facts) that a list table could serve, when the table's rows
     link to the same detail route and its columns carry the same facts.
  2. After at least one detail read has completed, and at most every 1.5 s, it compares the
     measured cost of the remaining detail reads with the estimated cost of scanning the list
     pages at the app's current concurrency limit. It switches only when at least 5 records
     remain and the detail reads cost more than 1.2 times the scan.
  3. The scan runs through the normal scheduler as an optimizer-generated read fragment, with
     no model call.
  4. Before serving anything from the scan, it compares the scanned rows with up to 3 detail
     reads that already ran. Any difference, or no overlap to compare, disables the
     substitution.
  5. Once proven, the executor's `substitute` hook completes unstarted detail-read tasks from
     the scanned rows without a browser.

  Every decision, including "keep detail reads", is emitted as `reopt.decision` with its
  numbers. The `accessPaths` and `onlineReoptimization` ablation switches both disable it.
- **Other strategy re-optimization (Proposed).** Switching a running program to a different
  candidate strategy is not implemented.

## Cold-start pipelines

### Intelligence policy

`decidePolicy` decides how much discovery a staged run gets:

- Network import: a capability imported from the Overclock Network and rebound to this
  runtime's own observation is compiled and executed; no discovery swarm or planner call.
- Warm cache hit: reuse the cached plan and app models; no discovery or planning.
- Modes B and C: one planner, no catalogs, no critique, no dry run.
- 5 records or fewer: one planner plus a dry-run probe.
- Only one strategy available (or competitive synthesis disabled): one candidate with
  critique and probes.
- Otherwise: up to 3 competing candidates, one per strategy directive, plus operation catalogs
  when there is more than one app.

Two strategy directives exist today: `per-record` (always) and `list-scan` (when an app has a
paginated or long list table). So a run compares at most two candidates.

### Mode D: stage-gated (Working, measured)

`runStagedSwarm` runs each stage to completion before the next one starts:

1. **Discovery.** UI scouts crawl every app in parallel, breadth first, up to 14 pages and 2
   samples per route pattern, in mutation-blocked contexts. They dismiss informational dialogs
   and measure real page-load latency.
2. **Policy decision.**
3. **Effect classification** (Jev batched choices, more severe of model and heuristic wins) in
   parallel with **operation catalogs** (Claude Haiku), when the policy asks for them.
4. **Planning.** K candidates in parallel. Each one is generated, lowered, validated, and
   compiled, with one repair round on errors.
5. **Critique and dry run.** For each valid candidate, in parallel: an adversarial critique
   (Claude Haiku) and a dry run of its read segments for the first record in a
   mutation-blocked context. High-severity risks or a failed dry run trigger one repair round.
   The repaired plan is validated and compiled with every static check, but it isn't
   critiqued a second time.
6. **Selection.** The optimization scout estimates each candidate's cost and selects the
   fastest valid one.
7. **Execution.** The executor starts only after selection, with the recommended worker count.

The first browser action of execution happens after every earlier stage has finished, so
`overlapMs` is 0.

### Mode E: streaming (Working, measured)

`runStreamingPipeline` (`services/engine/src/streaming.ts`) runs end to end; see
[`BENCHMARKS.md`](BENCHMARKS.md) for measured runs. A recorded live planner stream is replayed
through the watcher and the incremental compiler in `tests/unit/stream-replay.test.ts`. Unlike
mode D, it plans a single strategy (the first directive, `per-record`)
instead of competing several, runs no dry-run probes, and uses critique only to gate writes. A
comparison of E with D therefore measures these differences together with the overlap. It works
as follows:

1. **First-pass discovery.** One sample per route pattern, up to 12 pages per app: enough to
   start planning.
2. **Background work.** Effect classification and a second, deeper discovery pass start in the
   background. The second pass reports locator stability; it doesn't change the plan.
3. **Empty executor.** The executor starts with no segments and up to 4 workers, in
   incremental mode.
4. **Streaming plan.** The planner's JSON streams through `PlanStreamWatcher`, which reports
   each phase header, each completed step, and each completed phase. Phase headers register
   phases with the incremental compiler and the scheduler. Each step is schema-validated,
   added to the incremental compiler, and the phase is re-lowered and re-segmented.
5. **Fragment release.** The incremental compiler releases a segment as a fragment only when
   all of the following hold:
   - The segment is closed: the stream has moved past its last step, it ends in a write, or its
     phase is sealed.
   - Every step in it lowered without errors (known controls, valid expressions, consistent
     effects).
   - Every segment it depends on was already released.
   - A segment that holds form fills or selects without their submit waits for the submit (or
     the phase seal), so the submit always joins the page it belongs to.

   Released fragments are immutable. A later step that continues a page an earlier read
   fragment loaded gets its own re-navigation; if that earlier fragment was not pure, the step
   is held back. Only safe passes run incrementally (dependency analysis and verification
   placement).
6. **Read fragments.** A read fragment enters the scheduler with a `canary` gate: one record
   runs first, and when it succeeds the fragment fans out to every record. While it runs, its
   page is read-only at the network layer.
7. **Write fragments.** A write fragment enters with a `deferred` gate. Meanwhile, as reads
   run, the access-path controller may replace the remaining per-record detail reads with a
   shared list scan (see [Online optimization](#online-optimization)).
8. **Whole-plan validation.** When the stream ends, the full plan is lowered and validated with
   the same checks the staged path runs.
9. **Write gates.** Writes stay deferred until every one of these holds:
   - every phase is sealed and the whole plan validated;
   - every step arrived as a valid fragment, and the planner's output needed no repair round;
   - side-effect classification finished, and nodes on controls classified irreversible were
     marked as requiring approval;
   - the critique passed with no high-severity risk (critique runs when there are more than 5
     records and Claude is available).
10. **Write canary.** Each write template then gets a `canary` gate: one record writes and is
    verified by read-back before the template fans out. Two canary verification failures
    block the template and reject the fragment. The `writeCanary` ablation opens the gate
    directly.
11. **Fallback.** If any write gate fails, the pipeline rejects every write fragment, cancels
    queued tasks, waits for running ones, asks the planner for a repaired plan, and runs it
    stage-gated. Reads that already ran had no side effects. If the repaired plan doesn't
    validate, the planner gets one more round with those validation errors only (the same
    bound as mode D); then the run fails. As in mode D, the repaired plan isn't critiqued
    again, so after a fallback its writes wait for validation and compilation, not a second
    critique.

**Where cold-start time goes (current code).** With Opus 5.5 fast mode for the planner and the
critique, a cold 25-record run spends about 13 s planning (about 5,000 output tokens at about
410 tokens/s; first token after about 1 s), 3.5–5 s on the critique, and a few seconds
writing; reads run while the plan streams. At 500 records, planning and critique take the first
22.5 s, the write canaries about 3 s, and the write fan-out about 17 s on 16 workers. See the
README's paired results.

**Where cold-start time went (morning of 2026-10-24).** The critique gate was the most common
fallback trigger. In the
strict A→B demo on 2026-10-24 (10 records, local arena), runtime A spent 36.8 s on the
streamed plan, with reads executing from 7.6 s, plus 8.2 s on the critique, plus 49.8 s on one
repair round. The repair was triggered by six high-severity findings. Two were real defects:
an email compared after normalizing only one side, and edit-form fields overwritten without
guards. Two were speculative: unverified pagination on a search, and a resubmitted form. Two
were false positives: valid `'out.step.field'` paths, and a ticket match the plan already
filtered by exact order id. Any one high-severity finding triggers the repair, so the gate
stays as strict as before; the measured cost of that strictness is the repair round.

Phases that depend on other phases (cross-record aggregates) expand only after those phases
finish, in both modes. Every stage emits `stage` events, scouts emit `scout.page`, and every
fragment transition emits `fragment` (`compiled`, `validated`, `canary`, `deferred`,
`released`, `rejected`). The dashboard's **Pipeline** panel draws the stages against wall time
so the overlap is visible, and the **Fragments** panel shows each fragment's gate.

## Network layer

**Status: Working (tested; recorded live A→B transfers on five seeds with a changed interface,
plus one refusal).** [`NETWORK.md`](NETWORK.md) has the design, status, setup, and results.

The Overclock Network shares **portable capabilities**: a Procedure DSL plan whose control
references are semantic, data-free control descriptors instead of observation-local ids. A
runtime looks up candidates by non-sensitive interface signatures, fetches one, verifies its
content hash, rebinds every control against its own live observation, and compiles it locally.
A capability reaches other runtimes only after sanitization, independent validation by a
different identity, and promotion through a state machine enforced by the SpacetimeDB module.

The engine calls the network only from the run controller (`services/engine/src/network.ts`),
never from browser workers:

- **Before discovery** (`network-read`, `network-read-and-contribute`): look up an ACTIVE
  capability by canonical operation and origins, fetch and hash-verify it, and rebind it with a
  mutation-blocked mini-crawl. If the rebound plan compiles and every write bound safely, the
  staged swarm executes it with policy `network-import` and no planner call. A submit button
  whose label changed may bind by structure (the only write button of a form whose fields all
  bound by label); its writes then run behind a write canary. Otherwise the run discovers cold. An unreachable or disabled network also means a cold run
  (`tests/unit/network-service.test.ts`).
- **After execution:** an imported capability gets a reuse report. With
  `network-read-and-contribute`, a run where every record verified exports the executed plan
  (with the same compiler-added guards) as a sanitized capability and proposes it.

## Limitations

- **E versus D is not a pure test of stage gating.** Mode E plans one strategy and runs no
  dry-run probes; mode D can plan competing candidates and probes them. Both gate writes on
  the same critique.
- **The gate is only as precise as its critic.** A false-positive finding costs a repair round,
  and one that survives the repair fails the run closed. With the Haiku critic this happened in
  one of three paired runs; the default Opus fast critic was consistent in the offline
  evaluation and in every recorded run since.
- **Idempotency decisions read region text.** A plan that skips an append when the notes
  already contain its text uses `contains()` on the region's text, so a longer unrelated entry
  that contains the text can cause a skip. Verification never accepts that case.
- **Access paths have no test.** Access-path substitution is wired into mode E only. Online
  re-optimization beyond access paths doesn't exist, so the `overclock-no-online-reopt`
  ablation rung measures the same thing as `overclock-no-access-paths`.
- **Some components run only in live runs.** The crawler, effect classification, and dry run
  have no automated tests of their own; the critique's judgement is measured only offline and
  in live runs (the review gate around it is tested with a scripted model).
- **Competition is narrow.** Only two strategy directives exist. Bulk-import operations are
  detected but not offered, because read-back verification covers one entity per write.
- **No nested loops.** A `foreach` inside a `foreach` is rejected.
- **Per-run learning.** Recovery rules and the latency model are not persisted between runs.
  The local program cache is.
- **Generic login.** Sign-in looks for a password field and a username-like field (an email or
  text input, or a field named like user or email). The holdout evaluation hit this: every run
  on the unfamiliar fourth app failed at sign-in. Apps with other login forms need their own
  sign-in support; `OVERCLOCK_APP_CREDENTIALS` supplies credentials, not a login flow.
- **Pattern-based redaction.** Event and config redaction matches key names and token shapes;
  it can miss secrets in unusual formats.

## Acceptance tests

| Check | Command or test | Status |
| --- | --- | --- |
| Mode E overlaps discovery with execution | `overlapMs` from `stage` events (`tests/integration/engine-api.test.ts`). Live: 88–105 s median overlap in the benchmark (`docs/BENCHMARKS.md`, "Where time goes"). | Working (measured) |
| E versus D, all cold-start overhead counted | `pnpm exec tsx packages/benchmarks/src/cli.ts --suite all --only overclock,overclock-staged,compiled-parallel,compiled-single` | Measured: E 1.4–2× faster than D at equal accuracy; E slower than C |
| Time to first verified action is measured | `firstVerifiedMs` from the first `VERIFIED` receipt (`tests/integration/engine-api.test.ts`, `tests/unit/benchmark.test.ts`) | Working (tested, measured) |
| Holdout evaluated after a code freeze | `OVERCLOCK_HOLDOUT_FROZEN=<freeze-id> pnpm exec tsx packages/benchmarks/src/cli.ts --suite holdout`; the gate is tested in `tests/unit/benchmark.test.ts` | Evaluated once, freeze `freeze-2026-10-24-e14db0e-tree-b59e0e950646`: t3 (an unseen task on the known apps) 25/25 in all 6 runs; t4 (the unfamiliar fourth app) failed in all 6 runs at sign-in, before any write |
| A record is VERIFIED only when every write landed as planned | `tests/integration/entry-verification.test.ts` (appended entries, duplicates, rejected and ambiguous submissions, the invalidation regression); live: 0 verified-but-wrong records in 34 benchmark runs | Working (tested, measured) |
| Judge-induced UI change triggers recovery without duplicate writes | `pnpm test:adversarial` on a fixture app (every surprise, repair reuse, exactly one write per record). Live: a mode E run with the Support save buttons renamed 15 s in finished 10/10 with 0 duplicate writes; the renamed button resolved through a lower-ranked locator (tier 2) with no model call. | Tested on a fixture app; one live run, where recovery levels above L0 weren't needed |
| Two independent runtimes transfer a capability via SpacetimeDB | `pnpm network:demo` (exits non-zero unless both runtimes pass the arena checker, B imported and executed the capability, and B made no planner call); client level in `pnpm test:network` | Working (one recorded run) |
| Network-disabled or unreachable operation | `tests/unit/network-service.test.ts` (no client, cold discovery), `tests/network/disabled.test.ts` | Working (tested) |
| A–E produce comparable records | The harness checks seed, template, record count, and dataset hash before each run (`tests/unit/benchmark.test.ts`) | Working (tested); A not run this round |
| The compiler rejects unsafe programs and repairs unsafe guards | `tests/unit/compiler.test.ts` | Working (tested) |
| Uncertain writes are reconciled, not repeated | `tests/integration/runtime.test.ts`, `tests/integration/entry-verification.test.ts` (after-commit 500, before-commit 503) | Working (tested) |
| A stalled model stream can't hang a run | `tests/unit/model-stall.test.ts` | Working (tested) |
| Read fragments can't write | Exploration-context blocking in `tests/integration/runtime.test.ts`. Per-page read-only mode in execution contexts has no test. | Partial |
