# Spec 15 (R1): Web push, WIP backpressure and early metrics

Read first: ADRs [0012](../adr/0012-outbox-and-notifications.md),
[0040](../adr/0040-web-push-and-wip-backpressure.md),
[0011](../adr/0011-audit-journal-is-the-metrics.md),
[0041](../adr/0041-in-app-review-packet-is-the-merge-gate.md); specs
[01](01-operations-and-store.md), [12](12-r1-inbox.md), [14](14-r1-review-packet.md).

Added 2026-11-11 ([review decisions](../reviews/2026-11-11-review-decisions.md)): the R1 additions
for away-time and review load. All of it is R1 milestone (a).

## Goal
The approver hears about a gate when they are away from the inbox, agents slow down instead of
burying them, and three early metrics show whether review is getting cheaper.

## Scope
- **Web push.** `notification.subscribe` / `notification.unsubscribe` store a browser Push API
  subscription (VAPID keys are Worker secrets). A service worker in `apps/app` shows notifications;
  no installable PWA. The outbox delivers one push per gate or question assigned to a user, with a
  **deep link** to its inbox card (`/?item=<id>`) or review packet. Mute per project.
- **WIP limit and backpressure.** The autonomy policy sets a WIP limit per project (and optionally
  per approver): the number of items waiting at human gates. The scheduler (spec 03) starts no new
  build at the limit; items queue with the reason "waiting on review".
- **Early metrics**, as SQL views over the audit journal, behind `metrics.summary` (read):
  - **gate time**: median and p90 open time of human gates, per project, last 7 and 30 days;
  - **send-back rate**: share of review packets sent back at least once;
  - **cycle time**: intake to merge, median and p90;
  - **opened full diff?**: share of merge decisions where the approver opened the full diff first;
  - shown next to gate time: **rework** (send-backs per item) and, once there is history, **escaped
    defects** (ADR 0034).
- A one-line metrics strip in the inbox header (spec 12). The Metrics page stays R4.

## Out of scope
The native app, escalation of unread approvals, the daily digest, email or Slack notifications,
the Metrics page (R4).

## Acceptance criteria
1. A gate assigned to a subscribed user produces exactly one push, delivered after the state change
   commits, with a link that opens its card; a failed delivery is retried from the outbox.
2. A muted project sends no pushes; its cards still appear in the inbox.
3. Revoking a subscription (browser returns 404/410) removes it.
4. A project at its WIP limit starts no new build; deciding a gate that drops it below the limit
   lets the next queued build start.
5. Each metric is a SQL view over the audit journal; a test seeds journal rows and checks gate time,
   send-back rate, cycle time and the opened-full-diff share.
6. Gate time is never shown without rework next to it.
7. VAPID keys and push endpoints are never logged or committed.
