# Spec 01: Operations, invoke pipeline and the work-item store

Read first: [`CONTEXT.md`](../../CONTEXT.md), ADRs [0003](../adr/0003-operations-registry.md),
[0004](../adr/0004-invoke-pipeline-and-gate.md), [0008](../adr/0008-autonomy-presets-and-floor.md),
[0011](../adr/0011-audit-journal-is-the-metrics.md), [0012](../adr/0012-outbox-and-notifications.md).
Relationship OS ADRs 0016, 0017 and 0018 (`/Users/tim/orca/projects/crm/docs/adr/`) for the
mechanics this copies. Also ADRs [0035](../adr/0035-lease-fencing-and-one-branch-per-run.md)
(fencing) and [0036](../adr/0036-policy-from-the-default-branch.md) (policy from the default branch).

> Amended 2026-11-11 ([review decisions](../reviews/2026-11-11-review-decisions.md)): leases return fencing tokens; policy is the
> autonomy policy read at a default-branch SHA; the `plan` risk class (spike ADR 0110); intake dedupe
> keys; CRM-style `core_*` tables. Part of R1 milestone (a).

## Goal
The factory's one API: operations defined once, run through one `invoke()` pipeline that validates,
gates, writes, audits and queues notifications in a single D1 batch.

## Scope
- `packages/core`: `defineOperation` (name, description, zod input/output, permission, risk class,
  allowed actors) and the registry.
- `invoke()`: validate → resolve policy (autonomy policy + project override + floor, from
  `.factory/` at a default-branch SHA) → gate check (actor × risk class → `allow | review | deny`) →
  fencing token (for lease holders) → permission → handler → one D1 batch of writes + audit row +
  outbox rows.
- Actors: `human`, `agent`, `runner`, `intake`, `self-improve`. Risk classes: `read`, `write`,
  `plan`, `spend`, `outbound`, `merge`, `deploy`, `self-modify`.
- `packages/db`: migrations (CRM style, `core_*` snake_case tables) for work items (requester,
  project, source, stage, size, skip reason, spec, acceptance criteria), intake dedupe keys (separate
  from the work item and Workflow id), audit journal, outbox, leases with fencing tokens. Typed access (choose Kysely or Drizzle; ADR in
  your claimed block).
- First operations: `workItem.create`, `workItem.get`, `workItem.list`, `workItem.setStage`,
  `lease.claim`, `lease.heartbeat`, `lease.release`.
- A hard-coded floor: `merge`, `deploy` and `self-modify` always return `review`.

## Out of scope
Workflows, runners, the MCP adapter, auth (spec 10 supplies the human principal; tests use a fake),
the adjudicator (ADR 0030).

## Acceptance criteria
1. Every operation is defined once; a test fails if a registry entry lacks a description, schemas,
   permission or risk class.
2. An operation's write, its audit row and its outbox rows land together or not at all (test with a
   failing write).
3. `merge`, `deploy` and `self-modify` operations return `review` for every actor and every autonomy policy,
   including an autonomy policy that tries to allow them.
4. A malformed policy fails closed (`deny`) and is audited.
5. A second `lease.claim` on a held, unexpired lease is refused; an expired one can be taken, and
   the new claim's fencing token is higher. A write carrying the old token is refused and audited.
6. Every audit row records actor, origin, operation, gate decision and a diff.
7. Tests run in workerd against a real D1 binding.
8. Every audit row records the default-branch SHA its policy came from; a policy offered from any
   other ref is ignored.
