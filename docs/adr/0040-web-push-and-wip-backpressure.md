# ADR 0040: Notifications by web push, and WIP backpressure

Status: accepted, 2026-11-11 (review decisions, [`docs/reviews/2026-11-11-review-decisions.md`](../reviews/2026-11-11-review-decisions.md), answering the [design review](../reviews/2026-11-11-design-review.md)).

## Context
Away-time is a named pain, but [ADR 0012](0012-outbox-and-notifications.md) put push off until a
native app exists (R4 or later). In the metrics mockup, human waits dwarf build time. Agents can
also produce work faster than one person can review it.

## Decision
- **Web push in R1**: the desktop browser subscribes (Push API, VAPID); the outbox delivers a
  notification for every gate assigned to the user, with a **deep link** to the card or packet.
- A user can mute per project; nothing else is configurable in R1.
- **WIP limit**: each project (and each approver) has a limit on items waiting at a human gate. When
  it is reached, the scheduler starts no new build for that project; items queue with the reason
  "waiting on review". This is **backpressure**: agents slow down instead of the inbox growing.

## Consequences
- Amends ADR 0012: push is no longer deferred, only the native app is. Escalation and the daily
  digest still come later.
- The inbox shows when a project is held back by its WIP limit.
