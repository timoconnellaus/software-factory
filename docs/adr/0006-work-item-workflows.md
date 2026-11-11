# ADR 0006: One Workflow per work item

Status: accepted, 2026-11-11 (from the product plan, `.kim/plans/2026-11-10-personal-software-factory-design.md`).

## Context
Work items wait hours or days at gates and must survive restarts and deploys. Borrowed from
Relationship OS ADRs 0028 and 0130.

## Decision
- Each work item is one Cloudflare Workflow instance in `sf-engine`.
- The Workflow id is derived from the intake event, so a duplicate event never starts a second run.
- Gates are `waitForEvent('approval-<id>')`.
- A **kill switch** pauses every Workflow. Agents that spawn work items are bound by cascade and
  depth limits.

## Consequences
- Gate waits cost nothing while idle.
- Open question: the exact cascade and depth limits, and whether the kill switch is per org or global.

> Amended 2026-11-11 (review decisions, [`docs/reviews/2026-11-11-review-decisions.md`](../reviews/2026-11-11-review-decisions.md)): **one Workflow per work item stays** (the review suggested state in D1 with Workflows per
> stage; we keep this ADR). The work-item state of record is still in D1 through operations; the
> Workflow drives it. The build must handle, explicitly and with tests: send-back loops (verify →
> build, spec → planning) as loops inside one instance; takeover and pause, where a paused item
> releases its runner slot ([ADR 0035](0035-lease-fencing-and-one-branch-per-run.md)); **Workflow
> versioning across deploys** (an instance started on an old version must finish or be migrated);
> step count and payload limits (large artifacts go to R2, steps carry ids); and several intake
> events merging into one work item. For that last one the **dedupe key on intake events is
> separate from the Workflow id**: an intake event maps to a work item through the dedupe key, and
> a second event about the same thing attaches to the existing work item instead of deriving a new
> Workflow id. The kill switch is **per org and per project** ([ADR 0044](0044-kill-switch-scope.md)).
> Still open: cascade and depth limits.

> Amended 2026-11-11 (V1 core + engine): built as described in [ADR 0110](0110-work-item-workflow-and-gate.md)
> (promoted) and [ADR 0053](0053-workflow-versioning.md) (versioning). Cascade and depth limit, V1:
> a factory incident's own failures and send-backs open no further incidents.

> Amended 2026-11-11 (planning interview, [`.kim/plans/2026-11-11-factory-planning.md`](../../.kim/plans/2026-11-11-factory-planning.md)): cascade and depth for planning: a planning session may split its work item into children approved at the spec gate, depth 1 ([ADR 0263](0263-a-planning-session-can-split-a-work-item.md)).
