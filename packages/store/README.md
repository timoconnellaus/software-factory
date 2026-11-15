# @software-factory/store

The new core's D1 access (ADR 0660, spec 70). It keeps what the kernel in
[`@software-factory/flow`](../flow) works on, in the `flow_*` tables
([`packages/db/migrations/0430_flow.sql`](../db/migrations/0430_flow.sql)), and carries out the
kernel's effects. It never imports `@software-factory/core`.

- `workflows.ts`: an org's workflows, checked with `checkWorkflow` before every write.
- `projects.ts`, `agents.ts`: an org's projects (a key for item numbers, a workflow) and agents.
- `items.ts`: `createItem`, `applyEvent`, `addComment`, and the reads: `getItem`, `board`,
  `timeline`, `inbox`, `recentComments`. The views are capped (AGENTS.md cost rule 2) and say so
  with `truncated`: a board shows at most 500 items, an inbox at most 100 in each list, a timeline
  its newest 500 entries (oldest first). No paging.
- `step.ts`: one step of an item. The kernel's `apply`, then the item's new state, the event and
  each effect on its timeline, and the effects carried out (`run.start` queues a run, `run.cancel`
  cancels the stay's open run), all in one D1 batch. The item's update is conditional on the `stay`
  and `updated_at` it was read with, and timeline seqs are unique per item, so of two writers only
  one advances an item; the other gets `StoreError("conflict")`. A `FlowError` from the kernel
  propagates unchanged and writes nothing.
- `runs.ts`: `claimRun` (the oldest queued run the runner serves: its owner's items, or any item
  of an org it is shared into through `core_runner_shares`; a lease, `fencing_token + 1`),
  `renewLease`, `getRun`, `finishRun` / `failRun` (refused on a stale fencing token; they apply
  `run.ended` / `run.failed`), `expireRuns` (fails claimed runs whose lease lapsed, at most 10 a
  call, each through `expireRun`, whose write applies only if the lease is still lapsed then).

## Milestone 2 (migration 0431)
- `plugins.ts`: `savePlugin` (create or replace by name; a replace keeps the id, trigger key,
  enabled flag and creator, and clears `last_error`), `getPlugin`, `getPluginById`, `listPlugins`,
  `enabledPlugins`, `deletePlugin`, `setPluginEnabled`, `setPluginLastError`, and
  `declaredFields` (the union of the enabled plugins' fields, from what each declared when saved).
- `gateways.ts`: `saveGateway`, `getGateway`, `listGateways`, `deleteGateway`. The secret is
  sealed with AES-GCM (key: SHA-256 of the engine's `FLOW_GATEWAY_KEY`; additional data: the org
  and name) and no read returns it, except `gatewayForHost`, the plugin host's own. Storing a
  secret without the key is `StoreError("unavailable")`.
- `entries.ts`: `setField` (one JSON field on `flow_items.fields`; null removes it), `addCard` (a
  `card` entry on the timeline), and `stopItem` (as a failed run: error set, waiting on nothing,
  the stay's open run cancelled, a `stopped` entry; `retried` then runs the status again).
- `step.ts` / `runs.ts`: `loadItem` (the item, its workflow, its last seq), `applyEventStep`
  and `endRun` return the step's effects too, so the plugin host can run hooks after it; a run
  ended with `stopWith` is recorded done but stops the item. `claimRun` carries the agent's
  `mcp`; `setMcpTokenHash` and `runForToken` back the MCP server's per-run token.

## The desktop app's reads (migration 0432)
- `views.ts` holds the lists (`board`, `inbox` and `itemRuns` moved here from `items.ts` and
  `runs.ts`). Lists carry names: `board` and `inbox` items are `ListedItem`s (`projectName`, `projectKey`,
  `statusName`, the status's name picked from the workflow's JSON in SQL). `inboxAll(userId)`:
  per org the person is a member of (at most 10), `work`, `decisions` and `working` (waiting on a
  run), at most 50 each; two D1 requests (the orgs, then a batch of three statements, an arm per
  org).
- `listProjects` adds `openCount` (items waiting on something, or stopped with an error; the
  partial `flow_items_open_idx`). `listAgents` adds `workingOn` (the item of its claimed run, else
  its oldest queued one). `listMembers` reads `core_member` and `core_user` (at most 200).
- `runs.ts`: `itemRuns`, `agentRuns` (newest first, at most 50; `flow_runs_agent_idx`) and
  `getListedRun` return `ListedRun`s (`itemTitle`, `itemNumber`, `projectKey`). A run's
  `run.ended` / `run.failed` event and its summary comment carry `runId`.

## Retention
Items, their timeline (`flow_events`) and their runs are kept as the item's record. Nothing prunes
them yet; workflows, projects and agents are a handful per org. Plugins and gateways are a handful
per org too, kept until deleted through their operations.

## Tests
`pnpm --filter @software-factory/store test` runs in workerd against a D1 with every migration
applied. The claim, renew and sweep queries are in the query-plan guard
(`apps/engine/test/query-plans.test.ts`).
