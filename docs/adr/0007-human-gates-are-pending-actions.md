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

> Amended 2026-11-11 (review decisions, [`docs/reviews/2026-11-11-review-decisions.md`](../reviews/2026-11-11-review-decisions.md)): in v1 a gate **blocks**: the Workflow waits on `waitForEvent` (spike ADR 0110), and the
> agent does not continue speculatively. A waiting item holds no runner slot. Speculative
> continuation stays designed for but is not built in R1. Each gate has a timeout from the autonomy
> policy; on timeout it goes to the **backup owner**, never auto-approves. Bulk approval never covers
> merge, security & privacy questions or irreversible questions ([ADR 0042](0042-one-question-object.md)).
