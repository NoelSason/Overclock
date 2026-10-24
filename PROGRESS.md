# Progress

Status of the Overclock Cal Hacks build on 2026-10-24 (about 00:50 PDT). The code changes
quickly; when this file and the code disagree, the code wins.

Labels: **Working (tested)**, **Partial** (implemented, untested end to end or with a known
gap), **In progress**, **Blocked**, **Proposed** (design only).

## Milestones

| Milestone | Status | Evidence and gaps |
| --- | --- | --- |
| Contracts, Procedure DSL, expression language | Working (tested) | `tests/unit/expr.test.ts`, `tests/unit/compiler.test.ts` |
| Compiler: lowering, validation, 8 passes, segments | Working (tested) | `tests/unit/compiler.test.ts`. The locator-reuse pass only reports; no runtime cache exists. |
| Incremental compiler and plan stream watcher | Working (tested) | `tests/unit/incremental.test.ts`, `tests/unit/plan-stream.test.ts` |
| Scheduler, locks, invalidation, AIMD | Working (tested) | `tests/unit/scheduler.test.ts`. Canary and deferred gates have no unit test. |
| Optimizer: latency model, simulator, cost, worker choice | Working (tested) | `tests/unit/optimizer.test.ts` |
| Browser runtime: guards, locators, actions, read-back | Working (tested) | `tests/integration/runtime.test.ts`, `tests/integration/perception.test.ts`. Per-page read-only mode has no test. |
| Recovery L0/L1/L4, repair dedupe | Working (tested) | `tests/adversarial/recovery.test.ts` |
| Recovery L2 (Jev) and L3 (Claude) | Partial | Live tests exist behind `OVERCLOCK_LIVE=1`; not run. |
| Engine store, HTTP API, SSE, restart recovery | Working (tested) | `tests/integration/engine-api.test.ts` |
| Executor (leases, reconciliation, invalidation, watchdog) | Partial | Exercised only by live runs; no automated test. |
| Mode A sequential baseline | Working (tested) | `tests/integration/baseline.test.ts` with a scripted model |
| Modes B, C, D (staged swarm) | Partial | Implemented. Mode C has completed runs in local development; no automated end-to-end test. |
| Mode E streaming pipeline | In progress | `services/engine/src/streaming.ts` landed; not yet run end to end. |
| Online access-path substitution | In progress | Wired into mode E (`services/engine/src/accessPaths.ts`); no test. |
| Other online re-optimization | Proposed | Not implemented. |
| Approvals for irreversible steps | Partial | Requests work; approved steps don't resume (bug). |
| Arena apps, judge console, surprises, checker | Working (tested) | `tests/integration/arena.test.ts` (1 stale failure), `tests/unit/arena-oracle.test.ts` |
| SDK and CLI | Working (tested) | `tests/unit/sdk.test.ts`, `tests/integration/sdk-*.test.ts` |
| Dashboard | Working (tested) | `tests/e2e/dashboard.spec.ts` against the replay server; not run for this report. |
| Benchmark harness, suites, report, holdout freeze gate | Working (tested) | `tests/unit/benchmark.test.ts` |
| Benchmark results | In progress | `benchmarks/results/` is empty. Modes A–D can run now; E comparisons wait on a working mode E run. |
| Holdout evaluation | Blocked | Waits for a code freeze (`OVERCLOCK_HOLDOUT_FROZEN`). |
| Network capability layer and validation worker | Partial | `tests/network-capability/` passed; not used by the engine. |
| SpacetimeDB module and network client | In progress | `tests/network/` runs against a real local SpacetimeDB; not run for this report. |
| Engine integration with the network | Proposed | Not wired; network knowledge policies behave like cold runs. |
| Network-warm vs strict-cold benchmark arm | Blocked | Waits on engine integration. |
| One-command dev start (`pnpm dev`) | Proposed | `package.json` points at `scripts/dev.ts`, which doesn't exist. |

## Test runs for this report

Run on 2026-10-24 between 00:24 and 00:50 PDT, with `OVERCLOCK_LIVE` unset (no model calls).

| Command | Result |
| --- | --- |
| `npx vitest run --project unit` | 10 files, 112 tests passed |
| `npx vitest run --project adversarial` | 13 passed, 4 skipped (live model tiers) |
| `npx vitest run --project integration` | 70 passed, 1 failed, 2 skipped (live). `tests/integration/arena-holdout.test.ts` was added after this run. |
| `npx vitest run -c tests/network-capability/vitest.config.ts` | 3 files, 23 tests passed |
| `npx tsc -p tsconfig.json` | Passed |

Not run: `pnpm test:e2e`, the dashboard typecheck, `tests/network/` (needs the shared local
SpacetimeDB), any `OVERCLOCK_LIVE=1` test, and any benchmark.

## Known bugs and gaps

- Approving an irreversible step doesn't re-run it: `scheduler.retry` ignores tasks already in
  the terminal `NEEDS_APPROVAL` state.
- Mode E writes the local program cache but never reads it, so warm mode E runs repeat
  discovery and planning.
- `tests/integration/arena.test.ts` ("applies surprises and validates variation edits") still
  expects three apps. Its failure diff prints holdout app details, which exposes them to anyone
  running the integration suite.
- The locator-reuse pass reports a per-worker locator cache that the runtime doesn't have.
- Port collisions: the network endpoint default is moving from 3000 (the dashboard's port) to
  3100, which is the port `pnpm test:e2e` uses for its dashboard.
- The executor, staged swarm, crawler, effect classification, critique, and dry run have no
  automated tests.
