# ADR 0012: Outbox and notifications

Status: accepted, 2026-11-11 (from the product plan, `.kim/plans/2026-11-10-personal-software-factory-design.md`).

## Context
A gate nobody hears about stalls the factory. Borrowed from Relationship OS ADRs 0171 and 0206.

## Decision
- Notification events are written to an **outbox** in the same D1 batch as the state change, so a
  notification is never lost.
- v1 has no PWA and no push delivery. A native phone app comes later and plugs into the outbox.
- The outbox is built now; delivery to the web inbox reads from it.

## Consequences
- Escalation of unread approvals, a daily digest and tap-to-approve are designed for but not built in v1.

> Amended 2026-11-11 (review decisions, [`docs/reviews/2026-11-11-review-decisions.md`](../reviews/2026-11-11-review-decisions.md)): **web push is in R1** ([ADR 0040](0040-web-push-and-wip-backpressure.md)): the outbox
> delivers a browser push with a deep link for every gate assigned to a user. Only the native app
> is still deferred. Escalation of unread approvals and the daily digest still come later.
