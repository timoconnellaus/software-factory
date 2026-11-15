# @software-factory/ops

The new core's operations (ADR 0660, spec 70): the `flow.*` verbs a person calls through the
desktop app, the `sf` CLI and, later, agents. Each is a thin layer over one call into
[`@software-factory/store`](../store). It never imports the old core (`packages/core`).

- `operation.ts`: an operation is `{ name, description, risk, input (zod), handler(input, ctx) }`,
  with `ctx = { d1, orgId, actor: { kind: "person", id }, now }`. `risk` is `read` or `write`; a
  read-only CLI token reaches only `read` operations.
- `call.ts`: `call(name, rawInput, { d1, actor })` looks the operation up, validates its input,
  checks scope, runs it, and answers `{ ok: true, result }` or `{ ok: false, error: { code,
  message, details? } }`. Codes: `unknown_operation`, `invalid_input` (zod, or a workflow the
  kernel refused), `forbidden`, `not_found`, `conflict` (a `FlowError` that doesn't fit the item's
  state, a `StoreError` conflict or stale run), and `internal` (anything else; logged, never
  detailed to the caller). `describe()` lists names, descriptions and risk.
- `scope.ts`: the whole permission model. Every input carries `orgId`; one query checks that the
  caller is a member of it (`core_member`) and that every project, item, workflow and agent the
  input names (including each agent a workflow's statuses own) is in that org. Something in
  another org is `not_found`, as if it didn't exist.
- `workflows.ts`, `projects.ts` (projects and agents), `items.ts`, `reads.ts`: the operations.

## Operations
| Area | Operations |
| --- | --- |
| Workflows | `flow.workflow.create`, `.update`, `.get`, `.list` |
| Projects | `flow.project.create`, `.get`, `.list`, `.setWorkflow` |
| Agents | `flow.agent.create`, `.update`, `.list` |
| Items | `flow.item.create`, `.get`, `.move`, `.finish` (the owner's done or rejected), `.decide` (approve or reject), `.retry`, `.comment` |
| Views | `flow.board.get`, `flow.timeline.get`, `flow.inbox.get`, `flow.run.list` |

No approvals, roles, rate limits or audit: spec 70 keeps these out until the owner asks.

## Where it is called
`apps/engine` sends every `flow.` call on the client door (`/client/v1/call`, `/cli/v1/call`,
and read calls in `batch`) here, as the person behind the bearer token, in the door's usual
envelope; `ops` lists these beside the old core's. Runs reach runners over the signed channel
(`apps/engine/src/flow/`), not through operations.

## Tests
`pnpm --filter @software-factory/ops test` runs in workerd against a D1 with every migration
applied.
