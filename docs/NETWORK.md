# Overclock Network

The Overclock Network lets independent Overclock runtimes share validated, portable execution
capabilities through SpacetimeDB. One runtime discovers how to do a task on an application;
another runtime that has never seen the application reuses that knowledge with less discovery
and fewer model calls, after checking it against its own live view of the app.

**Status (2026-10-24): In progress.** The contracts, the SpacetimeDB module, the capability
layer (export, sanitize, analyze, rebind), the network client, the validation worker, and setup
scripts exist in code. The capability layer and validation worker have passing tests, and the
client and module have tests against a real local SpacetimeDB. The engine doesn't call any of
them yet, so a run with a network knowledge policy behaves like a cold run today.

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
| `local-only` | yes, when `cache: "warm"` | no | no | Modes B–D only. Mode E writes the local cache but never reads it. |
| `network-read` | no | yes | no | No: behaves like a cold run that also writes the local cache |
| `network-read-and-contribute` | no | yes | yes | No: same as `network-read` |

The CLI has no `--knowledge` flag yet. Set the field through the SDK or `POST /api/runs`.

## Component status

| Component | Location | Status |
| --- | --- | --- |
| Contracts: capability, compatibility, publication, repair, client interface | `packages/network-contracts` | Partial (types; exercised by the tests in the following rows) |
| Capability layer: export, sanitizer, static analysis, rebinding, registry helpers | `packages/network-capability` | Partial: `tests/network-capability/` passed (23 tests) on 2026-10-24; not used by the engine |
| Validation worker | `services/network/validation-worker` | Partial: covered by `tests/network-capability/validator.test.ts`; not deployed |
| SpacetimeDB module: tables, reducers, procedures, views | `services/network/spacetimedb` | In progress: `tests/network/registry.test.ts` and `repair.test.ts` run it on a real local server; not run for this report |
| Network client and disabled client | `packages/network-client` | In progress: `tests/network/` (registry, repair, resilience, disabled); not run for this report |
| Setup scripts | `scripts/network-*.ts` | In progress |
| Engine integration: lookup, import, publish, repair, `network.*` events | `services/engine` | Proposed (not wired) |
| Dashboard **Knowledge network** panel | `apps/dashboard/src/components/console/network-panel.tsx` | Partial (renders `network.*` events, which nothing emits yet) |
| Benchmark arm: network warm vs strict cold | `packages/benchmarks` | Proposed |
| Engine-level two-runtime transfer (runtime B executes with less discovery) | none | Not yet automated |

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

### Lookup (design)

1. A runtime takes a lightweight observation of the apps in the run and computes
   non-sensitive **interface signatures**: origin, route family, page fingerprint, region
   fingerprints, and role class.
2. It subscribes only to registry rows for those origins (`watchOrigins`), then looks up
   candidates in its client cache. A lookup is bounded by `OVERCLOCK_NETWORK_LOOKUP_TIMEOUT_MS`
   (default 500 ms) and reports its source: `local-cache`, `network`, `negative-cache`, or
   `timeout`. An empty answer is remembered for 15 s.
3. Candidates are ranked deterministically. No artifact is downloaded and no model is called
   during lookup.

### Import (design)

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
| `OVERCLOCK_NETWORK_ENDPOINT` | `ws://127.0.0.1:3100` | SpacetimeDB host. The default is moving from port 3000 to 3100 so it doesn't collide with the dashboard; check `.env.example` for the current value. |
| `OVERCLOCK_NETWORK_DATABASE` | `overclock-network` | Database name. |
| `OVERCLOCK_NETWORK_MODE` | `network-read` | Default knowledge policy. |
| `OVERCLOCK_NETWORK_PUBLISH_ENABLED` | `false` | Allow publishing. |
| `OVERCLOCK_NETWORK_LOOKUP_TIMEOUT_MS` | `500` | Lookup bound. |
| `OVERCLOCK_DATA_DIR` | `.data/engine` | Per-runtime state: engine database, network token, artifact cache. |
| `OVERCLOCK_RUNTIME_LABEL` | `runtime-a` | Non-sensitive label for the activity feed. |

### Local SpacetimeDB

You need the `spacetime` CLI, version 2.x. If it's missing, the scripts print the install
command.

1. Start the local network. The script starts SpacetimeDB on the host and port of
   `OVERCLOCK_NETWORK_ENDPOINT` if it isn't running, installs the module's own dependencies (the module is outside the workspace globs
   and has its own lockfile), publishes the module, and regenerates the client bindings:

   ```bash
   pnpm exec tsx scripts/network-dev.ts
   ```

   Add `--clean` to destroy the database's data and republish, or `--database <name>` to use
   another database. The endpoint comes from `OVERCLOCK_NETWORK_ENDPOINT` and must be local.
   Server logs go to `.data/network/`.

2. The CLI identity that publishes becomes the database owner, which the module bootstraps as
   the network's first admin. Every other identity (each runtime and each validator) registers
   as `pending`, then the owner authorizes it:

   ```bash
   pnpm exec tsx scripts/network-authorize.ts --identity <hex> --role publisher
   ```

   Replace `<hex>` with the runtime's identity (`NetworkClient.identity`). The role is one of
   `publisher`, `validator`, `repairer`, or `admin`.

3. **Optional:** regenerate the bindings on their own after a module change:

   ```bash
   pnpm exec tsx scripts/network-generate.ts
   ```

4. **Optional:** inspect state with SQL. Pass `-s local`, because the CLI's default server is
   Maincloud:

   ```bash
   spacetime sql -s local overclock-network "SELECT * FROM capability_versions"
   ```

Watch for port collisions. `pnpm dashboard` uses port 3000, which is also SpacetimeDB's own
default, and `pnpm test:e2e` starts a dashboard on port 3100
(`OVERCLOCK_E2E_DASHBOARD_PORT`), which is the network's new default. If you run the network
alongside either one, give one of them another port.

### Maincloud

Local SpacetimeDB is the default for development and every test. To deploy to Maincloud, sign
in first (an interactive browser login), then run the deploy script:

```bash
spacetime login
pnpm exec tsx scripts/network-deploy.ts --database <name>
```

Database names are global on Maincloud, so pick a suffixed name. The script never reads,
prints, or stores the CLI token. `--clean` destroys all data in the Maincloud database and
republishes. Then set `OVERCLOCK_NETWORK_ENDPOINT` to the Maincloud host and
`OVERCLOCK_NETWORK_DATABASE` to the name. This path has not been exercised for this report.

### Latency probe

`scripts/network-probe.ts` measures connect time, subscription time, reducer round trips, and
propagation between two client identities on an endpoint. `--read-only` only connects and
subscribes; `--temp` publishes a throwaway database and deletes it afterwards.

```bash
pnpm exec tsx scripts/network-probe.ts --read-only
```

### Tests

```bash
npx vitest run -c tests/network-capability/vitest.config.ts   # arena in-process; no SpacetimeDB
npx vitest run --config tests/network/vitest.config.ts        # real local SpacetimeDB
```

The network suite starts SpacetimeDB if needed, publishes the module to a fresh database named
`overclock-net-test-<random>`, and deletes it afterwards. Neither suite calls a model.

### Two runtimes

Each runtime needs its own engine port, data directory, and label, so tokens and caches are
never shared:

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
browser context blocks mutations. The worker imports `packages/network-capability` by
relative path, because `services/network/*` is outside the pnpm workspace globs.

## Metrics

When the engine integration lands, each run will report `network.lookup`, `network.import`,
`network.publish`, `network.repair`, and `network.update` events, and `RunSummary.network` will
hold lookups, hits, lookup, fetch, and rebind time, whether the run published, and repairs.
Avoided discovery time and model calls on import are estimates and are marked as such
(`estimated: true`). None of these fields is populated today.
