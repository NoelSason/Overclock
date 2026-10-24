# Overclock Network

The Overclock Network lets independent Overclock runtimes share validated, portable execution
capabilities through SpacetimeDB. One runtime discovers how to do a task on an application;
another runtime that has never seen the application reuses that knowledge with less discovery
and fewer model calls, after checking it against its own live view of the app.

**Status (2026-10-24): Working, with one recorded live A→B run.** The contracts, the SpacetimeDB
module, the capability layer (export, sanitize, analyze, rebind), the network client, the
validation worker, and the engine integration exist and are tested. `pnpm network:demo` runs
the full transfer between independent runtimes and exits non-zero unless every acceptance
check passes. See [Results](#results). Repair coordination (`reportFailure`, repair leases) is
implemented and tested at the client level, but the engine doesn't start repair jobs yet.

## Research question

Can a fresh runtime execute a compatible workflow with less discovery and fewer model calls
because another runtime already learned it?

This is contribution B. It is measured separately from contribution A (first-run streaming
optimization) and never pooled with it.

| Knowledge state | Local cache | Network | Comparison |
| --- | --- | --- | --- |
| Global cold start | empty | nothing published | Baseline for both contributions |
| Local cold, network warm | empty | a validated, active capability exists | Contribution B |
| Local warm | this runtime ran the task before | not used | Cache reuse; reported apart, not a research claim |

### Knowledge policies

`RunConfig.knowledge` selects what a run may use. When it is omitted, it follows the legacy
`cache` flag: `cold` means `strict-cold`, and `warm` means `local-only`.

| Policy | Reads local cache | Reads the network | Publishes | Works today |
| --- | --- | --- | --- | --- |
| `strict-cold` | no | no | no | Yes |
| `local-only` | yes, when `cache: "warm"` | no | no | Yes. A warm hit runs staged in every mode, because there is no plan to stream. |
| `network-read` | no | yes | no | Yes |
| `network-read-and-contribute` | no | yes | yes, after a run where every record verified | Yes |

Set it with `pnpm cli run --knowledge <policy>`, the SDK, or `POST /api/runs`. The engine's
network must also be enabled (`OVERCLOCK_NETWORK_ENABLED=true`); otherwise network policies
report `NETWORK_UNAVAILABLE` and discover cold.

## Component status

| Component | Location | Status |
| --- | --- | --- |
| Contracts: capability, compatibility, publication, repair, client interface | `packages/network-contracts` | Working (exercised by the tests in the following rows) |
| Capability layer: export, sanitizer, static analysis, rebinding, registry helpers | `packages/network-capability` | Working (tested): `pnpm test:network-capability` (25 tests) |
| Validation worker | `services/network/validation-worker` | Working (tested): `tests/network-capability/validator.test.ts`; runs as a service in the demo. Picks up proposals that existed before it started. |
| SpacetimeDB module: tables, reducers, procedures, views | `services/network/spacetimedb` | Working (tested): `pnpm test:network` (26 tests) on a real local server |
| Network client and disabled client | `packages/network-client` | Working (tested): `tests/network/` (registry, repair, resilience, disabled) |
| Engine integration: lookup, import, rebind, publish, reuse reports, `network.*` events | `services/engine/src/network.ts` | Working: live A→B run below; unreachable-network fallback in `tests/unit/network-service.test.ts`; publication hash in `tests/network-capability/capability.test.ts` |
| Engine-started repair jobs | `services/engine` | Not wired |
| Dashboard **Knowledge network** panel | `apps/dashboard/src/components/console/network-panel.tsx` | Working (renders the engine's `network.*` events) |
| Two-runtime transfer with ground truth | `scripts/network-demo.ts` (`pnpm network:demo`) | Working: one recorded run, below |
| Benchmark arm: network warm vs strict cold | `scripts/network-demo.ts` (runtime C) | One trial, below; not part of the benchmark harness |

## Portable capabilities

A **portable capability** (`PortableCapability`, schema version `"1"`, at most 256 KiB) is a
versioned, sanitized execution artifact. It contains:

- **Applications:** a logical name, a normalized origin (the only origin its steps may touch),
  route families, an interface fingerprint, and coarse compatibility classes (role class,
  locale, feature variant).
- **Intent:** a canonical operation signature (a hash of the normalized task rules and record
  schema), a description, and the input record fields.
- **Procedure:** a Procedure DSL plan whose control references are portable control keys, for
  example `Support:/tickets/:id/edit:select:status`, instead of observation-local ids.
- **Controls:** semantic, data-free descriptors (app, route family, kind, role, name, label,
  options, table headers, form signature, effect) with semantic locator strategies only. No
  positional CSS.
- **Pages:** route families, parameterized path templates (never concrete ids), fingerprints,
  and how to reach a parameterized page during rebinding.
- **Requirements:** permissions, allowed origins, and every expected effect by step.
- **Verification:** the read-back rules of every write.
- **Provenance:** a SHA-256 artifact hash over canonical JSON, timestamps, verified-receipt
  count from the publishing run (evidence, not trust), and the parent version for repairs.

The `publisherId` is set from the authenticated SpacetimeDB identity. The module rejects a
payload whose `publisherId` is not the caller.

## How a capability moves

### Operation identity

A capability may run only for the operation it was learned for. Its operation identity
(`intent.canonicalOperation`) is `op2:` plus a SHA-256 of the exact instructions and the sorted
record field names. Only presentation is normalized before hashing (Unicode form, line endings,
trailing whitespace): every quoted value, number, threshold, and condition is part of the
identity. "Set the status to \"approved\"" and "…\"rejected\"", or "2 or more" and "3 or more",
are different operations and never share a capability. Different record ids and values don't
change the identity, so the same instructions over new records reuse it.

The identity is a hash, so the instructions themselves (which may contain business values) never
leave the runtime. The human-readable `intent.description` is a separate, sanitized string, with
values and numbers replaced by placeholders, and is never used for matching.

Until 2026-10-24 the identity hashed that lossy description instead, so a request for
"rejected" could look up and execute a capability learned for "approved". Capabilities from that
scheme carry a bare 64-hex identity; static analysis rejects them (`operation-identity`), so the
validator fails them and every importer refuses them. They must be republished. The same exact
identity keys the local plan cache, and a cached entry is served only under the exact key it was
stored with.

A consequence: instructions that state the batch size ("these 25 orders") are a different
operation from the same instructions with another size. Reuse across batch sizes needs
instructions that don't state the size.

### Lookup

1. The engine looks up by exact operation identity and the run's origins, and considers only
   candidates with that identity; it checks the identity again on the fetched artifact, so a
   registry that mislabels an artifact can't make another operation's writes run. (The client also ranks by
   non-sensitive **interface signatures**: origin, route family, page fingerprint, region
   fingerprints, and role class. The engine doesn't send signatures yet, because it looks up
   before observing anything.)
2. It subscribes only to registry rows for those origins (`watchOrigins`), then looks up
   candidates in its client cache. A lookup is bounded by `OVERCLOCK_NETWORK_LOOKUP_TIMEOUT_MS`
   (default 500 ms) and reports its source: `local-cache`, `network`, `negative-cache`, or
   `timeout`. An empty answer is remembered for 15 s.
3. Candidates are ranked deterministically. No artifact is downloaded and no model is called
   during lookup.

### Import

1. Fetch the chosen version's payload on demand, from a local content-addressed cache first,
   and verify its hash.
2. Run static analysis on it.
3. **Rebind:** visit the route families it needs in a mutation-blocked context (a targeted
   mini-crawl), build a local app model, and bind every portable control to exactly one local
   control with deterministic rules. The outcome is one of `EXACT_COMPATIBLE`,
   `STRUCTURALLY_COMPATIBLE`, `REQUIRES_REBINDING`, `REQUIRES_REPAIR`, `INCOMPATIBLE`, or
   `NO_CAPABILITY`. Writes are safe only when their controls bound uniquely and their effects
   match the declared ones.
4. Rewrite the plan to local ids, compile it locally, and run it under every local gate.
5. Report the reuse with sanitized counters only.

When the network is disabled or unreachable, the runtime falls back to normal discovery.
`DisabledNetworkClient` answers every lookup with "no capability".

### Publication

1. **Export and sanitize** on the publishing runtime. Credentials or record data in
   procedure literals reject the capability; data in descriptors is redacted. See
   [`SECURITY.md`](SECURITY.md#network-publication-pipeline-and-trust-boundaries).
2. **Propose.** The module checks size, byte count, content hash, publisher identity, origins,
   version order, the parent version, and the canonical operation, and scans every string for
   secrets, script URLs, and foreign absolute URLs.
3. **Validate.** An authorized validator identity other than the publisher re-sanitizes,
   re-analyzes, rebinds, and dry-runs the read segments, then records `pass` or `fail` with a
   digest of sanitized evidence. Writes are never executed during validation.
4. **Promote.** An admin promotes a `VERIFIED` version through `CANARY` to `ACTIVE`. Promotion
   needs an independent passing validation, a version newer than the active one, and the
   current selection version (compare-and-swap).

Publication states: `PROPOSED → VALIDATING → VERIFIED → CANARY → ACTIVE`. Any non-terminal
state can be `QUARANTINED`, which returns to `VERIFIED` after re-validation or ends in
`REVOKED`. An admin can restore the previous known-good version.

### Repair

A runtime that hits a failure on an imported capability reports a sanitized **failure
signature**: the capability, the version, a category (`control-missing`,
`control-ambiguous`, `dialog`, `hidden-control`, `fingerprint-drift`,
`verification-mismatch`, `precondition`, `other`), and the portable control key or route
family that broke. Reports with the same signature join one repair job. A repairer claims a
lease and gets a **fencing token** that increases on every claim; renewals and the final
proposal must present the current token, so a holder whose lease expired can't overwrite a
newer repair. The repaired capability goes through publication like any other version.

### Live updates

Clients receive registry changes through their subscriptions. Each change carries the
server commit time and the local receive time, so propagation latency is measurable.

## Data model

The module lives in `services/network/spacetimedb/src/index.ts`. Every write goes through a
transactional reducer, and every identity check uses `ctx.sender`.

| Table | Contents |
| --- | --- |
| `network_config` (private) | Module owner and counters. |
| `publishers` | Identity, display name, role (`publisher`, `validator`, `repairer`, `admin`), status (`pending`, `authorized`, `suspended`). |
| `applications` | Registered origins and their route families. |
| `ui_variants` | Interface fingerprints and compatibility classes per application. |
| `capabilities`, `capability_apps` | Capability registry and its links to applications. |
| `capability_versions` | Version metadata, state, content hash, validation counts. |
| `capability_payloads` | The sanitized artifact, fetched on demand. |
| `active_selections` | The active version per capability and UI variant. |
| `repair_jobs` | Repair jobs, lease holder, fencing token, attempts. |
| `validation_records` | Validation results with evidence digests. |
| `reuse_stats` | Sanitized reuse counters. |
| `activity` | Bounded activity feed (latest 1000 rows), sanitized text. |

Views: `my_publisher` (the caller's own row) and `network_summary`.

Tables other than `network_config` are public to connected clients, including payloads.
Sanitization before publication is what keeps data private.

Reducers: `register_publisher`, `authorize_publisher`, `suspend_publisher`,
`register_application`, `propose_capability`, `record_validation_result`,
`promote_capability_version`, `quarantine_capability_version`, `revoke_capability_version`,
`restore_previous_version`, `report_reuse`, `report_compatibility_failure`,
`claim_repair_lease`, `renew_repair_lease`, `finish_repair_job`, `release_repair_lease`. Several
repair reducers also exist as procedures that return a result.

## Client

`NetworkClient` (`packages/network-client/src/client.ts`) implements `INetworkClient` over one
SpacetimeDB connection per engine process. Browser workers never talk to the network.

- It reads registry metadata from origin-scoped subscriptions, never by streaming payloads.
- It fetches a payload by subscribing to that one version and verifies its hash.
- It keeps a content-addressed artifact cache and its auth token under the runtime's own data
  directory. The token file is `<dataDir>/network-token`, mode 0600, keyed by endpoint host.
- It reconnects with backoff and requires the first connection within 5 s by default.
- `createNetworkClient(config)` returns a `DisabledNetworkClient` when the network is off.

## Setup

These steps prepare a local network for development. The engine doesn't use it yet, so they
are only useful for working on the network code itself.

### Configuration

The following variables are defined in `.env.example` and read by `networkConfigFromEnv`. The
engine doesn't read them yet.

| Variable | Default | Meaning |
| --- | --- | --- |
| `OVERCLOCK_NETWORK_ENABLED` | `false` | Turn the client on. |
| `OVERCLOCK_NETWORK_ENDPOINT` | `ws://127.0.0.1:3100` | SpacetimeDB host. Port 3100 keeps it clear of the dashboard on 3000. |
| `OVERCLOCK_NETWORK_DATABASE` | `overclock-network` | Database name. |
| `OVERCLOCK_NETWORK_MODE` | `network-read` | Default knowledge policy. |
| `OVERCLOCK_NETWORK_PUBLISH_ENABLED` | `false` | Allow publishing. |
| `OVERCLOCK_NETWORK_LOOKUP_TIMEOUT_MS` | `500` | Lookup bound. |
| `OVERCLOCK_DATA_DIR` | `.data/engine` | Per-runtime state: engine database, network token, artifact cache. |
| `OVERCLOCK_RUNTIME_LABEL` | `runtime-a` | Non-sensitive label for the activity feed. |

### Local SpacetimeDB

You need the `spacetime` CLI, version 2.x. If it's missing, the scripts print the install
command.

1. Start the local network. The script starts SpacetimeDB on `127.0.0.1:3100` (the host and
   port of `OVERCLOCK_NETWORK_ENDPOINT`) if it isn't running, installs the module's own
   dependencies (the module is outside the workspace globs and has its own lockfile), publishes
   the module, and regenerates the client bindings:

   ```bash
   pnpm network:dev
   ```

   Add `--clean` to destroy the database's data and republish, or `--database <name>` to use
   another database. The endpoint comes from `OVERCLOCK_NETWORK_ENDPOINT` and must be local.
   Server logs go to `.data/network/`.

2. The CLI identity that publishes becomes the database owner, which the module bootstraps as
   the network's first admin. Every other identity (each runtime and each validator) registers
   as `pending`, then the owner authorizes it:

   ```bash
   pnpm network:authorize --identity <hex> --role publisher
   ```

   Replace `<hex>` with the runtime's identity (`NetworkClient.identity`). The role is one of
   `publisher`, `validator`, `repairer`, or `admin`.

3. **Optional:** regenerate the bindings on their own after a module change:

   ```bash
   pnpm network:generate
   ```

4. **Optional:** inspect state with SQL. Pass `-s local`, because the CLI's default server is
   Maincloud:

   ```bash
   spacetime sql -s local overclock-network "SELECT * FROM capability_versions"
   ```

The dashboard keeps `http://localhost:3000`, and `pnpm test:e2e` starts its own dashboard on
port 3200, so neither collides with SpacetimeDB on 3100.

### Maincloud

Local SpacetimeDB is the default for development and every test. To deploy to Maincloud, sign
in first (an interactive browser login), then run the deploy script:

```bash
spacetime login
pnpm network:deploy --database <name>
```

Database names are global on Maincloud, so pick a suffixed name. The script never reads,
prints, or stores the CLI token. `--clean` destroys all data in the Maincloud database and
republishes. Then set `OVERCLOCK_NETWORK_ENDPOINT` to the Maincloud host and
`OVERCLOCK_NETWORK_DATABASE` to the name. This path has not been exercised for this report.

### Latency probe

`pnpm network:probe` (`scripts/network-probe.ts`) measures connect time, subscription time,
reducer round trips, and propagation between two client identities on an endpoint. `--read-only` only connects and
subscribes; `--temp` publishes a throwaway database and deletes it afterwards.

```bash
pnpm network:probe --read-only
```

### Tests

```bash
pnpm test:network-capability   # arena in-process; no SpacetimeDB
pnpm test:network              # real local SpacetimeDB (same as pnpm network:test)
```

The network suite starts SpacetimeDB if needed, publishes the module to a fresh database named
`overclock-net-test-<random>`, and deletes it afterwards. Neither suite calls a model.

### Two runtimes

`pnpm network:demo` does everything in this section and the next one for you. It needs the
arena (`pnpm arena`) and a local SpacetimeDB (`pnpm network:dev`). It wipes and republishes a
separate `overclock-demo` database, enrolls separate admin, validator, and runtime identities,
starts runtimes A (:4010), B (:4020), and C (:4030), runs the validator as a service, and
writes `.data/demo/report.json`. Add `--keep` to leave the engines running for the dashboard,
`--variation rename-save` to change the UI before runtime B runs, and `--no-cold-arm` to skip
runtime C.

To run runtimes by hand, give each its own engine port, data directory, and label, so tokens
and caches are never shared:

```bash
OVERCLOCK_ENGINE_PORT=4000 OVERCLOCK_DATA_DIR=.data/runtime-a OVERCLOCK_RUNTIME_LABEL=runtime-a pnpm engine
OVERCLOCK_ENGINE_PORT=4001 OVERCLOCK_DATA_DIR=.data/runtime-b OVERCLOCK_RUNTIME_LABEL=runtime-b pnpm engine
```

Point the CLI at runtime B with `OVERCLOCK_URL=http://127.0.0.1:4001`.

### Validation worker

The worker runs one-shot against a capability file, or continuously against the network:

```bash
pnpm exec tsx services/network/validation-worker/src/main.ts --file cap.json --arena http://127.0.0.1:4100
pnpm exec tsx services/network/validation-worker/src/main.ts --network --arena http://127.0.0.1:4100
```

In network mode it loads the client from `OVERCLOCK_NETWORK_CLIENT_MODULE` (default
`@overclock/network-client`). Credentials come from the environment, and every validator
browser context blocks mutations. The worker is a workspace package
(`services/network/validation-worker` is listed in `pnpm-workspace.yaml`). The SpacetimeDB
module in `services/network/spacetimedb` is not: the `spacetime` CLI builds it with its own
lockfile.

## Metrics

Each run reports `network.lookup`, `network.import`, `network.publish`, and `network.update`
events, and `RunSummary.network` holds lookups, hits, the compatibility outcome, lookup, fetch,
and rebind time, and whether the run published. The engine doesn't estimate avoided discovery
time or model calls; compare against a strict-cold run instead.

## Results

### The website changed between A and B (5 seeds, 2026-10-24)

`pnpm network:demo --records 10 --seed <s> --variation rename-save --warm-arm` on seeds 4242,
1111, 2222, 3333, and 7777: local SpacetimeDB, local arena with no injected latency, mode E with
the default Opus 5.5 fast planner and critic. Each run starts a fresh registry and three engine
processes with separate data dirs and network identities. Between A and B, every edit form's
save button is renamed (CRM "Save changes" → "Update record", Orders "Update order" → "Apply
changes", Support "Save ticket" → "Commit ticket"). B and C run the same new records (seed + 1)
on the changed interface. Each report is in `benchmarks/results/network/`, and the dashboard's
Transfer page renders them.

| | A: cold, publishes | B: imports, rebinds | C: fresh runtime, strict-cold | C again: local warm replay |
| --- | --- | --- | --- | --- |
| Arena checker, every run | 10/10, 0 duplicate, 0 collateral | 10/10, 0, 0 | 10/10, 0, 0 | 10/10, 0, 0 (4 runs) |
| Wall time, median (range) | 19.4 s (18.6–29.6) | **3.3 s (3.0–3.4)** | 18.8 s (18.7–21.2) | 1.1 s (0.8–1.2) |
| First verified write, median | 18.4 s | **2.7 s** | 18.4 s | — |
| Planner calls | 1 (2 in one run) | **0** | 1 | 0 |
| Model cost, median | $0.43 | **$0** | $0.43 | $0 |

- **B against C** (same records, same changed interface, both correct in every run): median 5.9×
  less wall time (5.7–6.4×) and 6.8× sooner to the first verified write (6.5–7.6×), with no
  model call.
- **What B rebound:** all three renamed buttons, by structure (each is the only write button of
  a form whose fields all bound by label), so B's writes ran behind a write canary: one record
  wrote and verified by fresh read-back before the rest. The canary passed for every write
  segment in every run. B bound 24–25 controls with 0 unbound, wrote through browser clicks, and
  every write was confirmed by a fresh read.
- **Distinct runtimes:** in every run A and B had different network identities, the
  capability's publisher was A's identity, and B's local plan cache was empty before its run.
- **Overhead:** publication about 60 ms; validation by a separate identity 1.6–1.8 s (static
  analysis, rebinding, and a read-only dry run; it executes no writes); B's lookup and fetch
  under 20 ms; rebinding 1.2–1.3 s.
- **Local warm replay** (C rerunning its own cached plan) is faster than B, because B pays for
  rebinding and the write canary. It is plain cache reuse, not a transfer between runtimes.
- **Not a fair comparison with older numbers:** the 32.7× and 56× ratios below were measured when
  a cold run took 95–169 s. Cold runs now take about 19 s, so the remaining gap is smaller.
- **Failures:** the first attempt at seed 2222 failed before B: the validator rejected A's
  capability in static analysis (11 ms), and the reason wasn't recorded. The rerun passed. Since
  then the engine runs the same static analysis before publishing and records any rejection.
  The adaptive-concurrency change landed while this series ran: seeds 4242 and 1111 ran before
  it, seeds 2222 (rerun), 3333, and 7777 after.

### A conflicting request reuses nothing (live, 2026-10-24)

`pnpm network:demo --records 10 --variation rename-save --conflict-arm --no-cold-arm`: after A
published, a fourth runtime X (its own identity and data dir, no model access) asked for the same
task with one value changed (the damage-ticket owner "Tier 2" became "Tier 1"), on B's records.
Under the earlier lossy identity, X would have matched A's capability and written "Tier 2".

| Run | X: lookup | X: arena writes | X: receipts, planner calls | B (identical operation, renamed buttons) |
| --- | --- | --- | --- | --- |
| 13:17 PDT, A learned cold | `NO_CAPABILITY` (0 candidates for its operation) | 0 | 0, 0 (run failed: no model to plan with) | 10/10, 0 duplicate, 0 collateral, 3.2 s, 0 planner calls |
| 13:40 PDT, final code (A reused its own cached plan from the 13:17 run: a regression run, no model spend) | `NO_CAPABILITY` | 0 | 0, 0 | 10/10, 0, 0, 3.2 s, 0 planner calls |

The first attempt at 13:15 reported a failed check because of two bugs in the demo's own
measurement (it read the arena's write counters wrongly and took a non-final run status); the
run itself made the same zero writes. Its report is kept in `benchmarks/results/network/`.

### A change rebinding can't prove safe (seed 5151)

`--variation fields-in-tab --expect-refusal --no-cold-arm` moves every edit form's fields into a
tab. B fetched the capability and refused it (`REQUIRES_REPAIR`: `hidden-in-tab` on the Orders
review fields and the Support category, "writes not provably safe"), guessed nothing, planned
cold instead (1 planner call), and passed the checker with 10/10, 0 duplicate, 0 collateral
writes.

### Earlier runs, unchanged interface

One recorded run of `pnpm network:demo --records 10` on 2026-10-24: local SpacetimeDB, local
arena with no injected latency, mode E, template `t1-order-reconcile`. Runtime A used seed 4242.
Runtimes B and C used seed 4243 (different records, same apps). This is one trial; treat the
numbers as a demonstration, not a benchmark.

| | A: cold, contributes | B: network-read | C: fresh runtime, strict-cold |
| --- | --- | --- | --- |
| Arena checker (ground truth) | 10/10, 0 duplicate, 0 collateral writes | 10/10, 0 duplicate, 0 collateral | 10/10, 0 duplicate, 0 collateral |
| Wall time | 97.6 s | 3.0 s | 169.1 s |
| Time to first verified write | 97.3 s | 2.8 s | 168.8 s |
| Planner calls (plan + repair) | 2 | 0 | 3 |
| All model calls | 6 | 0 | 7 |
| Model cost | $0.367 | $0.000 | $0.623 |
| Streaming fallbacks (critique) | 1 | 0 | 1 |

- **What B imported:** `cap_4d4a431303f0e4fc54ffd623@1`, outcome `EXACT_COMPATIBLE`, 24
  controls bound, 0 unbound. Policy `network-import`; no planner, critique, or discovery-swarm
  call.
- **Overhead:** A's lookup 4 ms and publication 58 ms (27 KB, 34 redactions). Validation by a
  separate validator identity took 1,569 ms; promotion by the admin took 7 ms. B's lookup took
  6 ms, the artifact fetch 8 ms, and rebinding (a mutation-blocked mini-crawl) 1,185 ms.
- **B versus C** (same scenario, both correct): 56× less wall time, 61× sooner to the first
  verified write, 0 versus 7 model calls, $0 versus $0.62. C's cold run needed two repair
  rounds (a critique fallback, then a validation round), so it is slower than a typical cold
  run. Against A's cold run, B used about 32× less wall time.
- **Not shown in these runs:** a UI change before B runs (shown above since), repair after a
  breaking change, and more than three runtimes.

A second run on the final code (after the guard and import changes) also passed every check:
A 95.6 s and $0.40, B 2.9 s and $0 (`EXACT_COMPATIBLE`, 25 controls bound), C 94.8 s and $0.39,
all 10/10. B versus C: 32.7× less wall time, 36× sooner to the first verified write. C needed
one repair round there, so this ratio is closer to a typical cold run than the first one.

Bugs this run found and fixed on the way:

- The artifact hash covered `publisherId`, but the client replaces it with the authenticated
  identity, so every published capability failed integrity validation. The engine now
  exports with its own identity.
- A path template written as `{encode($rec.orderId)}` lost its link to the record field, so
  the validator couldn't find a probe record. `encode()` is now recognized.
- The validation worker missed proposals made before it started, and the client could lose a
  freshly issued token when it closed right after connecting. Both are fixed and tested.
