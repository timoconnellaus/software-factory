# ADR 0011: The audit journal is the metrics

Status: accepted, 2026-11-11 (from the product plan, `.kim/plans/2026-11-10-personal-software-factory-design.md`).

## Context
We want throughput, cycle time per stage, the approver's gate time, autonomy rate, rework, agent
time and tokens, and stuck runs, without running a separate analytics system. Borrowed from
Relationship OS ADR 0017.

## Decision
- Every operation writes one append-only audit journal row: actor, origin, gate decision, diff.
- Metrics are SQL views over the journal.
- Every gate decision an approver makes is logged with its context, so a future auto-approver can be
  calibrated against it ([ADR 0030](0030-deferred-from-v1.md)).

## Consequences
- A metric that cannot be computed from the journal means an operation is missing data.
- Open question: how runner token usage reaches the journal (runner events vs harness reports).
