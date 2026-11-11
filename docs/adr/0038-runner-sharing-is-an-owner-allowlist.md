# ADR 0038: Runner sharing is an owner-only allowlist

Status: accepted, 2026-11-11 (review decisions, [`docs/reviews/2026-11-11-review-decisions.md`](../reviews/2026-11-11-review-decisions.md), answering the [design review](../reviews/2026-11-11-design-review.md)).

## Context
[ADR 0023](0023-runners-owned-by-users-and-requester-routing.md) lets owners share runners into
orgs and factories. A shared runner executes other people's work items on its owner's machine:
it is remote code execution on someone's laptop.

## Decision
- A runner is **owner-only by default**: it runs only work items its owner requested.
- Sharing is an **explicit allowlist** the owner keeps: orgs, factories or projects whose work the
  runner may take. Only the owner can change it (`runner.share`, `runner.unshare`, human only).
- Requester-first routing falls back only to runners whose allowlist covers the work item's project.
- A runner reports "**rate-limited until T**" as a state; the scheduler skips it until T.

## Consequences
- Shared runners stay in R1 (milestone (c)), behind this allowlist.
- The runner health line shows each runner's state, including rate limits.
