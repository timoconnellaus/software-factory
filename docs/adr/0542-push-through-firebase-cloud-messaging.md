# ADR 0542: Push goes through Firebase Cloud Messaging, and carries an item id and a type

Status: proposed, 2026-11-12. Spec [60](../specs/60-mobile-app.md). Builds on
[ADR 0012](0012-outbox-and-notifications.md) (the outbox) and
[ADR 0040](0040-web-push-and-wip-backpressure.md) (web push, not built).

## Context
The owner chose Google's push service, Firebase Cloud Messaging (FCM), with a free Firebase project
under the owner's Google account. A notification carries an item number and a type, never content.

Today a gate, question or status change writes a `notify` message to the outbox in the same batch
as the change. Delivery sends it to the person's `ClientHub`, which reaches open desktop apps. Web
push (spec 15) was never built. The `notify` payload carries a title with content in it.

## Decision
1. **Registration is per device.**
   - `push.register { token }` stores the phone's FCM registration token against the calling
     device, replacing any earlier one. It runs on the `mobile` surface only.
   - `push.unregister` removes it. So does revoking the device.
   - Tokens are stored encrypted with the engine's existing secret-encryption helper
     (`apps/engine/src/secrets.ts`), and they are never logged.
   - The app registers again whenever Firebase rotates its token.
2. **Fan-out comes from the existing outbox path.**
   - `notifyClients` already resolves who hears a `notify`: the named person, or the org's owners
     and admins. After it broadcasts to the hub, it also enqueues one `push.send` outbox row per
     registered phone of each of those people, filtered by that device's settings (6).
   - A `push.send` row is delivered and retried like any other row. FCM answering `UNREGISTERED`
     or `INVALID_ARGUMENT` for the token deletes the registration and is not retried.
   - At most one push per (device, work item, type) a minute. FCM's `collapse_key` is the work
     item id, so a phone that was offline gets the latest one, not a backlog.
3. **The payload is a data message with three fields and no content:**
   `{ "v": "1", "type": "<type>", "item": "<work item id>" }`.
   - `item` is the opaque work item id. The app looks up the number and title itself.
   - The payload carries no `notification` block. Android hands data messages to the app, which
     builds the notification (4).
   - Messages are `priority: high` only for the "Needs you" types, so Android's limits on
     high-priority messages aren't spent on information.
   - `type` is one of:

     | type | from | group |
     | --- | --- | --- |
     | `merge` | `gate.opened` for a merge gate | Needs you |
     | `plan` | `gate.opened` for a spec gate | Needs you |
     | `question` | `question.asked` and `question.escalated` | Needs you |
     | `policy` | a config proposal opened ([ADR 0543](0543-policy-changes-are-approved-on-the-phone-with-a-fingerprint.md)) | Needs you |
     | `approval` | any other `gate.opened`, and `gate.escalated` | Needs you |
     | `failed` | `workItem.failed`, `incident.opened` | Something went wrong |
     | `stuck` | `run.stuck` (new, spec 60) | Something went wrong |
     | `runner.offline` | `runner.offline` (new, spec 60) | Something went wrong |
     | `done` | `workItem.merged` and `workItem.done` | For your information |
     | `summary` | the daily summary (new, spec 60) | For your information |
     | `device.revoked` | the device was revoked | (never shown) |

4. **The phone builds the notification.**
   - On a push, the app's background handler reads the item through the door (`workItem.get`,
     and for `question` the open question) and posts a notification on the channel for its group.
   - If it can't read the item (offline, revoked, timed out after 10 s), it posts only the item
     number if it has it cached, and the kind: "A merge is waiting".
   - Approvals (`merge`, `plan`, `policy`, `approval`) have one action, **Review**, which opens the
     review screen. Nothing is approved from the notification.
   - A `question` from planning whose recommended answer is bulk-acceptable (not security,
     privacy or irreversible, ADR 0042) also has **Accept recommended**. It calls `planning.answer`
     with the recommended option from the background handler, after re-reading the question to
     check it is still open and still has that default. If the phone is offline, the action is
     not offered.
5. **The lock screen shows only the number and kind, unless the person turns details on.**
   - Every notification is posted with `VISIBILITY_PRIVATE` and a public version that reads
     `#13 · ready to merge`.
   - The setting "Show details on the lock screen" (default off) swaps in `VISIBILITY_PUBLIC`.
     Android's own "hide sensitive content" setting still wins.
6. **Settings are per device.**
   - `device.notifications.get` and `device.notifications.set` hold the switches per type, the
     daily summary's time and the device's time zone.
   - The engine drops a push for a type that is switched off, before it reaches FCM.
   - **Quiet hours** and **show details** shape how a notification appears, not whether it is
     sent, so the phone applies them. During quiet hours it posts on a silent channel.
   - Android's per-channel settings still apply on top.
7. **Where the credential lives.**
   - The engine sends with FCM's HTTP v1 API. It authenticates as a Google service account that
     has only the Firebase Cloud Messaging API Admin role, not the default Admin SDK account.
   - The account's JSON key is the Worker secret `FCM_SERVICE_ACCOUNT` on `sf-engine`. Only the
     owner sets it, with `wrangler secret put`.
   - The engine signs a JWT (RS256, WebCrypto), trades it for a one-hour access token, and keeps
     that token in memory per isolate until 5 minutes before it expires.
   - The app's Firebase options (project id, app id, API key, sender id) aren't secrets, but they
     identify the owner's Google project. They are passed at build time with
     `--dart-define-from-file`, from an Actions secret, and are not committed.
     `google-services.json` is not used.

## Consequences
- Google sees that a push went to the phone and its three fields. It never sees a title, a name,
  code or a decision.
- Each notification costs the phone one door read. In exchange, a lost or revoked phone shows
  nothing: once its token stops working, it can't read the item.
- Web push for browsers (spec 15) stays unbuilt. Should it come, it hangs off the same fan-out
  point.
- FCM data messages can be delayed on phones that restrict background apps. The app asks once to
  be exempt from battery optimisation, and the inbox re-reads whenever the app opens anyway.
