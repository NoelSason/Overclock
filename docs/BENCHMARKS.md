# Overclock benchmarks

Generated from 21 result files with 65 executed runs (8 failed). Latest result file: 2026-10-24T19:51:11.149Z.

Every number on this page comes from an executed run recorded in `benchmarks/results/`. Nothing is estimated, extrapolated, or filled in.

## Cold start

The headline comparison: E (`overclock`, streaming) against C (`compiled-parallel`, fixed 8 workers) and D (`overclock-staged`, the same swarm but stage-gated). Every run is cold, and wall time starts when the instruction is submitted, so it includes discovery and planning. Pairs are formed only within one suite and only when template, seed, records, condition, and cache state all match.

| Scenario | Records | Condition | Suite | Comparison | n (E / other) | Median wall | Wall speedup | Median first verified | Accuracy median | Cost/run median |
|---|---|---|---|---|---|---|---|---|---|---|
| t1 seed 4242 | 25 | local | `all` | E vs C | 3 / 3 | 95.8 s vs 42.4 s | 0.44× | 95.0 s vs 41.7 s | 100.0% vs 100.0% | $0.3407 vs $0.1603 |
| t1 seed 4242 | 25 | local | `all` | E vs D | 3 / 3 | 95.8 s vs 3.2 min | 1.98× | 95.0 s vs 3.2 min | 100.0% vs 100.0% | $0.3407 vs $1.05 |
| t1 seed 4242 | 100 | local | `all` | E vs C | 1 / 1 | 107.4 s vs 57.6 s | 0.54× | 103.3 s vs 54.6 s | 100.0% vs 100.0% | $0.3729 vs $0.1818 |
| t1 seed 4242 | 100 | local | `all` | E vs D | 1 / 1 | 107.4 s vs 2.5 min | 1.38× | 103.3 s vs 2.4 min | 100.0% vs 100.0% | $0.3729 vs $0.8787 |
| t1 seed 4242 | 25 | realistic-latency | `all` | E vs C | 3 / 3 | 2.1 min vs 95.6 s | 0.78× | 117.1 s vs 43.7 s | 100.0% vs 100.0% | $0.3864 vs $0.1892 |
| t1 seed 4242 | 25 | realistic-latency | `all` | E vs D | 3 / 3 | 2.1 min vs 3.0 min | 1.48× | 117.1 s vs 2.9 min | 100.0% vs 100.0% | $0.3864 vs $0.9909 |

- **E is not faster than C** on t1 seed 4242, 25 records, local (n=3 vs 3): 95.8 s vs 42.4 s median wall (0.44×).
- **E does not reach its first verified action sooner than C** on t1 seed 4242, 25 records, local (n=3 vs 3): 95.0 s vs 41.7 s.
- E is faster than D on t1 seed 4242, 25 records, local (n=3 vs 3): 95.8 s vs 3.2 min median wall (1.98×).
- **E is not faster than C** on t1 seed 4242, 100 records, local (n=1 vs 1): 107.4 s vs 57.6 s median wall (0.54×).
- **E does not reach its first verified action sooner than C** on t1 seed 4242, 100 records, local (n=1 vs 1): 103.3 s vs 54.6 s.
- E is faster than D on t1 seed 4242, 100 records, local (n=1 vs 1): 107.4 s vs 2.5 min median wall (1.38×).
- **E is not faster than C** on t1 seed 4242, 25 records, realistic-latency (n=3 vs 3): 2.1 min vs 95.6 s median wall (0.78×).
- **E does not reach its first verified action sooner than C** on t1 seed 4242, 25 records, realistic-latency (n=3 vs 3): 117.1 s vs 43.7 s.
- E is faster than D on t1 seed 4242, 25 records, realistic-latency (n=3 vs 3): 2.1 min vs 3.0 min median wall (1.48×).

## Results by suite

### Suite `all`

Modes A–E on the same scenario under both conditions. E vs C vs D runs first, then B, A, and the external baseline when present, then one 100-record run per compiled mode. Every cold E trial is followed immediately by a warm-cache repeat.

**Cold start, local**

| Label | Scenario | Records | n | Failed | Wall median | Wall p95 | First verified | Accuracy median (min) | Engine-verified | Correct/min | Cost/run | Cost/correct | Model calls | Tokens | Utilization |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `overclock` | t1 seed 4242 | 25 | 3 | 0 | 95.8 s | n/a (n=3) | 95.0 s | 100.0% (100.0%) | n/a | 15.7 | $0.3407 | $0.0116 | 6 | 59883 | 57.5% |
| `compiled-parallel` | t1 seed 4242 | 25 | 3 | 0 | 42.4 s | n/a (n=3) | 41.7 s | 100.0% (100.0%) | n/a | 35.3 | $0.1603 | $0.0078 | 4 | 21179 | 90.4% |
| `overclock-staged` | t1 seed 4242 | 25 | 3 | 0 | 3.2 min | n/a (n=3) | 3.2 min | 100.0% (100.0%) | n/a | 7.9 | $1.05 | $0.0422 | 13 | 172334 | 70.6% |
| `compiled-single` | t1 seed 4242 | 25 | 3 | 0 | 59.0 s | n/a (n=3) | 56.8 s | 100.0% (92.0%) | n/a | 25.4 | $0.1870 | $0.0077 | 4 | 22512 | 98.7% |
| `compiled-single` | t1 seed 4242 | 100 | 1 | 0 | 59.7 s | n/a (n=1) | 48.1 s | 100.0% (100.0%) | n/a | 100.5 | $0.1584 | $0.0016 | 4 | 21062 | 99.3% |
| `compiled-parallel` | t1 seed 4242 | 100 | 1 | 0 | 57.6 s | n/a (n=1) | 54.6 s | 100.0% (100.0%) | n/a | 104.1 | $0.1818 | $0.0018 | 4 | 22231 | 97.1% |
| `overclock-staged` | t1 seed 4242 | 100 | 1 | 0 | 2.5 min | n/a (n=1) | 2.4 min | 100.0% (100.0%) | n/a | 40.5 | $0.8787 | $0.0088 | 12 | 148956 | 82.3% |
| `overclock` | t1 seed 4242 | 100 | 1 | 0 | 107.4 s | n/a (n=1) | 103.3 s | 100.0% (100.0%) | n/a | 55.9 | $0.3729 | $0.0037 | 6 | 61270 | 66.2% |

**Cold start, realistic-latency**

| Label | Scenario | Records | n | Failed | Wall median | Wall p95 | First verified | Accuracy median (min) | Engine-verified | Correct/min | Cost/run | Cost/correct | Model calls | Tokens | Utilization |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `overclock` | t1 seed 4242 | 25 | 3 | 0 | 2.1 min | n/a (n=3) | 117.1 s | 100.0% (100.0%) | n/a | 12.2 | $0.3864 | $0.0185 | 6 | 61942 | 45.0% |
| `compiled-parallel` | t1 seed 4242 | 25 | 3 | 0 | 95.6 s | n/a (n=3) | 43.7 s | 100.0% (80.0%) | n/a | 14.0 | $0.1892 | $0.0103 | 5 | 27514 | 77.1% |
| `overclock-staged` | t1 seed 4242 | 25 | 3 | 0 | 3.0 min | n/a (n=3) | 2.9 min | 100.0% (92.0%) | n/a | 8.0 | $0.9909 | $0.0395 | 13 | 168475 | 41.3% |
| `compiled-single` | t1 seed 4242 | 25 | 3 | 0 | 86.7 s | n/a (n=3) | 63.0 s | 100.0% (100.0%) | n/a | 17.3 | $0.1527 | $0.0064 | 4 | 20800 | 99.9% |

**Warm start, local** (cache reuse; not comparable with cold runs)

| Label | Scenario | Records | n | Failed | Wall median | Wall p95 | First verified | Accuracy median (min) | Engine-verified | Correct/min | Cost/run | Cost/correct | Model calls | Tokens | Utilization |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `overclock` | t1 seed 4242 | 25 | 3 | 0 | 2.1 s | n/a (n=3) | 1.4 s | 100.0% (100.0%) | n/a | 702.9 | $0.0000 | $0.0000 | 0 | 0 | 85.1% |

**Warm start, realistic-latency** (cache reuse; not comparable with cold runs)

| Label | Scenario | Records | n | Failed | Wall median | Wall p95 | First verified | Accuracy median (min) | Engine-verified | Correct/min | Cost/run | Cost/correct | Model calls | Tokens | Utilization |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `overclock` | t1 seed 4242 | 25 | 3 | 0 | 5.9 s | n/a (n=3) | 2.4 s | 100.0% (100.0%) | n/a | 253.3 | $0.0000 | $0.0000 | 0 | 0 | 59.6% |

### Suite `modes@speed-standard`

Single-mode runs started with `--mode`. Runs from separate invocations pool here.

**Cold start, local**

| Label | Scenario | Records | n | Failed | Wall median | Wall p95 | First verified | Accuracy median (min) | Engine-verified | Correct/min | Cost/run | Cost/correct | Model calls | Tokens | Utilization |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `overclock` | t1 seed 4242 | 25 | 1 | 0 | 54.0 s | n/a (n=1) | 53.2 s | 100.0% (100.0%) | n/a | 27.8 | $0.2678 | $0.0107 | 5 | 42054 | 62.0% |

### Suite `modes@speed-fast`

Single-mode runs started with `--mode`. Runs from separate invocations pool here.

**Cold start, local**

| Label | Scenario | Records | n | Failed | Wall median | Wall p95 | First verified | Accuracy median (min) | Engine-verified | Correct/min | Cost/run | Cost/correct | Model calls | Tokens | Utilization |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `overclock` | t1 seed 4242 | 25 | 1 | 0 | 46.3 s | n/a (n=1) | 45.2 s | 100.0% (100.0%) | n/a | 32.4 | $0.3022 | $0.0121 | 6 | 36279 | 1.9% |

### Suite `modes@e-standard`

Single-mode runs started with `--mode`. Runs from separate invocations pool here.

**Cold start, local**

| Label | Scenario | Records | n | Failed | Wall median | Wall p95 | First verified | Accuracy median (min) | Engine-verified | Correct/min | Cost/run | Cost/correct | Model calls | Tokens | Utilization |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `overclock` | t1 seed 4242 | 25 | 3 | 0 | 61.7 s | n/a (n=3) | 60.1 s | 100.0% (100.0%) | 100.0% | 24.3 | $0.1748 | $0.0094 | 5 | 36251 | 1.4% |

### Suite `modes@e-fast`

Single-mode runs started with `--mode`. Runs from separate invocations pool here.

**Cold start, local**

| Label | Scenario | Records | n | Failed | Wall median | Wall p95 | First verified | Accuracy median (min) | Engine-verified | Correct/min | Cost/run | Cost/correct | Model calls | Tokens | Utilization |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `overclock` | t1 seed 4242 | 25 | 2 | 1 | 35.2 s | n/a (n=2) | 34.4 s | 100.0% (100.0%) | 100.0% | 42.7 | $0.8452 | $0.0338 | 7 | 69072 | 63.9% |

### Suite `modes@e2-fast`

Single-mode runs started with `--mode`. Runs from separate invocations pool here.

**Cold start, local**

| Label | Scenario | Records | n | Failed | Wall median | Wall p95 | First verified | Accuracy median (min) | Engine-verified | Correct/min | Cost/run | Cost/correct | Model calls | Tokens | Utilization |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `overclock` | t1 seed 4242 | 25 | 3 | 0 | 18.8 s | n/a (n=3) | 17.7 s | 100.0% (100.0%) | 100.0% | 79.8 | $0.4346 | $0.0175 | 5 | 34133 | 3.9% |

### Suite `modes@e2-standard`

Single-mode runs started with `--mode`. Runs from separate invocations pool here.

**Cold start, local**

| Label | Scenario | Records | n | Failed | Wall median | Wall p95 | First verified | Accuracy median (min) | Engine-verified | Correct/min | Cost/run | Cost/correct | Model calls | Tokens | Utilization |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `overclock` | t1 seed 4242 | 25 | 2 | 1 | 52.8 s | n/a (n=2) | 51.5 s | 100.0% (100.0%) | 100.0% | 28.4 | $0.1522 | $0.0061 | 5 | 36212 | 1.3% |

### Suite `modes@c-standard`

Single-mode runs started with `--mode`. Runs from separate invocations pool here.

**Cold start, local**

| Label | Scenario | Records | n | Failed | Wall median | Wall p95 | First verified | Accuracy median (min) | Engine-verified | Correct/min | Cost/run | Cost/correct | Model calls | Tokens | Utilization |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `compiled-parallel` | t1 seed 4242 | 25 | 2 | 0 | 45.0 s | n/a (n=2) | 44.3 s | 100.0% (100.0%) | 100.0% | 34.3 | $0.1641 | $0.0066 | 4 | 21509 | 88.5% |

### Suite `modes@c-fast`

Single-mode runs started with `--mode`. Runs from separate invocations pool here.

**Cold start, local**

| Label | Scenario | Records | n | Failed | Wall median | Wall p95 | First verified | Accuracy median (min) | Engine-verified | Correct/min | Cost/run | Cost/correct | Model calls | Tokens | Utilization |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `compiled-parallel` | t1 seed 4242 | 25 | 2 | 0 | 18.3 s | n/a (n=2) | 17.5 s | 100.0% (100.0%) | 100.0% | 83.1 | $0.3232 | $0.0129 | 4 | 21389 | 89.5% |

### Suite `modes@scale-fast`

Single-mode runs started with `--mode`. Runs from separate invocations pool here.

**Cold start, local**

| Label | Scenario | Records | n | Failed | Wall median | Wall p95 | First verified | Accuracy median (min) | Engine-verified | Correct/min | Cost/run | Cost/correct | Model calls | Tokens | Utilization |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `overclock` | t1 seed 4242 | 500 | 1 | 0 | 42.3 s | n/a (n=1) | 25.8 s | 100.0% (100.0%) | 100.0% | 708.9 | $0.4516 | $0.0009 | 5 | 34235 | 83.7% |

## Holdout

Scenarios never used during development. These numbers are the best evidence of how the system generalizes.

- Holdout code freeze: freeze-2026-10-24-e14db0e-tree-b59e0e950646.

### Suite `holdout`

**Cold start, local**

| Label | Scenario | Records | n | Failed | Wall median | Wall p95 | First verified | Accuracy median (min) | Engine-verified | Correct/min | Cost/run | Cost/correct | Model calls | Tokens | Utilization |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `overclock` | t3 seed 9001 | 25 | 1 | 0 | 54.4 s | n/a (n=1) | 54.2 s | 100.0% (100.0%) | n/a | 27.6 | $0.2533 | $0.0101 | 6 | 51566 | 74.8% |
| `overclock-staged` | t3 seed 9001 | 25 | 1 | 0 | 67.4 s | n/a (n=1) | 67.1 s | 100.0% (100.0%) | n/a | 22.3 | $0.4768 | $0.0191 | 11 | 104264 | 41.3% |
| `compiled-parallel` | t3 seed 9001 | 25 | 1 | 0 | 16.2 s | n/a (n=1) | 15.9 s | 100.0% (100.0%) | n/a | 92.8 | $0.0758 | $0.0030 | 3 | 14242 | 95.3% |
| `overclock` | t4 seed 9101 | 25 | 0 | 1 | n/a | n/a (n=0) | n/a | n/a (n/a) | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| `overclock-staged` | t4 seed 9101 | 25 | 0 | 1 | n/a | n/a (n=0) | n/a | n/a (n/a) | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| `compiled-parallel` | t4 seed 9101 | 25 | 0 | 1 | n/a | n/a (n=0) | n/a | n/a (n/a) | n/a | n/a | n/a | n/a | n/a | n/a | n/a |

**Cold start, realistic-latency**

| Label | Scenario | Records | n | Failed | Wall median | Wall p95 | First verified | Accuracy median (min) | Engine-verified | Correct/min | Cost/run | Cost/correct | Model calls | Tokens | Utilization |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `overclock` | t3 seed 9001 | 25 | 1 | 0 | 31.3 s | n/a (n=1) | 28.0 s | 100.0% (100.0%) | n/a | 47.9 | $0.0759 | $0.0030 | 4 | 22222 | 13.3% |
| `overclock-staged` | t3 seed 9001 | 25 | 1 | 0 | 67.4 s | n/a (n=1) | 66.1 s | 100.0% (100.0%) | n/a | 22.2 | $0.4118 | $0.0165 | 10 | 89470 | 28.9% |
| `compiled-parallel` | t3 seed 9001 | 25 | 1 | 0 | 20.8 s | n/a (n=1) | 19.3 s | 100.0% (100.0%) | n/a | 72.2 | $0.0742 | $0.0030 | 3 | 14166 | 77.7% |
| `overclock` | t4 seed 9101 | 25 | 0 | 1 | n/a | n/a (n=0) | n/a | n/a (n/a) | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| `overclock-staged` | t4 seed 9101 | 25 | 0 | 1 | n/a | n/a (n=0) | n/a | n/a (n/a) | n/a | n/a | n/a | n/a | n/a | n/a | n/a |
| `compiled-parallel` | t4 seed 9101 | 25 | 0 | 1 | n/a | n/a (n=0) | n/a | n/a (n/a) | n/a | n/a | n/a | n/a | n/a | n/a | n/a |

**E vs C and E vs D on holdout scenarios**

| Scenario | Records | Condition | Suite | Comparison | n (E / other) | Median wall | Wall speedup | Median first verified | Accuracy median | Cost/run median |
|---|---|---|---|---|---|---|---|---|---|---|
| t3 seed 9001 | 25 | local | `holdout` | E vs C | 1 / 1 | 54.4 s vs 16.2 s | 0.30× | 54.2 s vs 15.9 s | 100.0% vs 100.0% | $0.2533 vs $0.0758 |
| t3 seed 9001 | 25 | local | `holdout` | E vs D | 1 / 1 | 54.4 s vs 67.4 s | 1.24× | 54.2 s vs 67.1 s | 100.0% vs 100.0% | $0.2533 vs $0.4768 |
| t3 seed 9001 | 25 | realistic-latency | `holdout` | E vs C | 1 / 1 | 31.3 s vs 20.8 s | 0.66× | 28.0 s vs 19.3 s | 100.0% vs 100.0% | $0.0759 vs $0.0742 |
| t3 seed 9001 | 25 | realistic-latency | `holdout` | E vs D | 1 / 1 | 31.3 s vs 67.4 s | 2.15× | 28.0 s vs 66.1 s | 100.0% vs 100.0% | $0.0759 vs $0.4118 |

- **E is not faster than C** on t3 seed 9001 (holdout), 25 records, local (n=1 vs 1): 54.4 s vs 16.2 s median wall (0.30×).
- **E does not reach its first verified action sooner than C** on t3 seed 9001 (holdout), 25 records, local (n=1 vs 1): 54.2 s vs 15.9 s.
- E is faster than D on t3 seed 9001 (holdout), 25 records, local (n=1 vs 1): 54.4 s vs 67.4 s median wall (1.24×).
- **E is not faster than C** on t3 seed 9001 (holdout), 25 records, realistic-latency (n=1 vs 1): 31.3 s vs 20.8 s median wall (0.66×).
- **E does not reach its first verified action sooner than C** on t3 seed 9001 (holdout), 25 records, realistic-latency (n=1 vs 1): 28.0 s vs 19.3 s.
- E is faster than D on t3 seed 9001 (holdout), 25 records, realistic-latency (n=1 vs 1): 31.3 s vs 67.4 s median wall (2.15×).

## Speedups

Each candidate is compared with its suite's baseline on the same scenario, record count, cache state, condition, and holdout status. Pairs that do not match are not compared.

### Suite `all`

| Scenario | Records | Condition | Cache | Baseline (n) | Candidate (n) | Baseline median | Candidate median | Wall-time speedup | First-verified speedup | Correct/min ratio |
|---|---|---|---|---|---|---|---|---|---|---|
| t1 seed 4242 | 25 | local | cold | `compiled-single` (3) | `overclock` (3) | 59.0 s | 95.8 s | 0.62× | 0.60× | 0.62× |
| t1 seed 4242 | 25 | local | cold | `compiled-single` (3) | `compiled-parallel` (3) | 59.0 s | 42.4 s | 1.39× | 1.36× | 1.39× |
| t1 seed 4242 | 25 | local | cold | `compiled-single` (3) | `overclock-staged` (3) | 59.0 s | 3.2 min | 0.31× | 0.30× | 0.31× |
| t1 seed 4242 | 100 | local | cold | `compiled-single` (1) | `compiled-parallel` (1) | 59.7 s | 57.6 s | 1.04× | 0.88× | 1.04× |
| t1 seed 4242 | 100 | local | cold | `compiled-single` (1) | `overclock-staged` (1) | 59.7 s | 2.5 min | 0.40× | 0.33× | 0.40× |
| t1 seed 4242 | 100 | local | cold | `compiled-single` (1) | `overclock` (1) | 59.7 s | 107.4 s | 0.56× | 0.47× | 0.56× |
| t1 seed 4242 | 25 | realistic-latency | cold | `compiled-single` (3) | `overclock` (3) | 86.7 s | 2.1 min | 0.70× | 0.54× | 0.70× |
| t1 seed 4242 | 25 | realistic-latency | cold | `compiled-single` (3) | `compiled-parallel` (3) | 86.7 s | 95.6 s | 0.91× | 1.44× | 0.81× |
| t1 seed 4242 | 25 | realistic-latency | cold | `compiled-single` (3) | `overclock-staged` (3) | 86.7 s | 3.0 min | 0.48× | 0.36× | 0.46× |

### Suite `holdout`

| Scenario | Records | Condition | Cache | Baseline (n) | Candidate (n) | Baseline median | Candidate median | Wall-time speedup | First-verified speedup | Correct/min ratio |
|---|---|---|---|---|---|---|---|---|---|---|
| t3 seed 9001 (holdout) | 25 | local | cold | `compiled-parallel` (1) | `overclock` (1) | 16.2 s | 54.4 s | 0.30× | 0.29× | 0.30× |
| t3 seed 9001 (holdout) | 25 | local | cold | `compiled-parallel` (1) | `overclock-staged` (1) | 16.2 s | 67.4 s | 0.24× | 0.24× | 0.24× |
| t3 seed 9001 (holdout) | 25 | realistic-latency | cold | `compiled-parallel` (1) | `overclock` (1) | 20.8 s | 31.3 s | 0.66× | 0.69× | 0.66× |
| t3 seed 9001 (holdout) | 25 | realistic-latency | cold | `compiled-parallel` (1) | `overclock-staged` (1) | 20.8 s | 67.4 s | 0.31× | 0.29× | 0.31× |

## Parallel scaling

No `scaling` suite results yet.

## Ablation deltas

No `ablations` suite results yet.

## Where time goes

Median time per pipeline stage from the engine summary (`stageMs`), with each as a share of the median wall time. Stages can overlap in streaming mode, so shares can add up to more than 100%; overlap is the time thinking stages ran alongside browser execution. Recovery time is the summary's total recovery time. A dash means the stage did not appear in that group's runs.

| Suite | Label | Scenario | Records | Condition | Cache | n | Wall median | Exploring | Planning | Critique | Executing | Recovery time | Overlap |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| `all` | `overclock` | t1 seed 4242 | 25 | local | cold | 3 | 95.8 s | 1.7 s (1.8%) | 75.8 s (79.1%) | 17.3 s (18.1%) | 91.6 s (95.7%) | 0 ms (0.0%) | 87.8 s (91.7%) |
| `all` | `compiled-parallel` | t1 seed 4242 | 25 | local | cold | 3 | 42.4 s | 916 ms (2.2%) | 39.3 s (92.7%) | — | 1.9 s (4.5%) | 0 ms (0.0%) | 0 ms (0.0%) |
| `all` | `overclock-staged` | t1 seed 4242 | 25 | local | cold | 3 | 3.2 min | 5.6 s (3.0%) | 102.7 s (54.1%) | 84.8 s (44.7%) | 1.7 s (0.9%) | 0 ms (0.0%) | 0 ms (0.0%) |
| `all` | `compiled-single` | t1 seed 4242 | 25 | local | cold | 3 | 59.0 s | 916 ms (1.6%) | 53.0 s (89.8%) | — | 5.0 s (8.4%) | 0 ms (0.0%) | 0 ms (0.0%) |
| `all` | `compiled-single` | t1 seed 4242 | 100 | local | cold | 1 | 59.7 s | 907 ms (1.5%) | 37.9 s (63.5%) | — | 20.8 s (34.8%) | 0 ms (0.0%) | 0 ms (0.0%) |
| `all` | `compiled-parallel` | t1 seed 4242 | 100 | local | cold | 1 | 57.6 s | 932 ms (1.6%) | 50.0 s (86.7%) | — | 6.6 s (11.4%) | 0 ms (0.0%) | 0 ms (0.0%) |
| `all` | `overclock-staged` | t1 seed 4242 | 100 | local | cold | 1 | 2.5 min | 5.8 s (3.9%) | 70.3 s (47.5%) | 67.8 s (45.8%) | 4.1 s (2.8%) | 0 ms (0.0%) | 0 ms (0.0%) |
| `all` | `overclock` | t1 seed 4242 | 100 | local | cold | 1 | 107.4 s | 1.7 s (1.6%) | 87.4 s (81.4%) | 9.2 s (8.6%) | 108.9 s (101.4%) | 0 ms (0.0%) | 89.0 s (82.9%) |
| `all` | `overclock` | t1 seed 4242 | 25 | realistic-latency | cold | 3 | 2.1 min | 6.4 s (5.2%) | 96.4 s (78.2%) | 15.1 s (12.3%) | 2.1 min (99.9%) | 0 ms (0.0%) | 105.4 s (85.5%) |
| `all` | `compiled-parallel` | t1 seed 4242 | 25 | realistic-latency | cold | 3 | 95.6 s | 3.2 s (3.3%) | 37.7 s (39.4%) | — | 8.9 s (9.4%) | 0 ms (0.0%) | 0 ms (0.0%) |
| `all` | `overclock-staged` | t1 seed 4242 | 25 | realistic-latency | cold | 3 | 3.0 min | 8.6 s (4.8%) | 93.0 s (51.1%) | 71.7 s (39.4%) | 6.4 s (3.5%) | 0 ms (0.0%) | 0 ms (0.0%) |
| `all` | `compiled-single` | t1 seed 4242 | 25 | realistic-latency | cold | 3 | 86.7 s | 2.2 s (2.6%) | 35.6 s (41.1%) | — | 48.7 s (56.2%) | 0 ms (0.0%) | 0 ms (0.0%) |
| `all` | `overclock` | t1 seed 4242 | 25 | local | warm | 3 | 2.1 s | — | — | — | 2.1 s (98.9%) | 0 ms (0.0%) | 0 ms (0.0%) |
| `all` | `overclock` | t1 seed 4242 | 25 | realistic-latency | warm | 3 | 5.9 s | — | — | — | 5.9 s (99.4%) | 0 ms (0.0%) | 0 ms (0.0%) |
| `holdout` | `overclock` | t3 seed 9001 (holdout) | 25 | local | cold | 1 | 54.4 s | 1.7 s (3.1%) | 43.2 s (79.4%) | 9.0 s (16.6%) | 49.1 s (90.3%) | 0 ms (0.0%) | 47.3 s (87.0%) |
| `holdout` | `overclock-staged` | t3 seed 9001 (holdout) | 25 | local | cold | 1 | 67.4 s | 5.8 s (8.6%) | 28.0 s (41.6%) | 32.9 s (48.9%) | 657 ms (1.0%) | 0 ms (0.0%) | 0 ms (0.0%) |
| `holdout` | `compiled-parallel` | t3 seed 9001 (holdout) | 25 | local | cold | 1 | 16.2 s | 895 ms (5.5%) | 14.2 s (88.1%) | — | 915 ms (5.7%) | 0 ms (0.0%) | 0 ms (0.0%) |
| `holdout` | `overclock` | t3 seed 9001 (holdout) | 25 | realistic-latency | cold | 1 | 31.3 s | 5.0 s (16.0%) | 14.5 s (46.3%) | 9.7 s (30.8%) | 22.2 s (70.9%) | 0 ms (0.0%) | 17.9 s (57.1%) |
| `holdout` | `overclock-staged` | t3 seed 9001 (holdout) | 25 | realistic-latency | cold | 1 | 67.4 s | 6.9 s (10.2%) | 20.7 s (30.7%) | 36.9 s (54.8%) | 2.9 s (4.3%) | 0 ms (0.0%) | 0 ms (0.0%) |
| `holdout` | `compiled-parallel` | t3 seed 9001 (holdout) | 25 | realistic-latency | cold | 1 | 20.8 s | 3.5 s (16.7%) | 13.0 s (62.4%) | — | 4.2 s (20.1%) | 0 ms (0.0%) | 0 ms (0.0%) |
| `modes@speed-standard` | `overclock` | t1 seed 4242 | 25 | local | cold | 1 | 54.0 s | 1.8 s (3.2%) | 50.1 s (92.6%) | — | 49.0 s (90.6%) | 0 ms (0.0%) | 44.3 s (81.9%) |
| `modes@speed-fast` | `overclock` | t1 seed 4242 | 25 | local | cold | 1 | 46.3 s | 1.8 s (3.8%) | 12.9 s (28.0%) | 30.4 s (65.7%) | 42.3 s (91.4%) | 0 ms (0.0%) | 41.0 s (88.6%) |
| `modes@e-standard` | `overclock` | t1 seed 4242 | 25 | local | cold | 3 | 61.7 s | 1.7 s (2.7%) | 47.0 s (76.1%) | 13.3 s (21.5%) | 42.7 s (69.3%) | 0 ms (0.0%) | 41.2 s (66.7%) |
| `modes@e-fast` | `overclock` | t1 seed 4242 | 25 | local | cold | 2 | 35.2 s | 1.7 s (4.9%) | 21.4 s (60.8%) | 19.4 s (55.0%) | 33.8 s (96.0%) | 0 ms (0.0%) | 29.9 s (84.8%) |
| `modes@e2-fast` | `overclock` | t1 seed 4242 | 25 | local | cold | 3 | 18.8 s | 1.7 s (9.0%) | 13.3 s (70.8%) | 3.7 s (19.4%) | 16.0 s (85.2%) | 0 ms (0.0%) | 14.8 s (78.5%) |
| `modes@e2-standard` | `overclock` | t1 seed 4242 | 25 | local | cold | 2 | 52.8 s | 1.7 s (3.3%) | 34.0 s (64.4%) | 16.1 s (30.6%) | 46.5 s (88.1%) | 0 ms (0.0%) | 45.0 s (85.3%) |
| `modes@c-standard` | `compiled-parallel` | t1 seed 4242 | 25 | local | cold | 2 | 45.0 s | 906 ms (2.0%) | 41.8 s (92.9%) | — | 2.0 s (4.4%) | 0 ms (0.0%) | 0 ms (0.0%) |
| `modes@c-fast` | `compiled-parallel` | t1 seed 4242 | 25 | local | cold | 2 | 18.3 s | 912 ms (5.0%) | 15.3 s (83.6%) | — | 1.8 s (9.9%) | 0 ms (0.0%) | 0 ms (0.0%) |
| `modes@scale-fast` | `overclock` | t1 seed 4242 | 500 | local | cold | 1 | 42.3 s | 1.9 s (4.5%) | 13.3 s (31.5%) | 7.5 s (17.8%) | 37.7 s (89.0%) | 0 ms (0.0%) | 17.9 s (42.3%) |

## Duplicate and incorrect writes

Totals from the arena checker over every run with a checker result, including failed runs, because damage counts either way. Incorrect records = total − correct. Duplicate writes are append-only side effects applied more than once; collateral writes changed entities the task never asked to change. Verified-but-wrong records were reported VERIFIED and skipped-but-wrong records were reported SKIPPED (no change needed), but the checker marks them incorrect. The rest of the incorrect records were reported FAILED or UNCONFIRMED.

| Suite | Label | Scenario | Records | Condition | Cache | Runs checked | Incorrect records | Duplicate writes | Collateral writes | Verified-but-wrong | Skipped-but-wrong |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `all` | `overclock` | t1 seed 4242 | 25 | local | cold | 3 | 0 | 0 | 0 | 0 | 0 |
| `all` | `compiled-parallel` | t1 seed 4242 | 25 | local | cold | 3 | 0 | 0 | 0 | 0 | 0 |
| `all` | `overclock-staged` | t1 seed 4242 | 25 | local | cold | 3 | 0 | 0 | 0 | 0 | 0 |
| `all` | `compiled-single` | t1 seed 4242 | 25 | local | cold | 3 | 2 | 0 | 0 | 0 | 2 |
| `all` | `compiled-single` | t1 seed 4242 | 100 | local | cold | 1 | 0 | 0 | 0 | 0 | 0 |
| `all` | `compiled-parallel` | t1 seed 4242 | 100 | local | cold | 1 | 0 | 0 | 0 | 0 | 0 |
| `all` | `overclock-staged` | t1 seed 4242 | 100 | local | cold | 1 | 0 | 0 | 0 | 0 | 0 |
| `all` | `overclock` | t1 seed 4242 | 100 | local | cold | 1 | 0 | 0 | 0 | 0 | 0 |
| `all` | `overclock` | t1 seed 4242 | 25 | realistic-latency | cold | 3 | 0 | 0 | 0 | 0 | 0 |
| `all` | `compiled-parallel` | t1 seed 4242 | 25 | realistic-latency | cold | 3 | 5 | 0 | 0 | 0 | 0 |
| `all` | `overclock-staged` | t1 seed 4242 | 25 | realistic-latency | cold | 3 | 2 | 0 | 0 | 0 | 2 |
| `all` | `compiled-single` | t1 seed 4242 | 25 | realistic-latency | cold | 3 | 0 | 0 | 0 | 0 | 0 |
| `all` | `overclock` | t1 seed 4242 | 25 | local | warm | 3 | 0 | 0 | 0 | 0 | 0 |
| `all` | `overclock` | t1 seed 4242 | 25 | realistic-latency | warm | 3 | 0 | 0 | 0 | 0 | 0 |
| `holdout` | `overclock` | t3 seed 9001 (holdout) | 25 | local | cold | 1 | 0 | 0 | 0 | 0 | 0 |
| `holdout` | `overclock-staged` | t3 seed 9001 (holdout) | 25 | local | cold | 1 | 0 | 0 | 0 | 0 | 0 |
| `holdout` | `compiled-parallel` | t3 seed 9001 (holdout) | 25 | local | cold | 1 | 0 | 0 | 0 | 0 | 0 |
| `holdout` | `overclock` | t4 seed 9101 (holdout) | 25 | local | cold | 1 | 14 | 0 | 0 | 0 | 0 |
| `holdout` | `overclock-staged` | t4 seed 9101 (holdout) | 25 | local | cold | 1 | 14 | 0 | 0 | 0 | 0 |
| `holdout` | `compiled-parallel` | t4 seed 9101 (holdout) | 25 | local | cold | 1 | 14 | 0 | 0 | 0 | 0 |
| `holdout` | `overclock` | t3 seed 9001 (holdout) | 25 | realistic-latency | cold | 1 | 0 | 0 | 0 | 0 | 0 |
| `holdout` | `overclock-staged` | t3 seed 9001 (holdout) | 25 | realistic-latency | cold | 1 | 0 | 0 | 0 | 0 | 0 |
| `holdout` | `compiled-parallel` | t3 seed 9001 (holdout) | 25 | realistic-latency | cold | 1 | 0 | 0 | 0 | 0 | 0 |
| `holdout` | `overclock` | t4 seed 9101 (holdout) | 25 | realistic-latency | cold | 1 | 14 | 0 | 0 | 0 | 0 |
| `holdout` | `overclock-staged` | t4 seed 9101 (holdout) | 25 | realistic-latency | cold | 1 | 14 | 0 | 0 | 0 | 0 |
| `holdout` | `compiled-parallel` | t4 seed 9101 (holdout) | 25 | realistic-latency | cold | 1 | 14 | 0 | 0 | 0 | 0 |
| `modes@speed-standard` | `overclock` | t1 seed 4242 | 25 | local | cold | 1 | 0 | 0 | 0 | 0 | 0 |
| `modes@speed-fast` | `overclock` | t1 seed 4242 | 25 | local | cold | 1 | 0 | 0 | 0 | 0 | 0 |
| `modes@e-standard` | `overclock` | t1 seed 4242 | 25 | local | cold | 3 | 0 | 0 | 0 | 0 | 0 |
| `modes@e-fast` | `overclock` | t1 seed 4242 | 25 | local | cold | 3 | 14 | 0 | 0 | 0 | 0 |
| `modes@e2-fast` | `overclock` | t1 seed 4242 | 25 | local | cold | 3 | 0 | 0 | 0 | 0 | 0 |
| `modes@e2-standard` | `overclock` | t1 seed 4242 | 25 | local | cold | 3 | 14 | 0 | 0 | 0 | 0 |
| `modes@c-standard` | `compiled-parallel` | t1 seed 4242 | 25 | local | cold | 2 | 0 | 0 | 0 | 0 | 0 |
| `modes@c-fast` | `compiled-parallel` | t1 seed 4242 | 25 | local | cold | 2 | 0 | 0 | 0 | 0 | 0 |
| `modes@scale-fast` | `overclock` | t1 seed 4242 | 500 | local | cold | 1 | 0 | 0 | 0 | 0 | 0 |

## Limitations

- **E is not faster than C** on t1 seed 4242, 25 records, local (n=3 vs 3): 95.8 s vs 42.4 s median wall (0.44×).
- **E does not reach its first verified action sooner than C** on t1 seed 4242, 25 records, local (n=3 vs 3): 95.0 s vs 41.7 s.
- **E is not faster than C** on t1 seed 4242, 100 records, local (n=1 vs 1): 107.4 s vs 57.6 s median wall (0.54×).
- **E does not reach its first verified action sooner than C** on t1 seed 4242, 100 records, local (n=1 vs 1): 103.3 s vs 54.6 s.
- **E is not faster than C** on t1 seed 4242, 25 records, realistic-latency (n=3 vs 3): 2.1 min vs 95.6 s median wall (0.78×).
- **E does not reach its first verified action sooner than C** on t1 seed 4242, 25 records, realistic-latency (n=3 vs 3): 117.1 s vs 43.7 s.
- **E is not faster than C** on t3 seed 9001 (holdout), 25 records, local (n=1 vs 1): 54.4 s vs 16.2 s median wall (0.30×).
- **E does not reach its first verified action sooner than C** on t3 seed 9001 (holdout), 25 records, local (n=1 vs 1): 54.2 s vs 15.9 s.
- **E is not faster than C** on t3 seed 9001 (holdout), 25 records, realistic-latency (n=1 vs 1): 31.3 s vs 20.8 s median wall (0.66×).
- **E does not reach its first verified action sooner than C** on t3 seed 9001 (holdout), 25 records, realistic-latency (n=1 vs 1): 28.0 s vs 19.3 s.
- **`overclock` is slower than `compiled-single`** on t1 seed 4242, 25 records, local, cold, suite `all`: median wall 95.8 s vs 59.0 s (0.62×; n=3 vs 3).
- **`overclock-staged` is slower than `compiled-single`** on t1 seed 4242, 25 records, local, cold, suite `all`: median wall 3.2 min vs 59.0 s (0.31×; n=3 vs 3).
- **`overclock-staged` is slower than `compiled-single`** on t1 seed 4242, 100 records, local, cold, suite `all`: median wall 2.5 min vs 59.7 s (0.40×; n=1 vs 1).
- **`overclock` is slower than `compiled-single`** on t1 seed 4242, 100 records, local, cold, suite `all`: median wall 107.4 s vs 59.7 s (0.56×; n=1 vs 1).
- **`overclock` is slower than `compiled-single`** on t1 seed 4242, 25 records, realistic-latency, cold, suite `all`: median wall 2.1 min vs 86.7 s (0.70×; n=3 vs 3).
- **`compiled-parallel` is slower than `compiled-single`** on t1 seed 4242, 25 records, realistic-latency, cold, suite `all`: median wall 95.6 s vs 86.7 s (0.91×; n=3 vs 3).
- **`overclock-staged` is slower than `compiled-single`** on t1 seed 4242, 25 records, realistic-latency, cold, suite `all`: median wall 3.0 min vs 86.7 s (0.48×; n=3 vs 3).
- **`overclock` is slower than `compiled-parallel`** on t3 seed 9001 (holdout), 25 records, local, cold, suite `holdout`: median wall 54.4 s vs 16.2 s (0.30×; n=1 vs 1).
- **`overclock-staged` is slower than `compiled-parallel`** on t3 seed 9001 (holdout), 25 records, local, cold, suite `holdout`: median wall 67.4 s vs 16.2 s (0.24×; n=1 vs 1).
- **`overclock` is slower than `compiled-parallel`** on t3 seed 9001 (holdout), 25 records, realistic-latency, cold, suite `holdout`: median wall 31.3 s vs 20.8 s (0.66×; n=1 vs 1).
- **`overclock-staged` is slower than `compiled-parallel`** on t3 seed 9001 (holdout), 25 records, realistic-latency, cold, suite `holdout`: median wall 67.4 s vs 20.8 s (0.31×; n=1 vs 1).
- `compiled-single` reported 2 incorrect records as SKIPPED (no change needed): a wrong decision, not a failed write (t1 seed 4242, 25 records, local, cold, suite `all`).
- `overclock-staged` reported 2 incorrect records as SKIPPED (no change needed): a wrong decision, not a failed write (t1 seed 4242, 25 records, realistic-latency, cold, suite `all`).
- `overclock`: 1 of 1 runs failed and are excluded from its medians (t4 seed 9101 (holdout), 25 records, local, cold, suite `holdout`).
- `overclock-staged`: 1 of 1 runs failed and are excluded from its medians (t4 seed 9101 (holdout), 25 records, local, cold, suite `holdout`).
- `compiled-parallel`: 1 of 1 runs failed and are excluded from its medians (t4 seed 9101 (holdout), 25 records, local, cold, suite `holdout`).
- `overclock`: 1 of 1 runs failed and are excluded from its medians (t4 seed 9101 (holdout), 25 records, realistic-latency, cold, suite `holdout`).
- `overclock-staged`: 1 of 1 runs failed and are excluded from its medians (t4 seed 9101 (holdout), 25 records, realistic-latency, cold, suite `holdout`).
- `compiled-parallel`: 1 of 1 runs failed and are excluded from its medians (t4 seed 9101 (holdout), 25 records, realistic-latency, cold, suite `holdout`).
- `overclock`: 1 of 3 runs failed and are excluded from its medians (t1 seed 4242, 25 records, local, cold, suite `modes@e-fast`).
- `overclock`: 1 of 3 runs failed and are excluded from its medians (t1 seed 4242, 25 records, local, cold, suite `modes@e2-standard`).
- `2026-10-24T15-36-33.748Z-all.json`: skippedButWrong was added to every run after the suite finished, computed from each run's stored outcomes in the engine (GET /api/runs/<runId>/result) and the checker mismatches already in this file. Nothing else was changed.
- 17 groups have fewer than 3 completed runs; those medians are single observations or pairs, not stable estimates.
- Groups with fewer than 5 completed runs have no p95.
- All results come from the local synthetic arena on the machine listed for each file. The realistic-latency condition injects latency into the arena apps; it does not reproduce real sites' authentication, rate limits, or UI variety.
- Model latency and cost depend on the provider at run time, so reruns vary.
- Warm-start results measure cache reuse. They are not evidence for the compiler or the scheduler.

## Result files

| File | Suite | Created | Machine | Runs | Failed | Spend / budget |
|---|---|---|---|---|---|---|
| `2026-10-24T15-36-33.748Z-all.json` | `all` | 2026-10-24T15:36:33.769Z | darwin, 16 CPUs, 128 GB, Node v24.13.0 | 34 | 0 | $12.24 / $25.00 |
| `2026-10-24T16-30-14.598Z-holdout.json` | `holdout` | 2026-10-24T16:30:14.618Z | darwin, 16 CPUs, 128 GB, Node v24.13.0 | 12 | 6 | $1.37 / $10.00 |
| `2026-10-24T18-59-14.612Z-modes@speed-standard.json` | `modes@speed-standard` | 2026-10-24T18:59:14.634Z | darwin, 16 CPUs, 128 GB, Node v24.13.0 | 1 | 0 | $0.2678 / $3.00 |
| `2026-10-24T19-00-09.135Z-modes@speed-fast.json` | `modes@speed-fast` | 2026-10-24T19:00:09.156Z | darwin, 16 CPUs, 128 GB, Node v24.13.0 | 1 | 0 | $0.3022 / $3.00 |
| `2026-10-24T19-21-57.695Z-modes@e-standard.json` | `modes@e-standard` | 2026-10-24T19:21:57.718Z | darwin, 16 CPUs, 128 GB, Node v24.13.0 | 1 | 0 | $0.1748 / $2.00 |
| `2026-10-24T19-22-59.871Z-modes@e-fast.json` | `modes@e-fast` | 2026-10-24T19:22:59.893Z | darwin, 16 CPUs, 128 GB, Node v24.13.0 | 1 | 0 | $0.8614 / $2.00 |
| `2026-10-24T19-23-37.604Z-modes@e-standard.json` | `modes@e-standard` | 2026-10-24T19:23:37.625Z | darwin, 16 CPUs, 128 GB, Node v24.13.0 | 1 | 0 | $0.1479 / $2.00 |
| `2026-10-24T19-24-26.043Z-modes@e-fast.json` | `modes@e-fast` | 2026-10-24T19:24:26.066Z | darwin, 16 CPUs, 128 GB, Node v24.13.0 | 1 | 1 | $0.8202 / $2.00 |
| `2026-10-24T19-24-56.317Z-modes@e-standard.json` | `modes@e-standard` | 2026-10-24T19:24:56.338Z | darwin, 16 CPUs, 128 GB, Node v24.13.0 | 1 | 0 | $0.3840 / $2.00 |
| `2026-10-24T19-26-36.030Z-modes@e-fast.json` | `modes@e-fast` | 2026-10-24T19:26:36.056Z | darwin, 16 CPUs, 128 GB, Node v24.13.0 | 1 | 0 | $0.8291 / $2.00 |
| `2026-10-24T19-29-57.525Z-modes@e2-fast.json` | `modes@e2-fast` | 2026-10-24T19:29:57.547Z | darwin, 16 CPUs, 128 GB, Node v24.13.0 | 1 | 0 | $0.4590 / $2.00 |
| `2026-10-24T19-30-19.558Z-modes@e2-standard.json` | `modes@e2-standard` | 2026-10-24T19:30:19.579Z | darwin, 16 CPUs, 128 GB, Node v24.13.0 | 1 | 0 | $0.1494 / $2.00 |
| `2026-10-24T19-31-13.565Z-modes@e2-fast.json` | `modes@e2-fast` | 2026-10-24T19:31:13.588Z | darwin, 16 CPUs, 128 GB, Node v24.13.0 | 1 | 0 | $0.4194 / $2.00 |
| `2026-10-24T19-31-32.780Z-modes@e2-standard.json` | `modes@e2-standard` | 2026-10-24T19:31:32.801Z | darwin, 16 CPUs, 128 GB, Node v24.13.0 | 1 | 0 | $0.1551 / $2.00 |
| `2026-10-24T19-32-25.276Z-modes@e2-fast.json` | `modes@e2-fast` | 2026-10-24T19:32:25.298Z | darwin, 16 CPUs, 128 GB, Node v24.13.0 | 1 | 0 | $0.4346 / $2.00 |
| `2026-10-24T19-32-44.535Z-modes@e2-standard.json` | `modes@e2-standard` | 2026-10-24T19:32:44.557Z | darwin, 16 CPUs, 128 GB, Node v24.13.0 | 1 | 1 | $0.2580 / $2.00 |
| `2026-10-24T19-33-40.741Z-modes@c-standard.json` | `modes@c-standard` | 2026-10-24T19:33:40.761Z | darwin, 16 CPUs, 128 GB, Node v24.13.0 | 1 | 0 | $0.1488 / $2.00 |
| `2026-10-24T19-34-18.610Z-modes@c-fast.json` | `modes@c-fast` | 2026-10-24T19:34:18.632Z | darwin, 16 CPUs, 128 GB, Node v24.13.0 | 1 | 0 | $0.3488 / $2.00 |
| `2026-10-24T19-34-39.532Z-modes@c-standard.json` | `modes@c-standard` | 2026-10-24T19:34:39.554Z | darwin, 16 CPUs, 128 GB, Node v24.13.0 | 1 | 0 | $0.1793 / $2.00 |
| `2026-10-24T19-35-32.582Z-modes@c-fast.json` | `modes@c-fast` | 2026-10-24T19:35:32.604Z | darwin, 16 CPUs, 128 GB, Node v24.13.0 | 1 | 0 | $0.2975 / $2.00 |
| `2026-10-24T19-51-11.130Z-modes@scale-fast.json` | `modes@scale-fast` | 2026-10-24T19:51:11.149Z | darwin, 16 CPUs, 128 GB, Node v24.13.0 | 1 | 0 | $0.4516 / $1.50 |

Notes recorded by the harness:

- `2026-10-24T15-36-33.748Z-all.json`: Command: tsx packages/benchmarks/src/cli.ts --suite all --only overclock,overclock-staged,compiled-parallel,compiled-single --budget 25
- `2026-10-24T15-36-33.748Z-all.json`: Code version: e14db0e (uncommitted changes, tree digest d9764c297218).
- `2026-10-24T15-36-33.748Z-all.json`: External baseline: runExternal from packages/external-baselines.
- `2026-10-24T15-36-33.748Z-all.json`: Engine 0.1.0. Planner claude-opus-5-5, helper claude-haiku-5-5 (Anthropic available). JEV jev-latest / jev-preview (available). Browser available.
- `2026-10-24T15-36-33.748Z-all.json`: skippedButWrong was added to every run after the suite finished, computed from each run's stored outcomes in the engine (GET /api/runs/<runId>/result) and the checker mismatches already in this file. Nothing else was changed.
- `2026-10-24T16-30-14.598Z-holdout.json`: Command: tsx packages/benchmarks/src/cli.ts --suite holdout --budget 10
- `2026-10-24T16-30-14.598Z-holdout.json`: Code version: e14db0e (uncommitted changes, tree digest b59e0e950646).
- `2026-10-24T16-30-14.598Z-holdout.json`: Engine 0.1.0. Planner claude-opus-5-5, helper claude-haiku-5-5 (Anthropic available). JEV jev-latest / jev-preview (available). Browser available.
- `2026-10-24T16-30-14.598Z-holdout.json`: Holdout code freeze: freeze-2026-10-24-e14db0e-tree-b59e0e950646.
- `2026-10-24T18-59-14.612Z-modes@speed-standard.json`: Command: tsx packages/benchmarks/src/cli.ts --mode overclock --records 25 --trials 1 --engine http://127.0.0.1:4041 --label speed-standard --budget 3
- `2026-10-24T18-59-14.612Z-modes@speed-standard.json`: Code version: 7b38a24 (uncommitted changes, tree digest ff50aef7c39e).
- `2026-10-24T18-59-14.612Z-modes@speed-standard.json`: Engine 0.1.0. Planner claude-opus-5-5, helper claude-haiku-5-5 (Anthropic available). JEV jev-latest / jev-preview (available). Browser available.
- `2026-10-24T19-00-09.135Z-modes@speed-fast.json`: Command: tsx packages/benchmarks/src/cli.ts --mode overclock --records 25 --trials 1 --engine http://127.0.0.1:4042 --label speed-fast --budget 3
- `2026-10-24T19-00-09.135Z-modes@speed-fast.json`: Code version: 7b38a24 (uncommitted changes, tree digest 96a356e0b4e9).
- `2026-10-24T19-00-09.135Z-modes@speed-fast.json`: Engine 0.1.0. Planner claude-opus-5-5, helper claude-haiku-5-5 (Anthropic available). JEV jev-latest / jev-preview (available). Browser available.
- `2026-10-24T19-21-57.695Z-modes@e-standard.json`: Command: tsx packages/benchmarks/src/cli.ts --mode overclock --records 25 --trials 1 --engine http://127.0.0.1:4041 --label e-standard --budget 2
- `2026-10-24T19-21-57.695Z-modes@e-standard.json`: Code version: 1a0c9d5 (uncommitted changes, tree digest 5cb163877670).
- `2026-10-24T19-21-57.695Z-modes@e-standard.json`: Engine 0.1.0. Planner claude-opus-5-5, helper claude-haiku-5-5 (Anthropic available). JEV jev-latest / jev-preview (available). Browser available.
- `2026-10-24T19-22-59.871Z-modes@e-fast.json`: Command: tsx packages/benchmarks/src/cli.ts --mode overclock --records 25 --trials 1 --engine http://127.0.0.1:4042 --label e-fast --budget 2
- `2026-10-24T19-22-59.871Z-modes@e-fast.json`: Code version: 88f4d66 (uncommitted changes, tree digest bd0d4b0fb310).
- `2026-10-24T19-22-59.871Z-modes@e-fast.json`: Engine 0.1.0. Planner claude-opus-5-5, helper claude-haiku-5-5 (Anthropic available). JEV jev-latest / jev-preview (available). Browser available.
- `2026-10-24T19-23-37.604Z-modes@e-standard.json`: Command: tsx packages/benchmarks/src/cli.ts --mode overclock --records 25 --trials 1 --engine http://127.0.0.1:4041 --label e-standard --budget 2
- `2026-10-24T19-23-37.604Z-modes@e-standard.json`: Code version: 88f4d66 (uncommitted changes, tree digest 7622fc6b5afa).
- `2026-10-24T19-23-37.604Z-modes@e-standard.json`: Engine 0.1.0. Planner claude-opus-5-5, helper claude-haiku-5-5 (Anthropic available). JEV jev-latest / jev-preview (available). Browser available.
- `2026-10-24T19-24-26.043Z-modes@e-fast.json`: Command: tsx packages/benchmarks/src/cli.ts --mode overclock --records 25 --trials 1 --engine http://127.0.0.1:4042 --label e-fast --budget 2
- `2026-10-24T19-24-26.043Z-modes@e-fast.json`: Code version: 88f4d66 (uncommitted changes, tree digest af4fbc20653a).
- `2026-10-24T19-24-26.043Z-modes@e-fast.json`: Engine 0.1.0. Planner claude-opus-5-5, helper claude-haiku-5-5 (Anthropic available). JEV jev-latest / jev-preview (available). Browser available.
- `2026-10-24T19-24-56.317Z-modes@e-standard.json`: Command: tsx packages/benchmarks/src/cli.ts --mode overclock --records 25 --trials 1 --engine http://127.0.0.1:4041 --label e-standard --budget 2
- `2026-10-24T19-24-56.317Z-modes@e-standard.json`: Code version: 88f4d66 (uncommitted changes, tree digest 07e7fe94f518).
- `2026-10-24T19-24-56.317Z-modes@e-standard.json`: Engine 0.1.0. Planner claude-opus-5-5, helper claude-haiku-5-5 (Anthropic available). JEV jev-latest / jev-preview (available). Browser available.
- `2026-10-24T19-26-36.030Z-modes@e-fast.json`: Command: tsx packages/benchmarks/src/cli.ts --mode overclock --records 25 --trials 1 --engine http://127.0.0.1:4042 --label e-fast --budget 2
- `2026-10-24T19-26-36.030Z-modes@e-fast.json`: Code version: 88f4d66 (uncommitted changes, tree digest d51941df0330).
- `2026-10-24T19-26-36.030Z-modes@e-fast.json`: Engine 0.1.0. Planner claude-opus-5-5, helper claude-haiku-5-5 (Anthropic available). JEV jev-latest / jev-preview (available). Browser available.
- `2026-10-24T19-29-57.525Z-modes@e2-fast.json`: Command: tsx packages/benchmarks/src/cli.ts --mode overclock --records 25 --trials 1 --engine http://127.0.0.1:4042 --label e2-fast --budget 2
- `2026-10-24T19-29-57.525Z-modes@e2-fast.json`: Code version: 88f4d66 (uncommitted changes, tree digest 73b6a85b4630).
- `2026-10-24T19-29-57.525Z-modes@e2-fast.json`: Engine 0.1.0. Planner claude-opus-5-5, helper claude-haiku-5-5 (Anthropic available). JEV jev-latest / jev-preview (available). Browser available.
- `2026-10-24T19-30-19.558Z-modes@e2-standard.json`: Command: tsx packages/benchmarks/src/cli.ts --mode overclock --records 25 --trials 1 --engine http://127.0.0.1:4041 --label e2-standard --budget 2
- `2026-10-24T19-30-19.558Z-modes@e2-standard.json`: Code version: 88f4d66 (uncommitted changes, tree digest 07856e0fffaa).
- `2026-10-24T19-30-19.558Z-modes@e2-standard.json`: Engine 0.1.0. Planner claude-opus-5-5, helper claude-haiku-5-5 (Anthropic available). JEV jev-latest / jev-preview (available). Browser available.
- `2026-10-24T19-31-13.565Z-modes@e2-fast.json`: Command: tsx packages/benchmarks/src/cli.ts --mode overclock --records 25 --trials 1 --engine http://127.0.0.1:4042 --label e2-fast --budget 2
- `2026-10-24T19-31-13.565Z-modes@e2-fast.json`: Code version: 8f795a8 (uncommitted changes, tree digest 231a724afc2e).
- `2026-10-24T19-31-13.565Z-modes@e2-fast.json`: Engine 0.1.0. Planner claude-opus-5-5, helper claude-haiku-5-5 (Anthropic available). JEV jev-latest / jev-preview (available). Browser available.
- `2026-10-24T19-31-32.780Z-modes@e2-standard.json`: Command: tsx packages/benchmarks/src/cli.ts --mode overclock --records 25 --trials 1 --engine http://127.0.0.1:4041 --label e2-standard --budget 2
- `2026-10-24T19-31-32.780Z-modes@e2-standard.json`: Code version: 8f795a8 (uncommitted changes, tree digest 1045e32385e3).
- `2026-10-24T19-31-32.780Z-modes@e2-standard.json`: Engine 0.1.0. Planner claude-opus-5-5, helper claude-haiku-5-5 (Anthropic available). JEV jev-latest / jev-preview (available). Browser available.
- `2026-10-24T19-32-25.276Z-modes@e2-fast.json`: Command: tsx packages/benchmarks/src/cli.ts --mode overclock --records 25 --trials 1 --engine http://127.0.0.1:4042 --label e2-fast --budget 2
- `2026-10-24T19-32-25.276Z-modes@e2-fast.json`: Code version: 8f795a8 (uncommitted changes, tree digest 246b4c8f3f9a).
- `2026-10-24T19-32-25.276Z-modes@e2-fast.json`: Engine 0.1.0. Planner claude-opus-5-5, helper claude-haiku-5-5 (Anthropic available). JEV jev-latest / jev-preview (available). Browser available.
- `2026-10-24T19-32-44.535Z-modes@e2-standard.json`: Command: tsx packages/benchmarks/src/cli.ts --mode overclock --records 25 --trials 1 --engine http://127.0.0.1:4041 --label e2-standard --budget 2
- `2026-10-24T19-32-44.535Z-modes@e2-standard.json`: Code version: 8f795a8 (uncommitted changes, tree digest a1a5be209854).
- `2026-10-24T19-32-44.535Z-modes@e2-standard.json`: Engine 0.1.0. Planner claude-opus-5-5, helper claude-haiku-5-5 (Anthropic available). JEV jev-latest / jev-preview (available). Browser available.
- `2026-10-24T19-33-40.741Z-modes@c-standard.json`: Command: tsx packages/benchmarks/src/cli.ts --mode parallel --records 25 --trials 1 --engine http://127.0.0.1:4041 --label c-standard --budget 2
- `2026-10-24T19-33-40.741Z-modes@c-standard.json`: Code version: 8f795a8 (uncommitted changes, tree digest 6f4f020ae90e).
- `2026-10-24T19-33-40.741Z-modes@c-standard.json`: Engine 0.1.0. Planner claude-opus-5-5, helper claude-haiku-5-5 (Anthropic available). JEV jev-latest / jev-preview (available). Browser available.
- `2026-10-24T19-34-18.610Z-modes@c-fast.json`: Command: tsx packages/benchmarks/src/cli.ts --mode parallel --records 25 --trials 1 --engine http://127.0.0.1:4042 --label c-fast --budget 2
- `2026-10-24T19-34-18.610Z-modes@c-fast.json`: Code version: 8f795a8 (uncommitted changes, tree digest 80c27bfa1fa9).
- `2026-10-24T19-34-18.610Z-modes@c-fast.json`: Engine 0.1.0. Planner claude-opus-5-5, helper claude-haiku-5-5 (Anthropic available). JEV jev-latest / jev-preview (available). Browser available.
- `2026-10-24T19-34-39.532Z-modes@c-standard.json`: Command: tsx packages/benchmarks/src/cli.ts --mode parallel --records 25 --trials 1 --engine http://127.0.0.1:4041 --label c-standard --budget 2
- `2026-10-24T19-34-39.532Z-modes@c-standard.json`: Code version: 8f795a8 (uncommitted changes, tree digest 6c62ea86c5cb).
- `2026-10-24T19-34-39.532Z-modes@c-standard.json`: Engine 0.1.0. Planner claude-opus-5-5, helper claude-haiku-5-5 (Anthropic available). JEV jev-latest / jev-preview (available). Browser available.
- `2026-10-24T19-35-32.582Z-modes@c-fast.json`: Command: tsx packages/benchmarks/src/cli.ts --mode parallel --records 25 --trials 1 --engine http://127.0.0.1:4042 --label c-fast --budget 2
- `2026-10-24T19-35-32.582Z-modes@c-fast.json`: Code version: 8f795a8 (uncommitted changes, tree digest 3f23225cb631).
- `2026-10-24T19-35-32.582Z-modes@c-fast.json`: Engine 0.1.0. Planner claude-opus-5-5, helper claude-haiku-5-5 (Anthropic available). JEV jev-latest / jev-preview (available). Browser available.
- `2026-10-24T19-51-11.130Z-modes@scale-fast.json`: Command: tsx packages/benchmarks/src/cli.ts --mode overclock --records 500 --trials 1 --engine http://127.0.0.1:4000 --label scale-fast --budget 1.5 --timeout 15
- `2026-10-24T19-51-11.130Z-modes@scale-fast.json`: Code version: 8f795a8 (uncommitted changes, tree digest 3a97c41263cf).
- `2026-10-24T19-51-11.130Z-modes@scale-fast.json`: Engine 0.1.0. Planner claude-opus-5-5, helper claude-haiku-5-5 (Anthropic available). JEV jev-latest / jev-preview (available). Browser available.

## Methodology

### Modes

|  | CLI mode | Label | Intelligence | Concurrency | Workers | What it is |
|---|---|---|---|---|---|---|
| A | `sequential` | `sequential-agent` | — | — | up to 1 | One model-driven browser agent works through the records one at a time, one model call per action. No compiler, no parallelism. |
| B | `compiled` | `compiled-single` | single-planner | fixed | up to 1 | A single planner compiles the task into a program; one worker executes it without per-step model calls. |
| C | `parallel` | `compiled-parallel` | single-planner | fixed | 8–8 | Same single-planner compiled program, executed by a fixed pool of 8 workers. |
| D | `staged` | `overclock-staged` | adaptive | adaptive | up to 16 | Full discovery swarm and adaptive concurrency, but stage-gated: discovery, planning, compilation, and execution run strictly one after another. |
| E | `overclock` | `overclock` | adaptive | adaptive | up to 16 | Streaming discovery, incremental compilation, and online optimization: validated fragments start executing while discovery and planning continue. |

Every run also sets `thumbnails: false` and `cache: "cold"` (or `"warm"` for warm-start runs). The optional `external` label runs an external browser-agent baseline through an adapter on the same scenario and is judged by the same checker.

### What is measured

- **Wall time** comes from the engine's run summary and starts when the instruction is submitted, so it includes discovery and planning. Per-stage times (`stageMs`), overlap, and recovery time also come from the summary.
- **Time to first verified action** is the summary's `firstVerifiedMs`: time from submission until the first useful action was read back and verified. Runs that never verified anything are counted separately, not as a number.
- **Accuracy** is the arena checker's `correctRecords / totalRecords`, read from `GET /api/check` immediately after the run completes. The checker holds ground truth the engine never sees, so accuracy never depends on what the engine claims. **Engine-verified** is the engine's own claim, shown for contrast: the share of input records it reports VERIFIED or correctly SKIPPED. Records that a later phase derives (such as customers to hold) aren't input records and aren't counted. Runs recorded before that rule also counted derived records, so the column is n/a for them.
- **Correct records per minute** = checker-correct records ÷ wall minutes.
- **Cost** is the reported model cost per run. **Cost per correct record** = total cost ÷ total checker-correct records over a group's completed runs.
- **Model calls**, **tokens**, and **utilization** are engine-reported.
- **Duplicate writes**, **collateral writes**, and **incorrect records** come from the checker. **Verified-but-wrong** counts records the engine reported `VERIFIED` that the checker marks incorrect. All should be 0.

### Conditions

Each condition is applied through the arena variations API after the scenario is prepared and before the run starts. It is identical for every mode. Conditions are reported separately and never pooled.

- `local`: No injected latency: the arena apps respond as fast as localhost allows.
- `realistic-latency`: Every app in the scenario gets 150 ms base latency ± 100 ms jitter, and 5% of requests take an extra 1200 ms.

### Fairness controls

- Every run starts from the same arena state. A cold run loads the scenario fresh (`POST /api/scenario` with the same seed, template, and record count). A warm run resets that same scenario (`POST /api/reset`). The variations are then set to the run's condition, with everything else at defaults.
- Before each run, the harness checks that the arena serves the requested seed, template, and record count, and the same dataset (by hash) as earlier runs with that key. A mismatch fails the run instead of producing an incomparable number.
- Every mode gets the same goal, applications, and records (built from the scenario). Only the mode overrides above differ. Thumbnails are off for all runs, and browser settings are the engine's own, identical for every mode.
- Every mode is judged by the same success criteria: the arena checker.
- Runs execute one at a time, never concurrently. Trials are interleaved across labels and the label order rotates per trial, so drift in model latency or machine load spreads evenly.
- Runs are ordered by importance (E vs C vs D at 25 records under both conditions first), so a budget cut removes the least important runs.

### Cold start and warm start

Cold runs ignore cached app models and compiled programs. In the `all` suite, every cold E trial is followed immediately by a warm run on a reset of the same scenario, which may reuse what the cold run cached. Warm results appear in their own tables and are never compared with cold results: a warm speedup measures cache reuse, not the compiler or the scheduler.

### Holdout

Scenarios using `t3-crm-status-sync` or `t4-holdout`, or a seed of 9000 or more, are holdout scenarios, never used while developing prompts, heuristics, or the optimizer. The `holdout` suite runs E, D, and C on `t4-holdout` seed 9101 and `t3-crm-status-sync` seed 9001, cold, under both conditions. The harness refuses to run any holdout scenario unless `OVERCLOCK_HOLDOUT_FROZEN` names a code-freeze identifier, and records that identifier in the result file. Holdout results are reported in their own section.

### Ablations

| Rung | Config | Compared with | Isolates |
|---|---|---|---|
| `ablation:no-swarm-no-compiler` | mode sequential-agent, max 1 workers | — | baseline |
| `ablation:compiler-only` | mode compiled-single, intelligence single-planner, concurrency fixed, max 1 workers | `ablation:no-swarm-no-compiler` | compiler (by addition) |
| `ablation:compiler+fixed-parallel` | mode compiled-parallel, intelligence single-planner, concurrency fixed, max 8 workers, initial 8 | `ablation:compiler-only` | fixed parallelism (8 workers) (by addition) |
| `ablation:compiler+adaptive-scheduling` | mode compiled-parallel, intelligence single-planner, concurrency adaptive, max 16 workers | `ablation:compiler+fixed-parallel` | adaptive scheduling (up to 16 workers) (by addition) |
| `ablation:full` | mode overclock, intelligence adaptive, concurrency adaptive, max 16 workers | `ablation:compiler+adaptive-scheduling` | adaptive intelligence with streaming (full E) (by addition) |
| `ablation:full-no-jev` | mode overclock, intelligence adaptive, concurrency adaptive, max 16 workers, JEV off | `ablation:full` | JEV reflex path (by removal) |
| `ablation:full-no-competitive-synthesis` | mode overclock, intelligence adaptive, concurrency adaptive, max 16 workers, competitiveSynthesis off | `ablation:full` | competitive synthesis (by removal) |
| `ablation:overclock-no-streaming` | mode overclock, intelligence adaptive, concurrency adaptive, max 16 workers, streaming off | `ablation:full` | streaming execution (by removal) |
| `ablation:overclock-no-access-paths` | mode overclock, intelligence adaptive, concurrency adaptive, max 16 workers, accessPaths off | `ablation:full` | access-path substitution (by removal) |
| `ablation:overclock-no-write-canary` | mode overclock, intelligence adaptive, concurrency adaptive, max 16 workers, writeCanary off | `ablation:full` | write canary (by removal) |
| `ablation:overclock-no-online-reopt` | mode overclock, intelligence adaptive, concurrency adaptive, max 16 workers, onlineReoptimization off | `ablation:full` | online re-optimization (by removal) |

### Budget

Each invocation has a spend cap (default $50, set with `--budget` or `OVERCLOCK_BENCH_BUDGET_USD`). Once the cumulative reported model cost reaches the cap, no new runs start. Runs that were not executed are listed in the result file's notes; they are never estimated or filled in.

### Statistics

- `n` is the number of completed runs in a group. A run is failed when it errored, timed out, ended in a status other than `completed`, or is missing the checker result (or, for engine runs, the engine summary). Failed runs are counted separately and excluded from every median.
- Medians are over completed runs. p95 uses linear interpolation and is shown only when n ≥ 5; otherwise the cell reads "n/a (n=…)".
- Runs pool only when suite, label, scenario (template and seed), record count, cache state, condition, and holdout status all match.
- Speedups compare labels only within one suite and only when scenario, record count, cache state, condition, and holdout status match. Wall-time speedup = baseline median ÷ candidate median (above 1 means the candidate is faster). Correct/min ratio = candidate median ÷ baseline median.
- Parallel scaling is reported in its own section, separate from compiler effects.
