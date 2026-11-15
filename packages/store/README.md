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

## Retention
Items, their timeline (`flow_events`) and their runs are kept as the item's record. Nothing prunes
them yet; workflows, projects and agents are a handful per org.

## Tests
`pnpm --filter @software-factory/store test` runs in workerd against a D1 with every migration
applied. The claim, renew and sweep queries are in the query-plan guard
(`apps/engine/test/query-plans.test.ts`).
