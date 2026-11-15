# @software-factory/store

The new core's D1 access (ADR 0660, spec 70). It keeps what the kernel in
[`@software-factory/flow`](../flow) works on, in the `flow_*` tables
([`packages/db/migrations/0430_flow.sql`](../db/migrations/0430_flow.sql)), and carries out the
kernel's effects. It never imports `@software-factory/core`.

- `workflows.ts`: an org's workflows, checked with `checkWorkflow` before every write.
- `projects.ts`, `agents.ts`: an org's projects (a key for item numbers, a workflow) and agents.
- `items.ts`: `createItem`, `applyEvent`, `addComment`, and the reads: `getItem`, `board`,
  `timeline`, `inbox`.
- `step.ts`: one step of an item. The kernel's `apply`, then the item's new state, the event and
  each effect on its timeline, and the effects carried out (`run.start` queues a run, `run.cancel`
  cancels the stay's open run), all in one D1 batch. The item's update is conditional on the `stay`
  and `updated_at` it was read with, and timeline seqs are unique per item, so of two writers only
  one advances an item; the other gets `StoreError("conflict")`. A `FlowError` from the kernel
  propagates unchanged and writes nothing.
- `runs.ts`: `claimRun` (oldest queued run, a lease, `fencing_token + 1`), `renewLease`,
  `finishRun` / `failRun` (refused on a stale fencing token; they apply `run.ended` / `run.failed`),
  `expireRuns` (fails claimed runs whose lease lapsed, at most 10 a call).

## Retention
Items, their timeline (`flow_events`) and their runs are kept as the item's record. Nothing prunes
them yet; workflows, projects and agents are a handful per org.

## Tests
`pnpm --filter @software-factory/store test` runs in workerd against a D1 with every migration
applied. The claim, renew and sweep queries are in the query-plan guard
(`apps/engine/test/query-plans.test.ts`).
