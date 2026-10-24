# Overclock demo

This page has the main demo (a capability transfer across a changed website, with its
90-second judging script and a recorded fallback), an alternative live mode E run with its own
script and a 3-minute extended version, and a fast reset procedure. Every number you show must come from a real run or from
[`BENCHMARKS.md`](BENCHMARKS.md). If a number doesn't exist yet, say "results pending" and move
on.

> **Readiness (2026-10-24, final submission).** The live demo below makes no model calls: runtime
> A replays the workflow it learned and passed through adversarial review earlier, and B imports
> it. It passed all 11 acceptance checks on seed 1111 headless and with visible browsers. A
> recorded fallback is in [`demo/transfer-recording.mp4`](demo/transfer-recording.mp4).

## Main demo: the website changed, agent B still knew what to do

One screen, the dashboard's **Transfer** page (`http://localhost:3000/transfer`), tells the story
of the newest passing run: A learned → SpacetimeDB accepted → website changed → B rebound → zero
planning calls → verified → a conflicting request refused. Every figure comes from the report
`pnpm network:demo` writes (run summaries, the arena's own write counters, and its independent
checker, which the agents never see). The page labels every report "Recorded run" with its time
and seed: it shows what a run recorded, live or earlier.

### Setup (before judges arrive)

```bash
pnpm arena          # judge console http://127.0.0.1:4100, apps :4101–4104
pnpm network:dev    # local SpacetimeDB on :3100
pnpm engine         # engine :4000; serves the transfer reports to the dashboard
pnpm dashboard      # http://localhost:3000
```

The live command needs A's cached, reviewed plan in `.data/scratch/a-cache` (copy it from
`.data/demo/runtime-a/program-cache/` after any earlier demo run). Rehearse once.

### Live command (no model spend, about 40 s headless, about 60 s with visible browsers)

```bash
OVERCLOCK_HEADLESS=0 pnpm network:demo --records 10 --seed 1111 --variation rename-save --conflict-arm --no-cold-arm --a-warm-cache .data/scratch/a-cache
```

It starts four engine processes with separate identities and data dirs (A, validator, B, and the
conflict runtime X), and exits 1 unless every acceptance check passes. With
`OVERCLOCK_HEADLESS=0` each runtime's browsers open as windows, so judges watch B type into the
renamed forms. Visible windows slow B down (about 7 s against about 2 s headless); quote the
headless numbers from the recorded reports.

Use seed 1111 (1111, 2222, 3333, 5151, 6262, and 7777 all pass). Seed 4242 now stops at step 2,
by design: its batch's only customer with two or more refunds is a VIP, so the hold rule never
fires, and A won't publish a capability with a rule it never saw work (`NETWORK.md`, "Skipped
writes need evidence").

### What to point at

1. **A has a learned, validated workflow.** Step 1: A ran its reviewed plan, 10/10. Step 2: an
   independent validator re-checked the capability in read-only browsers before it went ACTIVE.
2. **The website's save buttons changed.** Step 3: "Save changes" → "Update record", "Update
   order" → "Apply changes", "Save ticket" → "Commit ticket".
3. **B is a different agent with nothing local.** Step 4: B's network identity differs from
   A's, and its cache was empty before the run.
4. **B imports, rebinds, and really writes.** Step 4 lists the three buttons B rebound by
   structure; its writes ran behind a write canary. In the browser windows, B fills and submits
   the renamed forms. The check "The arena's own counters saw exactly B's verified writes"
   compares the arena's own count of committed writes during B's run with B's receipts (8 and 8
   on the recorded run).
5. **Independent proof.** Step 6: the arena's checker found 10/10 correct, 0 duplicate, 0
   collateral writes. Step 5: zero planning calls, $0.
6. **A conflicting instruction is refused.** Step 7: runtime X asked for the same task with
   "Tier 2" changed to "Tier 1". Its lookup found no capability for that operation, it reused
   nothing, and the arena's write counters didn't move.

### 90-second judging script

**0–15 s, the problem.** "Every browser agent relearns every website from scratch, and breaks
when a button is renamed. Overclock compiles a task into a verified program, and shares what one
agent learned with others, safely."

**15–35 s, start it.** Run the live command. "Agent A already learned this order-reconciliation
workflow across three apps, and an independent validator approved it. Now we rename every save
button."

**35–60 s, watch B.** Point at B's browser windows filling the renamed forms. "B is a new agent:
its own identity, an empty cache, no model calls. It imported A's workflow, saw the buttons had
changed, rebound them by the form's structure, and wrote behind a canary: one record first, read
back, then the rest."

**60–80 s, the proof.** Refresh the Transfer page. "The arena's own checker, which the agents
never see: 10 of 10 correct, zero duplicates, zero collateral writes. The arena counted exactly
the 8 writes B verified."

**80–90 s, what it refuses.** Point at step 7. "Change one value in the instructions, Tier 2 to
Tier 1, and the network refuses to reuse anything: zero writes. Reuse needs the exact same
operation."

### Fallback (if anything fails live)

Don't run anything. Play [`demo/transfer-recording.mp4`](demo/transfer-recording.mp4) (35 s):
title cards marked **RECORDED EVIDENCE · NOT LIVE**, then 12 of B's own browser pages recorded
by Playwright inside runtime B during the 4:03 PM PDT run on 2026-10-24 (slowed 4×, labelled), then
the Transfer page on that run's report. Then open the Transfer page itself: it needs only the
engine and the dashboard, and reads the reports in `benchmarks/results/network/`. To re-record,
add `--record-video <dir>` to the live command (B's browsers then run inside its engine process).

The cold version (A learns from scratch, plus a strict-cold comparison runtime C) needs model
calls (about $0.86) and isn't part of the final demo:
`pnpm network:demo --records 10 --seed 1111 --variation rename-save --warm-arm`.

## Alternative: a live mode E run (needs model calls)

Not part of the final demo: a cold mode E run plans with Claude, which costs money per run.

### Setup before judges arrive

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

## 90-second script for the live mode E run

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

**Before judging,** run the transfer once and keep its report:

```bash
pnpm network:dev
pnpm network:demo --keep
```

It takes about 5 minutes and spends about $1 (runtime A's and runtime C's cold runs). With
`--keep`, the three engines stay up so you can show B's run in a second dashboard started with
`NEXT_PUBLIC_OVERCLOCK_URL=http://127.0.0.1:4020`.

**Show:** the acceptance checks the script printed (all `PASS`) and the Knowledge network panel
of B's run: lookup, import (`EXACT_COMPATIBLE`, 24 controls bound), and no planner call.

**Say:** "Runtime A discovered this task cold and published it. A separate validator identity
checked it, and an admin promoted it. Runtime B, which had never seen these apps, rebound the
capability to its own view of them and finished in 3 seconds with no model calls. A fresh
runtime running the same task cold took 169 seconds. The arena's checker graded both 10 out
of 10." These are the numbers from the recorded run in [`NETWORK.md`](NETWORK.md#results);
use the numbers from your rehearsal if they differ.

**If the live demo fails:** show the recorded report and say which check failed. The script
exits non-zero on purpose instead of hiding a failure.

**Closing line:** "One agent discovers. Every agent becomes faster."

## 3-minute extended version

| Time | Do | Say and show |
| --- | --- | --- |
| 0:00–0:20 | Show the baseline evidence. | The problem: per-click reasoning, sequential, unverified. |
| 0:20–0:50 | Start `pnpm cli run --scenario --mode overclock --workers 16`. Open the **Execution graph** and its program view. | The compiled program: phases, segments, the eight compiler passes, and which writes carry compare-and-swap guards and read-back checks. |
| 0:50–1:30 | Stay on the run console. | **Pipeline** overlap, **Fragments** gates (read canary, then fan-out; writes deferred until the plan validates, effects are classified, and critique passes; then a write canary). **Workers** and **Tasks** filling in. |
| 1:30–2:00 | In the judge console, click **Edit an unprocessed record**. | A judge changed data mid-run. If a worker read that record before the edit, its compare-and-swap guard sees the form no longer matches, so the scheduler re-reads instead of overwriting. Point at **Invalidations** in the **Coordination** panel. If the edit lands before the record is read, the run reads the new value. |
| 2:00–2:30 | Click **Rename save buttons** or **Confirmation modal**. | Localized recovery: one repair, then reuse at level 0 across records; other workers continue. |
| 2:30–2:50 | Show **Run summary**, **Independent checker**, then the benchmark table. | Verified records, time to first verified action, overlap, model calls, cost, and checker accuracy; the comparison with the baseline mode. Real numbers only. |
| 2:50–3:00 | Show the recorded `pnpm network:demo` report: A's cold run, B's import, C's strict-cold run, all graded 10/10. | "One agent discovers. Every agent becomes faster." |

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
