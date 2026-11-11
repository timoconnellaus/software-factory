# ADR 0007: Human gates are pending actions

Status: accepted, 2026-11-11 (from the product plan, `.kim/plans/2026-11-10-personal-software-factory-design.md`).

## Context
If an agent blocks while it waits for an approver, runner capacity sits idle. Borrowed from
Relationship OS ADRs 0022 and 0032, and Cloudflare OS "simulate now, approve later".

## Decision
- An operation the gate sends to review returns `pending_approval` and is stored as a pending action.
  The agent can continue speculatively on its branch.
- Approving re-runs the action as the original actor, and fails cleanly if the base branch moved.
- Rejecting cascades to actions that depended on it.
- Pending actions can be approved in bulk from the inbox. Duplicate approvals are idempotent.

## Consequences
- The inbox ([ADR 0031](0031-dashboard-stack-and-inbox-first.md)) is a list of pending actions.
- Every approver decision is recorded in the audit journal for later calibration ([ADR 0011](0011-audit-journal-is-the-metrics.md)).
