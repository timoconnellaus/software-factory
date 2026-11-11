# ADR 0004: The invoke() pipeline and gate

Status: accepted, 2026-11-11 (from the product plan, `.kim/plans/2026-11-10-personal-software-factory-design.md`).

## Context
Every operation needs the same checks, the same audit trail and the same notification behaviour.
Borrowed from Relationship OS ADR 0018.

## Decision
- One `invoke()` pipeline: validate input, evaluate the gate (actor × risk class against policy),
  check permissions, run the handler, validate output.
- **Actors:** `human`, `agent`, `runner`, `intake`, `self-improve`.
- **Risk classes:** `read`, `write`, `spend`, `outbound` (push, comment, PR), `merge`, `deploy`, `self-modify`.
- The gate answers allow, review (becomes a pending action, [ADR 0007](0007-human-gates-are-pending-actions.md)) or deny.
- The handler's writes, its audit journal row and any outbox row commit in **one D1 batch**, so an
  operation applies completely or not at all.

## Consequences
- Policy ([ADR 0008](0008-autonomy-presets-and-floor.md)) is enforced here, in code, not in prompts.
- The audit journal is complete by construction ([ADR 0011](0011-audit-journal-is-the-metrics.md)).
- Handlers read immediately and queue writes; queued writes are not visible to later reads in the same handler.
