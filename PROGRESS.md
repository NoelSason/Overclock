# Progress

Status of the Overclock Cal Hacks build on 2026-10-24 (about 13:30 PDT). When this file and the
code disagree, the code wins.

Labels: **Working (tested)** means automated tests cover it. **Working (measured)** means
recorded live runs exercise it and pass the arena's ground-truth check. **Partial** means it
is implemented with a known gap. **Proposed** means design only.

## Milestones

| Milestone | Status | Evidence and gaps |
| --- | --- | --- |
| Contracts, Procedure DSL, expression language | Working (tested) | `tests/unit/expr.test.ts` (now with arithmetic), `tests/unit/compiler.test.ts` |
| Compiler: lowering, validation, 8 passes, segments | Working (tested) | `tests/unit/compiler.test.ts`: dropped self-defeating guards, compiler-added guards, page re-opening when an action needs a decision from its own page's reads |
| Incremental compiler and plan stream watcher | Working (tested) | `tests/unit/incremental.test.ts`, `tests/unit/plan-stream.test.ts`, `tests/unit/stream-replay.test.ts` (a recorded live planner stream) |
| Scheduler, locks, invalidation, AIMD, approval parking | Working (tested) | `tests/unit/scheduler.test.ts`. Canary and deferred gates have no unit test; live runs use them. |
| Optimizer: latency model, simulator, cost, worker choice | Working (tested) | `tests/unit/optimizer.test.ts` |
| Browser runtime: guards, locators, actions, read-back | Working (tested) | `tests/integration/runtime.test.ts`, `tests/integration/perception.test.ts` |
| Appended-entry verification (exactly one matching entry, same entity) | Working (tested) | `tests/integration/entry-verification.test.ts` |
| Executor: reconciliation, duplicates, retries, invalidation after a committed write | Working (tested) | `tests/integration/entry-verification.test.ts`, including the regression for a record reported `VERIFIED` whose note never ran |
| Recovery L0/L1/L4, repair dedupe | Working (tested) | `tests/adversarial/recovery.test.ts` (fixture app) |
| Recovery L2 (Jev) and L3 (Claude) | Partial | Live tests behind `OVERCLOCK_LIVE=1`; not run |
| Engine store, HTTP API, SSE, restart recovery | Working (tested) | `tests/integration/engine-api.test.ts` |
| Model-stream stall watchdog | Working (tested) | `tests/unit/model-stall.test.ts`. Added after a repair request hung for 38 minutes during a network outage. |
| Mode A sequential baseline | Working (tested) | `tests/integration/baseline.test.ts` with a scripted model; not benchmarked in this round |
| Modes B, C, D, E | Working (measured) | `docs/BENCHMARKS.md`. Morning round: 34 runs, E 1.4–2× faster than D and slower than C. Afternoon paired runs on the current code: E (fast) 18.7–21.6 s for 25 records, about C (fast) at 16.1–20.5 s; 500 records in 42.3 s, 500/500. |
| Claude fast mode (planner and critic) | Working (tested, measured) | `tests/unit/fast-mode.test.ts`: speed on every request path, fallback to standard on 429/529/overloaded/unsupported, no replay after streamed text reached the consumer, pricing by the speed the response reports. Default since the paired runs. |
| Review gate before writes (fail-closed) | Working (tested) | `tests/unit/review.test.ts`, `tests/integration/review-gate.test.ts` (modes D and E against a fixture app with a scripted model; the fallback tests fail on the previous pipeline) |
| Input-record accounting (`recordsVerified`) | Working (tested) | `tests/unit/record-accounting.test.ts`, the multi-phase test in `tests/integration/entry-verification.test.ts`, `tests/unit/benchmark.test.ts` |
| Holdout evaluation | Done once, after a freeze | Freeze `freeze-2026-10-24-e14db0e-tree-b59e0e950646`. t3 (unseen task): 25/25 in all 6 runs. t4 (unfamiliar app): all 6 runs failed at generic sign-in, before any write. Not re-run after any fix, so the result stays a clean holdout. |
| Live recovery on the arena | One run | Support save buttons renamed mid-run: 10/10, 0 duplicates; resolved by a lower-ranked locator, no model call |
| Read-only pages block risky GETs | Working (tested) | `tests/integration/runtime.test.ts` (browser level; fails without the fix) |
| Saturation-aware adaptive concurrency | Working (tested) | `tests/unit/scheduler.test.ts` (demand-limited windows) |
| Execution throughput (browser pool, browser server processes, one-call reads, grouped observability commits) | Working (tested, measured) | `tests/integration/event-durability.test.ts`, `tests/integration/runtime.test.ts` (client-rendered and empty tables); warm 500-record runs in `benchmarks/results/warm/` (`scripts/warm-bench.ts`) |
| Online access-path substitution | Partial | Wired into mode E; no test |
| Other online re-optimization | Proposed | Not implemented |
| Arena apps, judge console, surprises, checker | Working (tested) | `tests/integration/arena.test.ts`, `tests/unit/arena-oracle.test.ts` |
| SDK and CLI (`--knowledge` added) | Working (tested) | `tests/unit/sdk.test.ts`, `tests/integration/sdk-*.test.ts` |
| Dashboard | Working (tested) | `tests/e2e/dashboard.spec.ts`; see Test runs for this round |
| Benchmark harness, suites, report, holdout freeze gate, `--only` | Working (tested) | `tests/unit/benchmark.test.ts` |
| Network capability layer and validation worker | Working (tested) | `pnpm test:network-capability` |
| SpacetimeDB module and network client | Working (tested) | `pnpm test:network` against a real local SpacetimeDB |
| Engine integration with the network | Working (measured) | `pnpm network:demo`: one run with every acceptance check passing ([`docs/NETWORK.md`](docs/NETWORK.md#results)) |
| Network-warm vs strict-cold comparison | Working (measured, 5 seeds) | `benchmarks/results/network/`: with every save button renamed between A and B, B 3.3 s median vs strict-cold C 18.8 s, all runs 10/10; plus a local warm-replay arm |
| Changed-UI transfer (structural rebinding behind a write canary) | Working (tested, measured) | `tests/network-capability/rebind.test.ts` (renamed button: canary-gated; irreversible or tab-hidden: refused); 5 of 5 seeds in `pnpm network:demo --variation rename-save`; refusal recorded with `--variation fields-in-tab --expect-refusal` |
| Dashboard Transfer page | Working (manually checked) | `/transfer` renders the recorded demo reports; checked in a browser. No e2e test. |
| Engine-started network repair | Proposed | Client-level repair leases are tested; the engine doesn't start repair jobs |
| One-command dev start (`pnpm dev`) | Working | `scripts/dev.ts` |

## Bugs found by live runs this round, and their fixes

| Symptom in a live run | Cause | Fix and test |
| --- | --- | --- |
| Mode E fell back on every run | `formSegments` crashed on segments released earlier in the stream | `segments.ts`; `tests/unit/stream-replay.test.ts` |
| A record was `VERIFIED` but its note was missing | A self-defeating guard failed; invalidation re-ran reads after the record's first write committed; the decision then skipped the note | Guards that expect their own write are dropped; invalidation is refused after a committed write; `tests/integration/entry-verification.test.ts` |
| Notes couldn't be read or verified | Perception didn't see titled lists | Region facts; exactly-one-entry verification; `tests/integration/perception.test.ts` |
| A repaired plan crashed the compiler ("page chain would form a cycle") | Read, decide, act on the same page | Page re-opening; `tests/unit/compiler.test.ts` |
| A repaired plan was invalid and mode E failed | `len(...) - 1`: no arithmetic in the language; no validation repair round in mode E | Arithmetic; one bounded validation round, as in mode D |
| Every published capability failed validation (integrity) | The hash covered `publisherId`, which the client replaces | Export with the publisher's identity; `tests/network-capability/capability.test.ts` |
| Validation failed (no probe record) | `{encode($rec.orderId)}` path templates weren't recognized | `pathTemplateFor`; `tests/network-capability/capability.test.ts` |
| Validation failed (missing guards) | The plan overwrote fields it had read without guards | Compiler-added guards, also in the published plan; `tests/unit/compiler.test.ts` |
| 5 of 25 records FAILED ("stale repeatedly") in a benchmark trial | The planner guarded edits with the target values it was about to write | Guards with computed values are dropped; compiler-added guards use only reads taken before the form changed; `tests/unit/compiler.test.ts`. The benchmark was restarted from scratch on the fixed code. |
| The validator never saw a proposal | Proposals made before the worker started were ignored | Backlog scan (`versionsInState`) |
| A runtime could lose its identity | The token save wasn't awaited on close | `close()` awaits it; `pnpm test:network` passed 3 runs in a row |
| A benchmark run hung for 30 minutes | A model stream stalled during a network outage | Stall watchdog; `tests/unit/model-stall.test.ts` |
| Warm benchmark repeats never hit the cache | Cold runs didn't store their plan | Every run stores its final plan; only `local-only` and network policies read it |
| (Found by test, not seen in a recorded run) Form fills could be released as a fragment before their submit when another step streamed in between, forcing a fallback | The release rule treated any segment the stream had moved past as complete | A segment with fills waits for its submit or the phase seal; `tests/unit/incremental.test.ts`. Added after the benchmark and the final demo, neither of which fell back for this reason. |
| Repaired plans wrote without a critique (mode E after a streaming fallback or a critique; mode D after a failed repair kept the high-risk candidate) | The review ran once, before any repair | `reviewPlan` gates every write path and re-critiques repaired plans; fail-closed; `tests/integration/review-gate.test.ts` |
| A read fragment could follow a state-changing GET (`/logout`) | The risky-GET screen applied only to exploration contexts | Applied to every read-only page; `tests/integration/runtime.test.ts` |
| "Engine-verified 108%" in a benchmark report | Outcomes of derived records (a customer to hold) counted as input records | Outcomes carry a scope; `recordsVerified` counts unique input records; older result files show n/a instead of a clamped value |
| Every fast-mode run needed a repair round, and some failed closed | Plans matched CRM emails against a lowercased order email; the language couldn't normalize the list side | `filterBy(list, 'field', '~=', value)`; `tests/unit/expr.test.ts`. The critique then passed the same recorded plan 3/3 (0/3 before). |
| The critique truncated and retried (about 14 s lost) | A 3,000-token budget for thinking plus the coverage list | 8,000 first, 16,000 on retry |
| Seed 2222's first demo attempt: A's capability failed the validator's static analysis | Not recorded | The engine now runs the same analysis before publishing and records the reason; the rerun passed |
| (Found while documenting, before any run used it on a network) The new browser server processes listened on every interface | Playwright's `launchServer` default | Bound to 127.0.0.1 |
| (Found by review, not seen in a recorded run) A request for "rejected" could reuse a plan or capability learned for "approved" | The operation identity hashed a lossy goal (quoted values and numbers replaced by placeholders), for network lookup and the local plan cache; the importer took the top candidate without checking | The identity hashes the exact instructions and record schema (`op2:`); lookups return exact matches only; the importer re-checks the fetched artifact; static analysis rejects old identities; cache entries must match their key. `tests/unit/operation-identity.test.ts`, `tests/network-capability/operation-identity.test.ts`, and the demo's `--conflict-arm` (zero writes) |

## Test runs for this round

Run on 2026-10-24 (evening) on the final source, with `OVERCLOCK_LIVE` unset (no model calls)
unless noted.

| Command | Result |
| --- | --- |
| `pnpm typecheck` (workspace and dashboard) | Passed |
| `npx vitest run --project unit` | 159 passed |
| `npx vitest run --project integration` | 127 passed, 2 skipped (live) |
| `npx vitest run --project adversarial` | 13 passed, 4 skipped (live model tiers) |
| `pnpm test:network-capability` | 34 passed |
| `pnpm test:network` | 26 passed |
| `pnpm test:e2e` | 1 passed, beside a developer's dashboard dev server on :3000 |
| `pnpm network:demo --records 10 --variation rename-save --warm-arm` (live, spends money) | Every check passed on seeds 4242, 1111, 2222 (rerun), 3333, 7777; seed 2222's first attempt failed at validation |
| `pnpm network:demo --records 10 --seed 5151 --variation fields-in-tab --expect-refusal --no-cold-arm` (live) | Every check passed: B refused, planned cold, 10/10 |
| `pnpm network:demo --records 10 --seed 4242 --no-cold-arm` (live) | Every check passed: A 22.5 s, B 3.1 s (`EXACT_COMPATIBLE`), both 10/10 |
| `pnpm network:demo --records 10 --variation rename-save --conflict-arm --no-cold-arm` (live) | Every check passed at 13:17 (A cold) and at 13:40 on the final code (A reused its own cached plan, no model spend): X made zero writes, B 10/10 |
| `tsx scripts/warm-bench.ts --records 500 --workers 16 --trials 3` (no model calls) | Median 17.2 s, 500/500 in every trial |
| Benchmarks `--mode overclock` / `--mode parallel`, fast and standard, 25 records; `--mode overclock --records 500` (live) | `docs/BENCHMARKS.md`, suites `modes@e2-*`, `modes@c-*`, `modes@scale-fast` |

Model spend on 2026-10-24 after noon: about $17.9 (benchmarks $7.1, network demos $7.6 including
the failed seed-2222 attempt, offline critique evaluations $1.8, three unplanned cold runs after
the operation-identity change invalidated the warm cache $1.3, smoke tests $0.1), for a running
total of about $49–50 against the $50 budget. No further model calls were made. The Stagehand
baseline was not run.

## Known gaps

See the Known limitations sections in [`README.md`](README.md#known-limitations) and
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#limitations).
