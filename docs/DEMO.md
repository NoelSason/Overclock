# Overclock demo

This page has a 90-second judging script, a 3-minute extended version, the setup they assume,
and a fast reset procedure. Every number you show must come from a real run or from
[`BENCHMARKS.md`](BENCHMARKS.md). If a number doesn't exist yet, say "results pending" and move
on.

> **Readiness (2026-10-24).** Mode E has not been run end to end yet, and the Overclock Network
> is not wired into the engine. Rehearse the full script at least once before judging. Each
> segment lists what to do if its feature isn't ready.

## Setup before judges arrive

1. Open four terminals in the repository root.

   ```bash
   pnpm arena        # terminal 1: judge console http://127.0.0.1:4100, apps :4101–4104
   pnpm engine       # terminal 2: engine http://127.0.0.1:4000
   pnpm dashboard    # terminal 3: dashboard http://localhost:3000
   pnpm cli health   # terminal 4: confirms the engine, models, browser, and arena
   ```

2. Record the baseline evidence ahead of time, on the same scenario the live run will use:
   - Run the benchmark suite you plan to cite, then `pnpm benchmark:report`. The dashboard's
     **Benchmarks** page (`http://localhost:3000/benchmarks`) and `docs/BENCHMARKS.md` then
     show the results. The suite spends model money; the report doesn't.
   - Or record one real baseline run, for example
     `pnpm cli run --scenario --mode compiled-parallel`, so its run page is available in the
     dashboard's **Runs** list. Run `pnpm cli check` right after it finishes and keep that
     output: the dashboard's checker grades the arena's current state, so it can't show a past
     run's accuracy after a reset.

3. Reset the arena so the live run starts clean:

   ```bash
   pnpm demo:reset   # seed 4242, t1-order-reconcile, 100 records; clears every surprise
   ```

4. Open three browser tabs:
   - Dashboard: `http://localhost:3000` (it shows the most recent run automatically).
   - Judge console: `http://127.0.0.1:4100`.
   - Benchmark results or the recorded baseline run.

5. Don't use the replay server in `tests/e2e/fixtures/`. It replays synthetic events for tests,
   and showing it as a live run would misrepresent the system.

## 90-second judging script

### 0–15 s: the problem and the baseline

**Say:** "Browser agents reason about every click: look, think, act, repeat. On 100 records
across three apps, that's hundreds of model calls in a row, and 'done' is the model's word for
it."

**Show:** the benchmark table, or the recorded baseline run and its saved `pnpm cli check`
output. Point at wall time, model calls, and checker accuracy (ground truth the engine never
sees).

**If no results exist:** say "benchmark results are pending" and show the task instead: the
judge console's **Scenario** panel, then one of the apps.

### 15–40 s: mode E discovers while workers execute

**Do:** in terminal 4, start the live run.

```bash
pnpm cli run --scenario --mode overclock --workers 16
```

**Say:** "Overclock compiles the task instead. Scouts explore the apps read-only, the planner
writes a typed plan, and the moment a read step is complete and validated it starts running,
while the rest of the plan is still being written."

**Point at, in the dashboard:**

- **Pipeline:** discovery, planning, and execution bars overlapping in time.
- **Fragments:** read fragments moving from `canary` (one record) to `released` (every record),
  and write fragments held at `deferred` with the gate they're waiting on.
- **Discovery swarm:** scout pages arriving live.
- **Workers:** thumbnails of many browsers working at once.

**If mode E fails to start:** cancel with Ctrl-C, run `pnpm demo:reset`, and rerun with
`--mode overclock-staged`. Say "this is the stage-gated pipeline: same compiler and
scheduler, but execution starts only after planning". The **Pipeline** panel then shows no
overlap, which is the honest difference.

### 40–60 s: verified results against the baseline

**Say:** "Every write is read back from a freshly loaded page. A record counts as verified only
when that read-back matches, and an independent checker grades the result."

**Show:**

- The run header and **Run summary**: verified records, time to first verified action, model
  calls, and cost, live from this run.
- The **Independent checker** panel: click **Check ground truth**. It grades the arena's
  current state, so while the run is still going its accuracy covers only the records
  processed so far; say so.
- The benchmark table from `BENCHMARKS.md` or the **Benchmarks** page for the comparison with
  the baseline mode.

**If no results exist:** compare against the recorded baseline run only, and quote only its own
numbers. Never estimate a speedup.

### 60–75 s: the judge changes the UI

**Do:** ask a judge to click a surprise in the judge console's **Surprises** grid, for example
**Rename save buttons** for Support, or **Confirmation modal**. The same controls are in the
dashboard under **Interference**. From the terminal:

```bash
pnpm cli surprise rename-save --app Support
pnpm cli surprise confirm-modal --app Support
```

**Say:** "The app changed under a running program. Overclock repairs only the step that
broke, learns the fix once, and every later record reuses it with no new observation or model
call. Workers on other steps keep going."

**Point at:**

- **Recoveries:** a level 1 repair followed by level 0 reuses.
- **Workers** and **Tasks:** work on other segments continues.
- After the run: `pnpm cli check` shows duplicate writes and collateral writes, which should
  both be 0.

**If recovery can't repair it:** the affected tasks escalate to `NEEDS_APPROVAL` instead of
guessing. Say so: refusing to guess is the designed behavior. Recovery on a renamed button and
a confirmation modal is tested on a fixture app (`pnpm test:adversarial`), not yet on the
arena with a live engine.

### 75–90 s: runtime B reuses runtime A's capability

**Only if the network integration has landed** and a two-runtime test passes: start a second
engine (see [`NETWORK.md`](NETWORK.md#two-runtimes)) and run the same task on it with a
network knowledge policy. Point at the **Knowledge network** panel: lookup, import, rebind,
and the discovery it skipped.

**Fallback (the current state):** pick one, rehearsed beforehand.

- **Client-level transfer.** If it passes in rehearsal, run the two-identity registry test
  against the local SpacetimeDB:

  ```bash
  pnpm test:network -t "B receives the promoted version"
  ```

  Say what it shows: a publisher proposes a capability, a separate validator passes it, an
  admin promotes it, and a reader identity receives it live, fetches it, and verifies its hash.
  Say what it doesn't show: the capability is synthetic, and no engine executes it.
- **Design only.** Show the publication state machine in [`NETWORK.md`](NETWORK.md) and say:
  "Next, a validated capability that one runtime discovered goes to SpacetimeDB. A different
  validator checks it, and a fresh runtime rebinds it to its own view of the app before running
  it. That part is in progress."

**Closing line:** "One agent discovers. Every agent becomes faster."

If you're using the fallback, say the closing line as the goal it is, not as a result.

## 3-minute extended version

| Time | Do | Say and show |
| --- | --- | --- |
| 0:00–0:20 | Show the baseline evidence. | The problem: per-click reasoning, sequential, unverified. |
| 0:20–0:50 | Start `pnpm cli run --scenario --mode overclock --workers 16`. Open the **Execution graph** and its program view. | The compiled program: phases, segments, the eight compiler passes, and which writes carry compare-and-swap guards and read-back checks. |
| 0:50–1:30 | Stay on the run console. | **Pipeline** overlap, **Fragments** gates (read canary, then fan-out; writes deferred until the plan validates, effects are classified, and critique passes; then a write canary). **Workers** and **Tasks** filling in. |
| 1:30–2:00 | In the judge console, click **Edit an unprocessed record**. | A judge changed data mid-run. If a worker read that record before the edit, its compare-and-swap guard sees the form no longer matches, so the scheduler re-reads instead of overwriting. Point at **Invalidations** in the **Coordination** panel. If the edit lands before the record is read, the run reads the new value. |
| 2:00–2:30 | Click **Rename save buttons** or **Confirmation modal**. | Localized recovery: one repair, then reuse at level 0 across records; other workers continue. |
| 2:30–2:50 | Show **Run summary**, **Independent checker**, then the benchmark table. | Verified records, time to first verified action, overlap, model calls, cost, and checker accuracy; the comparison with the baseline mode. Real numbers only. |
| 2:50–3:00 | Show the network design or the two-runtime import. | "One agent discovers. Every agent becomes faster." |

## Fast reset

Use this between demos. It takes about 10 seconds.

1. Stop the live run. In terminal 4, press Ctrl-C once (the CLI cancels the run), or run
   `pnpm cli cancel <runId>`.
2. Reload the scenario. This clears every surprise and the arena's stats:

   ```bash
   pnpm demo:reset
   ```

   In the judge console, **Reset to snapshot** does the same for the scenario that is already
   loaded, and **Clear all surprises** removes surprises only.
3. Confirm the arena is clean: the judge console shows **No surprises**, and `pnpm cli check`
   reports the starting state.
4. The dashboard home page switches to the newest run automatically once you start one. Older
   runs stay in the **Runs** list.

You don't need to restart the engine. CLI runs use `cache: "cold"` by default, so a new run
doesn't reuse the previous run's compiled program.
