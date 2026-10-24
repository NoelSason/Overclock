# Procedure DSL and execution IR

Overclock has two plan formats. A model writes the **Procedure DSL**, a small typed plan
language. The compiler lowers it into the **execution IR**, which is the only format the
executor runs. This document is the reference for both, for the expression language they
share, and for the validation rules that sit between them.

**Status: Working (tested).** `tests/unit/compiler.test.ts`, `tests/unit/expr.test.ts`, and
`tests/unit/incremental.test.ts` cover lowering, validation, passes, segments, the expression
language, and incremental compilation. Source: `packages/contracts/src/dsl.ts`,
`packages/contracts/src/ir.ts`, `packages/compiler/src/*`.

## Why two layers

The DSL is designed to be safe to accept from a model:

- Every `control` must be an id from the observed app model. The compiler rejects ids it never
  saw, so a model can't invent a target.
- Every value is an expression in a closed, side-effect-free language. Nothing a model writes
  is ever evaluated as JavaScript.
- There is no recursion and no free-form map, so the schema fits structured-output limits.

The IR carries what the executor needs and the model should never decide on its own:
resolved semantic locators with evidence, effects, retry policies, declared resources,
compare-and-swap preconditions, read-back verification, timeouts, and approval flags.

## Procedure DSL

### Plan

| Field | Type | Meaning |
| --- | --- | --- |
| `strategy` | `{ name, summary, rationale }` | Human-readable strategy. |
| `phases` | `DslPhase[]` | Ordered phases. |
| `outcomes` | `{ id, description }[]` | Business outcomes to verify. At least one is required. |
| `assumptions` | `string[]` | Short and specific. |
| `risks` | `string[]` | Short and specific. |

### Phase

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Unique; must not collide with a step id. |
| `kind` | `"once"` or `"foreach"` | A `foreach` phase runs its steps once per item of `over`. |
| `over` | expression | `foreach` only: the list, usually `$input.records`. |
| `key` | expression | `foreach` only: a stable unique key per item, for example `$rec.orderId`. |
| `maxIterations` | integer | Optional bound. Default: 4 × record count, at most 5000. |
| `dependsOn` | phase ids | Phases that must finish completely first. |
| `steps` | `DslStep[]` | The steps, in order. |

### Steps

Every step has an `id` (unique across the plan, snake_case), an optional `when` guard (the step
is skipped when it evaluates falsy), optional `after` (extra step ids to wait for), and an
optional `note`.

| `op` | Fields | Meaning |
| --- | --- | --- |
| `goto` | `app`, `url` (template) | Load a page on an app. Paths are relative to the app's origin. Every phase that touches an app starts with a `goto` on it. |
| `fill` | `control`, `value` (expression) | Fill a text input, textarea, or checkbox (`'true'`/`'false'`). |
| `select` | `control`, `value` (expression) | Choose an option of a select, by value or label. |
| `click` | `control`, `purpose` | Navigation, tabs, toggles, dismissing dialogs, pagination. Never for saving data. `purpose` is one of `navigate`, `open`, `tab`, `toggle`, `dismiss`, `paginate`, `other`. |
| `submit` | `control`, `writes`, `guards`, `verify`, `irreversible` | The only way to change data. See the following section. |
| `extract` | `fields: { name, control, parse, optional? }[]` | Read facts or field values on the current page. `parse` is `string`, `number`, or `boolean`. |
| `extractTable` | `table`, `columns: { name, header }[]`, `key?`, `links?`, `paginateNext?`, `maxPages?` | Read a whole table. Headers must match exactly. `links` captures each named column's link as `<name>Href`. With `paginateNext`, the runtime clicks it until it is disabled or missing, or until `maxPages`. Output: `{ rows, pages }`. |
| `compute` | `assign: { name, expr }[]` | Derive values. Output: the assigned names. |
| `assert` | `expr`, `message` | Stop the record if `expr` is false. |
| `waitFor` | `control?` or `text?` | Wait until a control is visible or text is present. |

#### `submit`

| Field | Meaning |
| --- | --- |
| `control` | The form's submit button. |
| `writes` | Resource keys the write changes, specific to the entity, for example `app:support:ticket:{$out.find_ticket.ticketId}`. Two writes with the same key never run at the same time. |
| `guards` | Compare-and-swap checks: `{ control, equals }`. For each field the step changes whose earlier value it read, the edit form's current value must still equal what was read. If it doesn't, the runtime re-reads and recomputes instead of overwriting. The compiler adds a guard the plan left out when an `extract` read the same control under the same condition before the form changed. It drops a guard whose expected value is computed instead of read (for example the target value of the edit), because such a guard fails whenever a change is needed. A direct read, a read wrapped in `trim`, `lower`, `upper`, or `toString`, a compute field that only copies a read, a literal, and a record field are kept. |
| `verify` | `{ url, fields: { name, control, equals }[] }`. After the write, the runtime loads `url` fresh and reports success only if every field matches. When `control` is a section's region fact (a list of notes or comments), the field passes only if exactly one entry equals the expected text. |
| `irreversible` | `true` for payments, deletions, publishing, sending messages, and refunds. Such a step requires human approval. |

### Data flow between steps

Data flows only through expressions:

- `$rec.<field>`: the current item of a `foreach` phase.
- `$input.<name>`: run inputs. `$input.records` is the record list.
- `$out.<stepId>.<field>`: output of an earlier step in the same phase.
- `$phase.<phaseId>`: results of a finished dependency phase. For a `once` phase, that phase's
  outputs object (for example `$phase.scan.read_list.rows`). For a `foreach` phase, a list of
  `{ key, rec, out, ok }`, one per item.
- `$key`: the current record's key.

### Model-facing encoding

Structured outputs limit how many optional and union-typed parameters a schema may have.
`toModelSchema` therefore makes the shared step fields `when`, `after`, and `note` required,
with `""` or `[]` meaning absent. `normalizeModelOutput` drops those sentinels and any `null`
values, then parses the canonical schema.

The planner itself does not use grammar-constrained decoding, because the plan schema is too
large for it. `generatePlan` embeds the JSON Schema of `DslPlan` in the system prompt, streams
the response, extracts the JSON object, normalizes it, validates it with zod, and re-asks once
with the exact validation errors if it fails.

`DslSegmentPatch` (replacement steps for one phase) is defined for local recompilation but
not used yet.

### Example

This plan is illustrative. The control ids follow the app-model format
(`<app>.<page>.<label>`), but they are not taken from a real run.

```json
{
  "strategy": { "name": "per-record", "summary": "Read each ticket, then update it", "rationale": "Simple and verifiable" },
  "phases": [
    {
      "id": "per_ticket", "kind": "foreach", "over": "$input.records", "key": "$rec.ticketId", "dependsOn": [],
      "steps": [
        { "id": "open_ticket", "op": "goto", "app": "Support", "url": "/tickets/{$rec.ticketId}" },
        { "id": "read_ticket", "op": "extract", "fields": [{ "name": "status", "control": "support.tickets_id.status", "parse": "string" }] },
        { "id": "open_edit", "op": "goto", "app": "Support", "url": "/tickets/{$rec.ticketId}/edit", "when": "$out.read_ticket.status == 'Open'" },
        { "id": "set_status", "op": "select", "control": "support.tickets_id_edit.status", "value": "'pending'", "when": "$out.read_ticket.status == 'Open'" },
        {
          "id": "save", "op": "submit", "control": "support.tickets_id_edit.save_ticket_button",
          "when": "$out.read_ticket.status == 'Open'",
          "writes": ["app:support:ticket:{$rec.ticketId}"],
          "guards": [{ "control": "support.tickets_id_edit.status", "equals": "lower($out.read_ticket.status)" }],
          "verify": { "url": "/tickets/{$rec.ticketId}", "fields": [{ "name": "status", "control": "support.tickets_id.status", "equals": "'Pending'" }] },
          "irreversible": false
        }
      ]
    }
  ],
  "outcomes": [{ "id": "pending", "description": "Open tickets are pending" }],
  "assumptions": [],
  "risks": []
}
```

## Lowering

`lowerPlan` turns each step into IR nodes. It resolves every control reference against the
observed app models; an unresolvable reference becomes an error, never a guessed locator.

| DSL step | IR node | Notes |
| --- | --- | --- |
| `goto` | `navigate` | Reads the page resource `page:<app>:<path>`. |
| `fill`, `select` | `fill`, `select` | Effect `local-write`. |
| `click` | `click` | Effect `read`, or `local-write` for `purpose: "toggle"`. Rejected if the control was classified as a write. |
| `submit` | `click` | Effect `remote-write`, or `irreversible` (from the flag or the control's classification). Retry policy `verify-before-retry`, or `never` for irreversible. Writes the declared keys plus the verification page's resource. Guards become `fieldEquals` preconditions on the first interaction after the edit page loads. A verification field on a region fact gets `match: "entry"`. Timeout 15 s. |
| `extract` | `extract` with `fields` | Reads the `value` of inputs, selects, textareas, and checkboxes, and the `text` of everything else. |
| `extractTable` | `extract` with `table` | Pagination capped at 200 pages (default 50). Timeout 60 s. |
| `compute` | `compute` | |
| `assert` | `assert` | |
| `waitFor` | `waitFor` | Waits for visibility or text. Timeout 10 s. |

The lowering also infers dependencies:

- Every `$out.<step>` reference adds an edge to that step.
- **Page continuity:** a page action depends on the step that last loaded or changed that
  app's page in the phase.
- A `foreach` phase becomes one `foreach` node whose `body` holds the steps. A `once` phase
  becomes its steps plus a `checkpoint` node that depends on all of them.

## Execution IR

### Program

| Field | Meaning |
| --- | --- |
| `version` | `"1.0"` |
| `id`, `goal`, `strategy` | Identity and description. |
| `allowedOrigins` | The only origins any node may load. |
| `apps` | `{ name, origin }` bindings. |
| `inputs` | Run inputs (`records`). |
| `nodes` | `ActionNode[]` |
| `expectedOutcomes` | `{ id, description, expr?, scope }[]` |
| `approvalPolicy` | `requireApprovalFor` (default `["irreversible"]`) and `approvedNodes`. |

### Action node

| Field | Meaning |
| --- | --- |
| `id`, `type`, `description` | `type` is one of `navigate`, `locate`, `click`, `fill`, `select`, `extract`, `assert`, `branch`, `foreach`, `waitFor`, `checkpoint`, `compute`. |
| `dependsOn` | Node ids that must finish first. |
| `app`, `sessionKey` | The app the node acts on; drives segment grouping. |
| `target` | A `SemanticLocator`. |
| `input`, `url` | `ValueSpec`s. |
| `fields`, `table` | Extraction specs. |
| `assign` | `compute`: name to expression. |
| `condition` | `branch` and `assert`: a boolean expression. |
| `when` | Guard: the node is skipped when this is falsy. Its output becomes `null`. |
| `over`, `as`, `key`, `maxIterations`, `body` | `foreach` only. |
| `until` | `waitFor`: a `Condition`. |
| `preconditions`, `postconditions` | `Condition[]` checked before and after the action. |
| `reads`, `writes` | Resource keys (templates allowed). |
| `effect` | `read`, `local-write`, `remote-write`, or `irreversible`. |
| `retryPolicy` | `safe`, `verify-before-retry`, or `never`. |
| `verify` | `VerificationSpec`: `{ url, fields: { name, target, equals, attr, match? }[] }`. `match: "entry"` counts matching entries of a collection region instead of comparing one value. |
| `timeoutMs`, `estimatedLatencyMs` | Timing. |
| `requiresApproval`, `evidence`, `resourceLocks` | Approval flag, evidence links, explicit locks. |

### Semantic locator

| Field | Meaning |
| --- | --- |
| `strategies` | Ranked alternatives. Each is one of `role` (`role`, `name`, `exact`), `label`, `placeholder`, `testId`, `text`, or `css`. |
| `scope` | Optional container strategy, such as the enclosing form, used when names repeat. |
| `controlId` | The app-model control the locator came from. |
| `confidence` | 0 to 1. Lowered to 0.6 when a second sample of the same page lacked the control. |
| `evidence` | Links to the observations it was derived from. |
| `regionFingerprint` | The page region it was validated against. |

At run time, `resolveLocator` probes each strategy once without waiting. When a strategy
matches several elements, it narrows to visible ones. An ambiguous strategy is skipped in favor
of a lower-ranked unique one. If no strategy matches, it polls until the timeout. If every
matching strategy is ambiguous, it fails with `AmbiguousLocatorError` instead of picking one.

### Values and conditions

A `ValueSpec` is `{ value }` (a literal), `{ expr }` (an expression), or `{ template }` (a string
with `{expr}` parts).

A `Condition` is one of the following:

- `expr`: an expression is truthy.
- `visible` or `hidden`: a locator's target.
- `url`: the current URL matches a glob.
- `textPresent`: the page contains text.
- `fieldEquals`: a control's `value` or `text` equals an expected value. This is the
  compare-and-swap guard.

## Expression language

Source: `packages/compiler/src/expr.ts`.

```text
expr    := or
or      := and ('||' and)*
and     := eq ('&&' eq)*
eq      := cmp (('==' | '!=') cmp)*
cmp     := add (('<' | '<=' | '>' | '>=' | 'in') add)*
add     := mul (('+' | '-') mul)*
mul     := unary (('*' | '/') unary)*
unary   := ('!' | '-') unary | postfix
postfix := primary ('.' ident | '[' expr ']')*
primary := number | string | true | false | null | $root | ident '(' args ')' | '(' expr ')' | '[' items ']'
```

### Semantics

- **Paths** start with `$`: `$rec`, `$input`, `$out`, `$phase`, `$key`. The lowering rejects
  any other root. A bare identifier is valid only as a function name.
- **Missing values** are `null`. Property access on `null` returns `null`, and only own
  properties are visible. `.length` works on lists.
- **Equality** (`==`, `!=`) is loose but bounded: numbers equal numeric strings, booleans equal
  `"true"`/`"false"`, and lists compare element by element. Text comparison is case-sensitive;
  use `lower()` or `equalsIgnoreCase()`.
- **Ordering** (`<`, `<=`, `>`, `>=`) compares numerically when both sides parse as numbers
  (ignoring `$` and `,`), otherwise as strings.
- **`in`** tests list membership, an object key, or a substring.
- **Arithmetic** (`+`, `-`, `*`, `/`) works on numbers and numeric strings. `+` with a
  non-number operand joins the two as text (`null` counts as `""`); the other operators return
  `null`. Division by zero returns `null`. Use `concat()` to join text explicitly.
- **Truthiness:** `false`, `null`, `0`, `""`, and empty lists are falsy.
- **`&&` and `||`** short-circuit; `||` returns the first truthy operand. `if` evaluates only
  the branch it takes.
- **Limits:** lists may hold at most 10,000 items, and one evaluation may take at most 200,000
  steps.

### Functions

| Function | Arguments | Returns |
| --- | --- | --- |
| `lower`, `upper`, `trim` | text | Text. |
| `len` | list, text, or object | Length (object: key count). |
| `contains` | list or text, value | List membership or substring. |
| `startsWith`, `endsWith` | text, prefix | Boolean. |
| `equalsIgnoreCase` | a, b | Trimmed, case-insensitive equality. |
| `concat` | 1–20 values | Joined text. |
| `encode` | text | URL-encoded text. |
| `join` | list, separator (default `,`) | Text. |
| `split` | text, separator | Trimmed parts. |
| `replace` | text, from, to | Every occurrence replaced. |
| `coalesce` | 1–10 values | First value that is not `null` or `""`. |
| `if` | condition, a, b | `a` or `b` (lazy). |
| `get` | object, `'a.b'` path | Value at the path. |
| `at`, `first`, `last` | list (and index) | Item or `null`. |
| `lookup` | list, field path, value | First item whose field equals the value. |
| `pluck` | list, field path | List of that field. |
| `filterBy` | list, field path, operator, value | Items where `field <op> value`. Operators: `==`, `!=`, `<`, `<=`, `>`, `>=`, `in`, `contains`. |
| `countBy` | list, field path | Object from field value to count. |
| `entries` | object | `{ key, value }[]` |
| `keys` | object | Keys. |
| `unique` | list | Distinct items (loose equality). |
| `range` | lo, hi | Integers from `lo` to `hi` inclusive. |
| `sum`, `min`, `max` | list | Number. |
| `any`, `all` | list | Boolean over truthiness. |
| `toNumber`, `toString`, `round` | value | Converted value. |
| `isEmpty` | value | `true` when falsy. |

Calling an unknown function, or a known one with the wrong number of arguments, is a parse
error.

### Templates

A template is literal text with `{expr}` parts, for example
`/customers?q={encode($out.read_order.email)}`. Braces and quotes inside an expression are
handled, so `{concat('a', '}')}` works. The compiler extracts the expressions of every
template for validation and dependency inference.

## Validation rules

Two layers reject a plan before any browser action happens. Both report issues with a
severity, a code, a message, and the step or phase involved. Any `error` blocks execution.

### Lowering (`lowerPlan`)

| Code | Rejects |
| --- | --- |
| `unknown-control` | A control, guard, or verification field id that was never observed. |
| `control-app-mismatch` | A control from a different app than the current page. |
| `write-via-click` | A `click` on a control classified as a write. |
| `missing-verification` | A `submit` without read-back fields. |
| `missing-writes` | A `submit` without declared resources. |
| `unknown-column` | An `extractTable` column the table doesn't have. |
| `no-page` | A page action before any `goto` on that app in the phase. |
| `unknown-app`, `origin` | A `goto` to an unknown app, or an absolute URL outside the app's origin. |
| `duplicate-id` | A step id used twice, or a phase id that collides with a step id. |
| `unknown-phase`, `phase-dependency` | `dependsOn` or `$phase.<id>` naming an unknown phase, or reading a phase without depending on it. |
| `unknown-ref` | `$out.<id>` that is not an earlier step of the same phase. |
| `unknown-root` | A path root other than `$rec`, `$input`, `$out`, `$phase`, `$key`. |
| `rec-outside-foreach` | `$rec` in a `once` phase. |
| `bad-expression` | An expression or template that doesn't parse. |
| `foreach-over`, `foreach-key` | A `foreach` phase without `over` or `key`. |
| `missing-outcomes` | A plan with no outcomes. |
| `select-non-select` (warning) | A `select` on a control that is not a select. |

### IR validation (`validateProgram`)

| Code | Rejects |
| --- | --- |
| `schema` | A program that doesn't match `ExecutionProgramSchema`. |
| `origin` | An app origin not in `allowedOrigins`. |
| `duplicate-id`, `missing-dependency`, `cycle` | Bad graph structure in any scope. |
| `unsupported`, `unknown-app` | An unknown node type or app. |
| `bad-expression` | Any expression in a node that doesn't parse. |
| `unsafe-retry` | A write with retry policy `safe`. |
| `approval` | An irreversible node without required (or pre-granted) approval. |
| `missing-verification` | A write without read-back verification. |
| `rw-consistency` | A write that declares no written resources, or a read that declares some. |
| `missing-target`, `missing-url` | A `click`, `fill`, `select`, or `locate` without a target, or a `navigate` without a URL. |
| `nested-foreach`, `foreach`, `unbounded-loop` | A nested `foreach`, a `foreach` without `over` and `key`, or one without `maxIterations`. |
| `missing-outcomes` | No expected outcomes. |

### Compilation and streaming

- `compile`: segment formation found that a page action can't join its page chain without a
  cycle and the page can't be re-opened. When only reads ran on that page since it loaded (for
  example: open a ticket, read its notes, decide using data from other apps, then add a note),
  the compiler starts a new segment that re-opens the page instead.
- `self-defeating-guard` (warning): a guard that expects the value its own form writes was
  dropped.
- `auto-guard` (warning): the compiler added a compare-and-swap guard the plan left out.
- `computed-guard` (warning): a guard that compared with a computed value was dropped.
- `stream-continuation` (incremental compiler only): a streamed step continues a page whose
  fragment already ran and can't be re-opened.
- `segments` (incremental compiler only): segment formation failed for a streamed phase.

### Run-time checks

Validation can't see everything, so the runtime checks again:

- Navigation outside the allowlist raises `OriginBlockedError`.
- An unknown `foreach` list or a list longer than `maxIterations` fails the phase.
- A record without a key fails the phase, and a duplicate key is dropped.
- A failed `assert` or postcondition fails the record.
- A failed compare-and-swap guard triggers invalidation, unless a write of the same record that
  used the same reads already committed. Recomputing those reads would decide again from
  post-write state, so the task fails instead.
- Read-back on a region fact requires exactly one matching entry on the page of the entity the
  write targeted. Duplicates and a different entity fail the write without a retry.
