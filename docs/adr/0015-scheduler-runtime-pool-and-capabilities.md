# ADR 0015: Scheduler, runtime pool and capabilities

Status: accepted, 2026-11-11 (from the product plan, `.kim/plans/2026-11-10-personal-software-factory-design.md`).

## Context
The factory decides what runs where; runners only execute.

## Decision
- The runtime pool is the set of registered runners, each with a capacity and a capability set.
- The scheduler in the control plane places stage jobs. It fills fixed runners first, then overflows
  to elastic ones.
- `.factory/` limits which runners and capabilities a job may use (for example a client repo: own
  hardware only).
- v1 pool: one Orca runner on the Mac mini, capacity 4.

## Consequences
- Placement also follows requester routing ([ADR 0023](0023-runners-owned-by-users-and-requester-routing.md)).
- A job whose required capability no runner has waits in the queue and shows as stuck.

> Amended 2026-11-11 (review decisions, [`docs/reviews/2026-11-11-review-decisions.md`](../reviews/2026-11-11-review-decisions.md)): the scheduler applies **WIP backpressure**: it starts no new build for a project whose
> items waiting at human gates reached its WIP limit ([ADR 0040](0040-web-push-and-wip-backpressure.md)).
> It skips runners in the **rate-limited until T** state, falls back only to runners whose sharing
> allowlist covers the project ([ADR 0038](0038-runner-sharing-is-an-owner-allowlist.md)), and a
> paused work item releases its slot ([ADR 0035](0035-lease-fencing-and-one-branch-per-run.md)).
