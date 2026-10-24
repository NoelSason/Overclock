# Overclock security and permission model

Overclock drives real web applications with many browser workers at once, and it takes plans
from a model. This document describes the controls that keep both safe, and where each one
stops. Every section carries a status label (see [`ARCHITECTURE.md`](ARCHITECTURE.md) for the
definitions). Statuses reflect the repository on 2026-10-24.

## Trust boundaries

| Party | Trusted for | Not trusted for |
| --- | --- | --- |
| The person who starts a run | The goal, the records, the app bindings, approvals. | Credentials: a run config can't carry them. |
| The engine process | Everything it enforces in code. | |
| Model output (planner, scouts, critique, repair) | Nothing until the compiler or recovery validates it. | Targets, effects, and values it didn't derive from observed evidence. |
| Page content (text, labels, record data) | Nothing. It is data. | Instructions of any kind. |
| Capabilities from the Overclock Network | Nothing until this runtime has checked, rebound, and compiled them itself. | The publisher's claims about safety or validity. |

The core rule: a model may propose, but only deterministic code decides what runs, on which
origin, with which effect.

## Origin allowlists

**Status: Working (tested)** in `tests/integration/runtime.test.ts`.

Every browser context routes every request through a guard
(`BrowserManager.newContext` in `packages/browser-runtime/src/browser.ts`):

- A request to an origin outside the run's applications is aborted. Malformed URLs are aborted
  too. Only `data:`, `about:`, and `blob:` URLs pass without an origin check.
- A `navigate` node whose resolved URL is off the allowlist raises `OriginBlockedError`, and
  the task fails.
- The compiler rejects an absolute `goto` URL outside the app's origin and any app origin that
  is not allowlisted.

The arena's judge console (port 4100) is never one of a run's applications, so workers can't
reach the judge API.

## Exploration contexts

**Status: Working (tested)** for blocked mutations and origins; **Partial** for risky GETs,
WebSockets, and service workers (implemented, no direct test).

UI scouts and dry-run probes use contexts created with `blockMutations: true`. In those
contexts:

- Every request other than `GET`, `HEAD`, and `OPTIONS` is aborted.
- `GET` requests whose path or query looks state-changing are aborted: `logout`, `signout`,
  `delete`, `remove`, `unsubscribe`, `approve`, `reject`, `confirm`, `toggle`, `archive`,
  `cancel`, `purchase`, `checkout`, `pay`, `send`, `publish`, `reset`, and query parameters such
  as `action=`, `op=`, `do=`, `cmd=`, `delete=`, `remove=`, `confirm=`.
- Every WebSocket is closed with code 1008.
- Service workers are blocked in every context (exploration and execution), so the route guard
  sees every request.
- Native `alert` and `confirm` dialogs are dismissed, which is the safe default.

The crawler adds its own rules. It never follows links named or pointing to log out, sign
out, delete, remove, unsubscribe, or deactivate. It clicks a dialog button only when the
button is clearly informational ("Dismiss", "Close", "Got it", "OK").

A dry run executes a candidate's read segments for its first record in an exploration context.
Write segments, and everything downstream of them, are never executed in a dry run. Each
context counts what it blocked, and the counts appear in app-model and risk-report artifacts.

## Read-only explorer role

**Status: Working (tested)** in the arena (`tests/integration/arena.test.ts`); the engine side
is **Partial**.

The engine signs in twice per app. Execution uses the operator account. Exploration uses a
read-only viewer account (`ARENA_VIEWER_USERNAME`, `ARENA_VIEWER_PASSWORD`, or a `viewer` entry
in `OVERCLOCK_APP_CREDENTIALS`) when the app has one. The arena enforces the role on the server:
a viewer may only send `GET` and `HEAD`, and anything else returns 403.

If the viewer sign-in fails, the engine explores with the operator session and logs a warning.
Exploration contexts still block every mutation in that case, so the browser guard, not the
account, is the primary control.

## Read-only pages during read fragments

**Status: Partial.** Implemented in `BrowserManager.setReadOnly` and `Executor.runTask`; no
automated test.

Execution contexts can write, so the executor narrows them per page. Before a worker runs a
segment, it marks the page read-only unless the segment is a write segment, and it clears the
mark when the segment ends. While the mark is set, the route guard aborts every mutating request
from that page. If a click in a read fragment unexpectedly triggers a write, the write is never
sent: the runtime raises `WriteRejectedError` with status 0, and the executor fails the task
with "a read-only fragment attempted a write".

This matters most in mode E, where read fragments start before the plan is complete.

## Prompt-injection isolation

**Status: Partial.** The structural controls are tested; resistance to a misleading but valid
plan is not measurable by a unit test.

The arena seeds injection-style text into record content on purpose, and the arena renders
untrusted text as text (`tests/integration/arena.test.ts`, "adds an internal note and renders
untrusted text as text"). Overclock relies on structure, not on the model ignoring it:

- **Tagged untrusted sections.** Page content reaches models only inside `<observed_apps>`,
  `<records>`, `<observed_app>`, or `<page_observation>` sections, and every system prompt
  (planner, catalog, critique, recovery) says that content is untrusted data and must not be
  followed. Only the `<task>` section states what to do.
- **No invented targets.** A plan may only reference control ids from the observed app model.
  The compiler rejects anything else.
- **No code.** Values are expressions in a closed language with no I/O, no JavaScript, and a
  bounded step budget.
- **Writes are explicit.** Only a `submit` step can change data, and only with declared
  resources, compare-and-swap guards, and read-back verification. A `click` on a control
  classified as a write is rejected.
- **Typed reflex answers.** Jev answers only typed choices among candidates the runtime
  observed. It can't produce free text or a new target.
- **Corroborated repairs.** An L3 repair from Claude must name a control in the observation and
  pass the same checks as a deterministic repair.
- **Models never drive the browser.** In modes B–E, workers execute validated segments only.

What this doesn't prevent: a model can still be misled into a plan that is valid but wrong,
for example writing the wrong value to an allowed field. The critique stage and read-back
verification reduce that risk, and the arena checker measures it (verified-but-wrong records),
but neither is a guarantee.

## Approval for irreversible actions

**Status: Partial.** Requests work; an approved step does not resume (bug).

A step is irreversible when the planner sets `irreversible: true` on a `submit`, or when its
control is classified irreversible. Classification takes the more severe of a name heuristic
(delete, remove, destroy, refund, pay, purchase, buy, send, publish, transfer, close account,
deactivate, cancel order) and Jev's answer, and a low-confidence model answer never lowers
severity.

- The compiler marks irreversible nodes `requiresApproval`, gives them retry policy `never`,
  and rejects any irreversible node without required approval.
- In mode E, before writes are released, nodes on controls classified irreversible are marked
  as requiring approval.
- At run time, an unapproved irreversible node raises `ApprovalRequiredError`. The executor
  emits `approval.requested`, and the task ends in `NEEDS_APPROVAL`. The dashboard's
  **Approvals** panel shows the request, and `POST /api/runs/:id/approvals` resolves it.
- Recovery never repairs an irreversible node with a model, never confirms a dialog that
  describes an irreversible action, and never clicks a dialog's only destructive button.
- The planner prompt forbids refunds, payments, deletions, and messages unless the task
  requires them, and the arena tasks never do.

**Known bug.** Approving a request calls `scheduler.retry`, which ignores tasks already in a
terminal state. `NEEDS_APPROVAL` is terminal, so the approved step never runs. Until this is
fixed, an approval only records the decision.

## Credential handling and redaction

**Status: Working (tested)** for redaction (`tests/unit/redact.test.ts`,
`tests/integration/engine-api.test.ts`); credential sourcing is **Partial** (code-reviewed, no
dedicated test).

- **Sources.** Credentials come only from the engine's environment: `ARENA_USERNAME` and
  `ARENA_PASSWORD` for execution, `ARENA_VIEWER_USERNAME` and `ARENA_VIEWER_PASSWORD` for
  exploration, or `OVERCLOCK_APP_CREDENTIALS` (JSON keyed by origin, with an optional `viewer`
  entry). `RunConfig` has no credential field. The arena defaults (`operator` /
  `overclock-arena`, `viewer` / `overclock-viewer`) are for local development only.
- **Sessions.** `SessionManager` signs in once per set of apps and shares the resulting storage
  state with worker contexts. Credentials and storage state are never written to events or
  logs.
- **Model keys.** `ANTHROPIC_API_KEY` and `TYPESAFE_API_KEY` are read from the environment by
  the providers. `.env` is ignored by Git.
- **Redaction.** `EventBus` passes every event payload through `redact()` before persisting or
  broadcasting it. `redact()` replaces values whose keys look sensitive (`password`, `secret`,
  `token`, `api_key`, `authorization`, `cookie`, `session`, `credentials`, `storage_state`,
  and similar) and scrubs `Bearer`/`Basic` tokens and `sk-…`/`ts_…` key shapes inside strings.
  Counters such as `inputTokens` are left alone. The store also redacts run configs.
- **CLI.** `pnpm cli` builds its output only from engine and arena responses and the user's
  own flags.
- **Network tokens.** The network client keeps each runtime's SpacetimeDB token in
  `<dataDir>/network-token` with file mode 0600, keyed by endpoint host. Each runtime must use
  its own `OVERCLOCK_DATA_DIR`.

Redaction is pattern based, so a secret in an unusual format can slip through.

## API exposure

**Status: Working (tested)** for CORS (`tests/integration/engine-api.test.ts`).

- The engine binds to `127.0.0.1:4000` by default (`OVERCLOCK_ENGINE_HOST`,
  `OVERCLOCK_ENGINE_PORT`). The arena binds to `127.0.0.1`.
- Both answer CORS requests only from `http://localhost` and `http://127.0.0.1` origins.
- Neither has authentication. Don't expose them on a shared network.
- Each run can carry a model budget (`budgetUsd`), and the engine can carry a process-wide one
  (`OVERCLOCK_ENGINE_BUDGET_USD`). The ledger refuses a call whose projected cost would exceed
  either.

## Network publication pipeline and trust boundaries

**Status: In progress.** The code exists in `packages/network-capability`,
`packages/network-client`, `services/network/spacetimedb`, and
`services/network/validation-worker`, has no tests yet, and is not called by the engine. See
[`NETWORK.md`](NETWORK.md).

A capability crosses three boundaries: from the publishing runtime to the network, from the
network to a validator, and from the network to an importing runtime. None of them trusts the
previous one.

### Publishing runtime

1. **Export.** `exportCapability` replaces observation-local control ids with portable
   semantic descriptors (app, route family, kind, role, name, label, options, table headers,
   form signature) and keeps only semantic locator strategies, never positional CSS.
2. **Sanitize.** `sanitizeCapability` is the last gate before data leaves the machine:
   - Credentials anywhere (API keys, JWTs, bearer tokens, cookies, session ids, private keys,
     credentials in URLs, long high-entropy strings) **reject** the capability.
   - Record data in procedure literals (expressions, URL and resource templates) **rejects**
     it, because removing it would change what the procedure does. The run's own input records
     are checked against the artifact.
   - Data in descriptors (control names, options, strategy text, query strings in page
     templates) is removed or replaced with placeholders, and each removal counts as a
     redaction.
   - Step notes are dropped, and other free text is scrubbed.
3. **Static analysis.** `analyzeCapability` re-derives every rule from the artifact: size and
   count limits, allowed expression roots, declared writes, verification blocks, guards, and
   irreversible effects.
4. **Hash.** The artifact hash is SHA-256 over canonical JSON.

### SpacetimeDB module

Every write goes through a transactional reducer, and every identity check uses the
authenticated connection identity (`ctx.sender`), never an argument.

- **Publishers.** The database owner is the first admin. Every other identity registers as
  `pending` and must be authorized by an admin as a `publisher`, `validator`, `repairer`, or
  `admin`. An admin can suspend an identity.
- **Proposals.** `proposeCapability` rejects a payload larger than 256 KiB, a byte count or
  content hash that doesn't match, a `publisherId` other than the caller, an unregistered
  application origin, a duplicate version, a missing parent version, or a changed canonical
  operation. It also rejects any payload string that contains a script URL, a credential-like
  value, or an absolute URL outside the allowed origins. Free text written to shared rows
  (activity, reasons, details) is sanitized.
- **State machine.** `PROPOSED → VALIDATING → VERIFIED → CANARY → ACTIVE`. Any non-terminal
  state can move to `QUARANTINED`, which can return to `VERIFIED` after re-validation or end
  in `REVOKED`. Clients can't skip states.
- **Promotion.** Only an admin can promote, and only when an authorized validator other than
  the publisher recorded a passing validation that no later failure superseded. The version
  must be newer than the active one, and the caller must present the current selection version,
  so concurrent promotions can't race.
- **Repairs.** Failure reports open repair jobs. A repairer claims a lease with a fencing
  token; every later call must present the current token, so a holder whose lease expired
  can't overwrite a newer repair.
- **Visibility.** Registry tables, including capability payloads, are public to connected
  clients. Sanitization before publication is therefore the control that keeps data private,
  not table permissions.

### Validator

The validation worker treats every proposed capability as untrusted. It re-runs the sanitizer
and static analysis, verifies the hash, rebinds every control against its own live
observation in a mutation-blocked context, and dry-runs the rebound plan's read segments for
one record. It never executes writes: write validation relies on static analysis plus the
publisher's verified-receipt evidence. Full sandbox write validation is not implemented.

### Importing runtime

By design, an importing runtime verifies the content hash, re-runs static analysis, rebinds
every control against its own observation (`rebindCapability`), rewrites the plan to local
control ids, and compiles it locally. From then on the capability is an ordinary plan: every
compile-time, run-time, and release gate in this document applies to it. The engine doesn't
import capabilities yet.

## Known gaps

- Approved irreversible steps don't resume.
- Per-page read-only mode, risky-GET blocking, WebSocket blocking, and the operator-session
  fallback for exploration have no automated tests.
- The engine and arena APIs are unauthenticated and rely on binding to localhost.
- Redaction and sanitization are pattern based.
- The network pipeline is untested and not connected to the engine.
