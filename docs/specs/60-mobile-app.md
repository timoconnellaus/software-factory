# Spec 60: The phone app (Android first, Flutter)

**Read first**:
- the interview plan [`.kim/plans/2026-11-12-mobile-app-v1-android-flutter.md`](../../.kim/plans/2026-11-12-mobile-app-v1-android-flutter.md).
  Every "Decided" line in it is binding.
- the phone design [`docs/design/mobile/`](../design/mobile/README.md): 29 screens at 390 × 844,
  and the rules that hold on every screen. It supersedes the plan's "not designed yet" list.
- the desktop design [`docs/design/factory-ui/README.md`](../design/factory-ui/README.md): the model
  and the look.
- ADRs [0540](../adr/0540-the-phone-app-is-flutter-in-apps-mobile.md) (the app),
  [0541](../adr/0541-phone-devices-keystore-keys-and-fingerprint-proofs.md) (devices, pairing,
  proofs), [0542](../adr/0542-push-through-firebase-cloud-messaging.md) (push) and
  [0543](../adr/0543-policy-changes-are-approved-on-the-phone-with-a-fingerprint.md) (policy
  approval);
- what they build on: [ADR 0391](../adr/0391-the-client-door-desktop-devices-and-presence.md),
  [0392](../adr/0392-the-website-shrinks-to-auth.md), [0370](../adr/0370-factory-config-lives-in-the-app.md)
  and [spec 40](40-desktop-app.md).

## Goal
A person runs the factory from an Android phone. They:
- decide what waits on them: merges, plan approvals and policy changes with a fingerprint, answers
  with one tap;
- steer the planner;
- capture ideas into a backlog;
- watch, message, pause and stop running agents;
- release work;
- chat with the factory.

Factory setup (editing workflows, agents, skills and policy by hand) stays on the desktop. The
phone runs no agents, which makes it the safest device to approve from.

## Where main stands (2026-11-12)
| What | On main | The phone uses it as |
| --- | --- | --- |
| The client door (`apps/engine/src/cli.ts`) | `/client/v1` `call`, `batch` (20 reads), `live` (WebSocket to `ClientHub`), `ops`; token kinds `cli` and `desktop`; `$bytes` both ways | its only way in; a third token kind, `mobile` |
| Devices and presence (`packages/core/src/operations/desktop.ts`, migration 0160) | P-256 device keys, `presence.challenge`, `presence.redeem`, the signed message `nonce\nop\ndigest\nsummary`, summaries written by the engine, `presenceDecidable` on `spec.approve`, `spec.requestChanges`, `review.merge`, `review.sendBack`, `approval.decide`, `question.answer`, `question.acceptDefaults`; software keys refused | the same scheme, with a Keystore key (ADR 0541) |
| Notifications (`apps/engine/src/outbox.ts`, `client-hub.ts`) | `notify` outbox messages (`gate.opened`, `gate.escalated`, `question.asked`, `question.escalated`, `planning.ready`, `workItem.<status>`, `workItem.attached`, `protection.changed`, `run.confinement`), fanned out by `notifyClients` to `ClientHub` | the fan-out point for FCM (ADR 0542). Spec 15's web push was never built |
| The registry (`packages/core`) | zod input and output schemas, risk, `browserOnly`, `presenceDecidable` | the source of the generated Dart types (ADR 0540) |
| Shared client logic (`packages/client`) | TS: `OpMap`, inbox grouping, packet, planning, questions, work item steps, format | ported to Dart where needed, kept in step by fixtures |
| Planning (spec 20, merged) | `planning.get`, `planning.presence`, `planning.move`, `chat.send`, `question.*` | Questions and Chat tabs |
| Planning steering (spec 26: PRs #67, #71, #78, open) | `planning.peek`, `planning.answer`, `planning.acceptDefaults`, `planning.finishAlone`, `planning.pause`, `planning.resume`, `planning.stop`; `desktopDecidable` | answers, Stop and Pause on a planning run |
| The work model (spec 50: PRs #64, #69, #79, open) | `repository.*`, `project.update`, `workItem.board`, `workItem.update`, `workItem.move`, `workItem.reorder`, `workItem.release`, `workItem.link`, `workItem.unlink`, `queue.pull`, `workItem.shape`, `workItem.shaped` | the Work tab |
| Watching runs (spec 31) | `run.live`, `run.steer` (the runner's owner only) | the running item |
| Config (spec 09) | `config.get`, `config.preview`, `config.save`, `config.rollback`; loosening is `self-modify`; `approval.decide` applies an approved config change | policy approval, through new operations (ADR 0543) |
| The downloads site (PR #80, open) | `downloads.zerobsai.com/desktop`, R2 `sf-desktop-releases`, canary and stable | `/android/` beside it |
| The door protocol (PR #81, open) | `x-sf-client`, `x-sf-client-protocol`, `DESKTOP_MIN_PROTOCOL` → 426 | `MOBILE_MIN_PROTOCOL` |

## Screens without an operation (start here)
These screens show data or take an action that **no operation provides on main or in an open PR**
(checked against main and PRs #63–#81). Each gap is assigned to a PR in the build plan. Where
another spec owns the operation, the phone waits for it and doesn't invent its own.

| Screen | What is missing | Who adds it |
| --- | --- | --- |
| Every screen: signing in, pairing, devices, the `mobile` surface | `mobile.*` sign-in and pairing, `device.*`, token kind `mobile`, attestation | this spec, **PR 1a** |
| MergeGate, Fingerprint ("for this commit only") | `review.merge` has no head SHA in its input, so a proof can't bind to the commit | this spec, **PR 1a**: `review.merge` gains `headSha` |
| Diff | no operation reads a PR's files or patch | this spec, **PR 3**: `review.diff` |
| LockScreen, Notifications | push registration, settings per device, FCM delivery | this spec, **PR 2** |
| Notifications: "An agent is stuck" | no `run.stuck` event | this spec, **PR 2** |
| Notifications: "A runner went offline" | no `runner.offline` event | this spec, **PR 2** |
| Notifications: "Daily summary 8:00" | no summary | this spec, **PR 2** |
| Notifications: "A run failed or an incident opened" | `incident.open` writes no `notify` | this spec, **PR 2** |
| PolicyApprove, ChatThread's "drafted a change" card | `config.propose`, `config.proposal.get`, `config.approve`, version digests | this spec, **PR 8** (ADR 0543) |
| PlanEdit (tap a line to edit it), PlanApprove's "Overturn" an assumption | no plan-line edit or overturn operation, on main or in #67, #71 or #78 | **spec 26** (its next slice); the phone's PR 5 waits for it |
| PlanMockups, and the full-screen viewer (not drawn) | artifacts and pinned comments: spec 21's `artifact.*` and `chat.send` with a `pin` aren't built | **spec 21**; the phone's PR 9 |
| ItemRunning: Pause and Stop on a **build** run | `planning.pause` and `planning.stop` cover planning runs only. There is no `run.pause` or `run.stop` | the desktop's item side panel needs the same thing. This spec proposes `run.pause` and `run.stop` (runner owner, like `run.steer`) in **PR 6** unless a desktop spec claims them first |
| WorkReady: "1 heavy slot free · 2 waiting on your review" | `runner.list` gives slots. The review-WIP count isn't in `workItem.board` (#69) | **PR 6** adds `capacity` to `workItem.board`'s output, coordinated with spec 50 |
| ChatList, ChatThread, and PlanChat's "drafted a change" card | the factory chat (Chat in the desktop design) has no backend: no chat sessions or threads outside planning, and no tools for adding to the backlog, releasing or drafting a change | **a factory-chat spec, not yet written**, shared with the desktop. The phone's PR 10 waits for it |
| You: runners | `runner.list` exists. Its owner-only fields need checking on the `mobile` surface | PR 4 |

## Navigation
- Bottom tabs: **Inbox**, **Work**, **Chat**, **You**, with a capture button in the middle.
  Screens opened from a list have a back arrow and no tabs.
- It opens on the Inbox, across all orgs, with org chips to filter.
- Deep links (go_router):
  - `/work/<id>`;
  - `/work/<id>/review` (`MergeGate`);
  - `/work/<id>/plan/{questions,plan,chat,mockups}`;
  - `/policy/<pendingActionId>`;
  - `/chat/<id>`.
  The same paths come in as App Links under `https://<site>/open/…`, the ADR 0392 trampoline, so a
  `factory/verify` link opens on the phone.
- Light and dark follow the phone's setting (You → Appearance can override). The tokens are the
  desktop design's, as a Dart `ThemeExtension` in `lib/ui/tokens.dart`.

## Screens and their operations
Reads go through `batch` where a screen loads more than one. "Proof" means a fingerprint presence
proof (ADR 0541). "Online" means the action is disabled offline, with a note.

### Getting in
| Screen | Shows / does | Operations |
| --- | --- | --- |
| `SignIn` | Two ways in: scan a code, or GitHub in the browser | `mobile/nonce`, then `mobile.authStart` (unsigned) |
| `Pair` | Camera, where to find the code, **Enter a code by hand** | `mobile.authStart { offer }`, `mobile.authExchange` |
| `PairConfirm` | Code accepted; the account and its orgs; name the phone; switches for fingerprint approval and notifications; **Add this phone** | `mobile.authExchange`, `org.list`, `device.update { name, decides }`, `push.register` |
| Browser sign-in (Custom Tab, then the App Link back) | the website's `/mobile/connect` | `mobile.authLookup`, `mobile.approveDevice` (website, browser-only), `mobile.authExchange` |
| Desktop and website: Settings → Devices → **Add a phone** | the QR and typed code; then the paired phone with **Not my phone? Remove** | `mobile.pairOffer` (desktop with Touch ID, or the website), `device.list`, `device.revoke` |
| Typed code (not drawn) | ten characters in groups of five | `mobile.authStart { offer }` |

### Inbox and decisions
| Screen | Shows / does | Operations |
| --- | --- | --- |
| `Inbox` | Merges, Plans, Questions, then Running; org chips; Merge and Send back on the card. **Merge opens the fingerprint sheet**, and Send back opens `SendBack` | `inbox.list` (all orgs, or `orgId`); `workItem.board` or `workItem.list` for Running; `org.list`; live socket |
| `InboxEmpty` | Nothing waits; offline banner with the time of the last load and the queued ideas | the cache and the capture queue |
| `InboxQuestion` | A question from a run: options with the recommended one picked, **Other, or add a note**, why it was asked, **Accept recommended** | `workItem.get`, `question` fields from `inbox.list`; `question.answer` (one tap; proof for security, privacy and irreversible questions). Online |
| `MergeGate` | Verdict, checks, criteria proven or not, tests intact, the diff summary, **Send back**, **Merge with fingerprint** | `workItem.get` (the packet); `review.merge { workItemId, headSha, openedFullDiff }` with proof. Online |
| `Diff` | One file at a time, file chips, previous and next | `review.diff { workItemId, headSha, path? }` (new). Opening it sets `openedFullDiff` |
| `SendBack` | A required note (voice input); it goes to the same build session | `review.sendBack` (one tap). Online |
| `Fingerprint` | The system sheet naming what is approved and the commit | `presence.challenge`, then the decision call with `presence` |
| `PolicyApprove` | Before and after, loosening marked, what can't change, `Version 14 → 15 · a41c9e2`, **Reject**, **Approve with fingerprint** | `config.proposal.get`; `config.approve` (proof when approving). Online |
| `LockScreen` | The kinds of notification; Review opens the review; Accept recommended on a planner question | push (ADR 0542); `planning.answer` from the notification |

### Planning (the four tabs on a work item)
| Screen | Shows / does | Operations |
| --- | --- | --- |
| `PlanQuestions` | Answered rows, the open question with options and the reason, Skip, **Accept all 3**, **Approve plan** | `planning.get` (every 3 s while open); `planning.answer` (also Skip); `planning.acceptDefaults`; `planning.presence` |
| `PlanEdit` | Tap a line; Save and Cancel under it | **spec 26's plan-line edit (not built)** |
| `PlanChat` | Chat with read receipts; the planner's current step with **Stop**; voice; a link to the mockups | `chat.send` (and `{ interrupt: true }`, #71); `planning.stop` |
| `PlanMockups` | Option cards for one question; Choose; Full screen; Comment; Ask for another | **spec 21's `artifact.*` (not built)**; `planning.answer` to choose; `chat.send` with a `pin` to comment; `chat.send` to ask for another |
| `PlanApprove` | The finished plan with its split, the summary line, **Request changes**, **Approve plan + 2 items** | `planning.get`; `spec.approve` (proof); `spec.requestChanges` (one tap); Overturn waits for spec 26 |

### Work
| Screen | Shows / does | Operations |
| --- | --- | --- |
| `WorkBacklog` | Lanes Backlog, Planning, Ready, Running, Done; project picker; drag to reorder; tap to expand with Open, Plan it, Ready, Release | `workItem.board`; `workItem.reorder`; `workItem.shape` (Plan it); `workItem.move` (Ready); `workItem.release`. Writes need a connection |
| `ItemBacklog` | Notes and attachments, project, priority, workflow, the factory's triage notes and size; Edit; **Mark ready**; **Plan it** | `workItem.get`; `workItem.attachment.list`/`get`; `workItem.update`; `workItem.move`; `workItem.shape` |
| `WorkReady` | Capacity at the top; Release, disabled with the reason when an item waits for another; To backlog | `workItem.board` (with `capacity`, gap); `runner.list`; `workItem.release`; `workItem.move` |
| `WorkRunning` | Running work grouped by stage, what needs you outlined | `workItem.board` |
| `ItemRunning` | The activity stream: hand-offs, the plan and its tasks, the live run, the checks; composer; **Pause** and **Stop** | `workItem.timeline`, `workItem.get`, `run.live` (polled, as the desktop does); `run.steer` (owner only; others see the composer disabled with why); `run.pause` and `run.stop` (gap); `planning.pause` and `planning.stop` on a planning run |

### Capture and chat
| Screen | Shows / does | Operations |
| --- | --- | --- |
| `Capture` | Title, notes, an attachment, project, priority, voice and camera; **Add to backlog**. Nothing starts | `project.list`; `workItem.create` (lands in Backlog, #69) with an idempotency key; `workItem.attachment.add` (`$bytes`). **Queues offline** |
| `CaptureVoice` | Dictation with a live transcript | on-device speech (`speech_to_text`) into the title and notes. No server call until Add |
| `CaptureShare` | What was shared (text, URL, image), prefilled; project, priority | as Capture. Android `ACTION_SEND` text and images through `receive_sharing_intent` |
| `ChatList` | Chats, newest first, with their projects; New chat | **the factory-chat spec (not written)** |
| `ChatThread` | Messages with cards for items mentioned and for what the chat did (added to the backlog, sent to an agent, drafted a change) | **the factory-chat spec**; the cards link to `workItem.get` and `/policy/<id>` |

### You
| Screen | Shows / does | Operations |
| --- | --- | --- |
| `You` | Account; orgs with what waits in each; runners; Notifications; Approve with fingerprint; Appearance; Devices; version and update; Sign out | `org.list`; `inbox.list` counts; `runner.list`; `device.update`; `device.list`; the update feed; Sign out = `device.revoke` (self) and a local wipe |
| `Notifications` | Switches per kind in three groups, the daily summary time, quiet hours, show details on the lock screen | `device.notifications.get` and `.set` (types, summary time, time zone); quiet hours and details are kept on the phone (ADR 0542) |
| Devices (not drawn) | Every device of the person: platform, name, key storage, last seen, **Remove** | `device.list`, `device.revoke` |

**Notification defaults, from the design:**
- on: a merge or plan approval is waiting, the planner asked a question, a policy change needs
  approval, a run failed or an incident opened, an agent is stuck;
- off: a runner went offline, an item merged or finished, the daily summary (08:00), show details
  on the lock screen;
- quiet hours 22:00–07:00.

### Not drawn yet (build from the same parts)
- Dark mode for each screen (from the tokens).
- The full-screen mockup viewer: a sandboxed WebView, as described under Security.
- The Devices list (above), the typed pairing code (above) and search (not in v1 unless the owner
  asks).
- **Error states beyond offline.** Every screen handles these in one shared way:
  - `unauthenticated`: wipe and go to SignIn;
  - `update_required`: an update screen;
  - `conflict`: re-read and say what changed, for example "A new push withdrew this approval";
  - `forbidden` with a reason: show the reason;
  - other failures: a retry banner.

## The server side
All of it is operations, in `packages/core`, behind the door.

**Migration 0310**:
- `core_desktop_devices` is rebuilt, keeping its name (renaming it touches every reader for
  nothing) and every row. It gains `platform` (`macos|android`), `attestation` (JSON), `decides`
  (default 1), and `key_storage` widens to `secure-enclave|strongbox|tee|software`.
- `core_desktop_auth_requests` gains `platform`, `attestation`, `offer_id`.
- `core_cli_tokens` is rebuilt so that `kind` allows `mobile`.
- New tables:
  - `core_mobile_nonces` (hash, expiry);
  - `core_pair_offers` (id, user, secret hash, typed-code hash, attempts, expiry, consumed);
  - `core_push_registrations` (device, encrypted token, updated);
  - `core_device_notification_settings` (device, types, summary time, time zone).
- `core_project_policies.content_digest`, backfilled.
- The proposal digest lives in the `config` pending action's input.
- The test checks that the old desktop devices, tokens and challenges survive the rebuilds.

**Operations** (new unless marked):
- Sign-in and pairing (ADR 0541):
  - `mobile.nonce`, `mobile.authStart` and `mobile.authExchange` (unsigned, as
    `MOBILE_DEVICE_ACTOR`);
  - `mobile.authLookup`, `mobile.approveDevice` and `mobile.denyDevice`
    (browser-only);
  - `mobile.pairOffer` (website, or desktop with a proof);
  - `mobile.renew` (proof).
- Devices: `device.list`, `device.revoke` and `device.update`. `desktopDevice.list` and
  `desktopDevice.revoke` become aliases.
- Push: `push.register`, `push.unregister`, `device.notifications.get` and
  `device.notifications.set`.
- `review.diff { workItemId, headSha, path? }`:
  - `read` risk;
  - through the GitHub connector with the project's installation token;
  - the file list, and one file's hunks at a time, capped at 2,000 lines;
  - refused with `conflict` if `headSha` isn't the PR's head.
- `review.merge` gains an optional `headSha`, and the phone always sends it. If it doesn't match
  the merge gate's head, the call is refused with `conflict`. The summary names the short SHA:
  `Merge 3f2a91c "Guard the tests in verify" into main`.
- Policy (ADR 0543): `config.propose`, `config.proposal.get` and `config.approve`.
  `CONFIG_SOURCES` gains `chat`.
- `run.pause` and `run.stop` (if no desktop spec has claimed them): runner owner, like `run.steer`,
  through the runner channel's existing steer path.
- Events:
  - `run.stuck`: the runner host reports, from the hook status file (ADR 0380), that the agent is
    waiting on input or a permission for 10 minutes. Once per wait.
  - `runner.offline`: a runner's heartbeat is more than 5 minutes late. Once per outage, to its
    owner.
  - `incident.opened`: written by `openIncident`.
  - The daily summary: the minute cron, per device at its local time. It names only counts.
- `invoke()`:
  - `mobile` joins `SURFACES`;
  - `presenceAllows` accepts `desktop` and `mobile`;
  - `deviceDecidable(surface, input)` replaces #71's `desktopDecidable` (ADR 0541 decision 5);
  - the door maps a token of kind `mobile` to the `mobile` surface.
- The door: `mobile/nonce`, `mobile/start` and `mobile/exchange`, unsigned;
  `MOBILE_MIN_PROTOCOL`; `live` accepts mobile tokens.
- **Attestation:** `packages/core/src/attestation/android.ts`. It parses the chain with a small
  ASN.1 reader (`@peculiar/asn1-schema`, if PR 1a shows it runs in workerd; otherwise hand-parsed),
  verifies the signatures with WebCrypto, and pins Google's roots. The engine fetches the
  revocation list from `https://android.googleapis.com/attestation/status` and caches it for a day.
  The checks are in ADR 0541 decision 3.
  `MOBILE_SIGNING_CERTS` (wrangler `vars`) lists the release key's certificate SHA-256 and, in dev
  only, the debug key's.
- **The dev build flavour** (settled 2026-11-12, review of PR 1a). The emulator's Keystore attests
  at the software level, under no Google root, and the production engine always refuses that: no
  flag on it changes this (`DESKTOP_ALLOW_SOFTWARE_KEYS` is for a Mac's unsigned build only and
  never lets a phone decide). So the app has a `dev` flavour with its own package id,
  `com.zerobsai.factory.dev`, and its own launcher name, signed with the debug key. Only a
  non-production engine accepts it: `wrangler dev` with a local entry point (PR 1b adds it beside
  `apps/engine/src/index.ts`; the deploy never builds it) that sets `mobileTestSeams` to trust the
  emulator's attestation root for the dev package alone. There a dev-flavour sign-in registers as
  `software`, so it signs in and reads but can't decide. The production engine knows only
  `MOBILE_PACKAGE` (`com.zerobsai.factory`), a constant, so a dev build never signs in to it, and
  a release build never needs the dev path.
- **The website** (`apps/app`, which keeps device pages under ADR 0392):
  - `/mobile/connect`;
  - Settings → Devices with **Add a phone** (the QR is drawn in the browser from the offer);
  - `/.well-known/assetlinks.json` for the package and release certificate;
  - `/mobile/callback`, which only bounces to the app if the App Link didn't catch it.
- **The desktop:** Settings → Devices → **Add a phone** dialog. This is a new component and one
  route hook in `apps/desktop`, which the desktop sessions own. Coordinate, and keep the hook small.

### Policy approval on the phone, in one line
Chat proposes. The engine computes the impact. A human approver approves on the phone, after the
before-and-after, with a fingerprint over `config.approve`'s input. That input carries the base
version and the proposal's digest, so the proof binds to that exact version. Loosening stays a
human-only change with proof, in code (ADR 0543).

## Client architecture (ADR 0540)
```
apps/mobile/
  .flutter-version          pinned Flutter
  pubspec.yaml              riverpod, go_router, drift, http, firebase_core, firebase_messaging,
                            flutter_local_notifications, speech_to_text, image_picker,
                            receive_sharing_intent, mobile_scanner, flutter_secure_storage
  analysis_options.yaml     flutter_lints, warnings are errors
  android/                  Gradle, the release signing config (from env), DeviceKeyPlugin.kt,
                            the App Link intent filter, the share intent filters
  lib/
    gen/ops.g.dart          generated: typed inputs, outputs, Ops facade, risk and decidability
    door/                   the door client: call, batch, live socket, $bytes, protocol header, errors
    device/                 the DeviceKey channel: generate (with attestation), sign (BiometricPrompt)
    data/                   drift: read cache, capture queue
    push/                   FCM handler, notification channels, actions
    ui/                     tokens, shared parts (cards, chips, decision bar, fingerprint sheet)
    features/{inbox,review,planning,work,capture,chat,you,signin}/
  test/                     unit and widget tests; vectors/ (generated)
  integration_test/         emulator flows against a local engine
```

- **The door client** mirrors the desktop's `door.ts`:
  - a bearer token;
  - `x-sf-client: mobile` and `x-sf-client-protocol`;
  - `call` with an idempotency key on every write;
  - `batch` for reads;
  - `decide(op, input)`. If the op needs a proof on `mobile`, it runs `presence.challenge`, then
    the fingerprint, then `call` with `presence`. Otherwise it is a plain `call`. Generated
    metadata decides which. A test checks it against core's list.
- **The token** is in `flutter_secure_storage`: EncryptedSharedPreferences, wrapped by a Keystore
  AES key that needs no user authentication, so a background push can read an item. Android's
  backup rules leave it out.
- **Live:** the hub socket in the foreground, FCM in the background, and a full re-read on resume
  and on reconnect.
- **The offline cache:**
  - a drift table `reads(op, inputDigest, json, readAt)`, the last 200 entries and attachments up
    to 50 MB, least recently used first;
  - screens render the cache first, then the network;
  - the banner shows "as of".
- **The capture queue:**
  - a drift table `captures(id, idempotencyKey, input, attachments, state, attempts)`;
  - it drains on connectivity, with backoff;
  - an attachment is uploaded after its item is created, each upload with its own idempotency key;
  - only captures queue. Every other write is disabled offline.
- **Voice:** Android's `SpeechRecognizer` through `speech_to_text`, on device where the phone
  offers it. Audio is never uploaded by us. Used in Capture, SendBack, the planning chat and Chat.
- **Share sheet:** `ACTION_SEND` for `text/plain` and `image/*` opens `CaptureShare`.
- **In-app update:**
  - `https://downloads.zerobsai.com/android/{canary,stable}/latest.json` is checked every 6 h and
    on `update_required`;
  - the APK is downloaded, its SHA-256 checked, and installed with `PackageInstaller`;
  - `REQUEST_INSTALL_PACKAGES` is asked for once;
  - You shows "Update to 0.1.15 · 12 MB".
- **Release:** `.github/workflows/mobile-release.yml` in the `release` environment:
  - it builds with `--dart-define-from-file` (Firebase options) and signs with the release key from
    secrets (`MOBILE_KEYSTORE_B64`, `MOBILE_KEYSTORE_PASSWORD`, `MOBILE_KEY_ALIAS`,
    `MOBILE_KEY_PASSWORD`);
  - it uploads to R2 `sf-desktop-releases` under `android/`;
  - canary is `0.1.<run>` on `main`, and stable comes from `mobile-v*` tags. `versionCode` is the
    run number.

## Keeping behaviour in step with the desktop
What **can't be shared**: the screens, and every line of `packages/client`, which is TypeScript.
The phone's Dart ports are:
- inbox grouping (`inbox.ts`);
- the packet's sections and verdict wording (`packet.ts`);
- question order and the recommended-answer rules (`questions.ts`, `planning.ts`);
- work item steps (`work-item.ts`);
- formatting (`format.ts`);
- attachment checks (`attachments.ts`).

How the two stay in step:
1. **The types are generated** from the registry and checked for staleness in CI (ADR 0540).
2. **Fixtures are shared.** `packages/client/scripts/export-fixtures.ts` writes the inputs and
   expected outputs of `packages/client`'s tests for the ported modules to
   `apps/mobile/test/fixtures/*.json`. Dart tests run the same cases. The Node CI job fails if the
   fixtures are stale. Canonical JSON and input digests have their own vectors.
3. **The engine does the judging.** Anything with a safety or policy consequence is computed by
   the engine and only shown by the clients:
   - presence summaries;
   - `policyImpact`;
   - whether a question is bulk-acceptable;
   - whether a release is allowed and why not;
   - which operations need a proof on which surface.
   Neither client decides these locally.
4. **Wording comes from one place.** Where `packages/client` holds user-facing strings (step
   names, verdicts, timeline lines from `packages/timeline`), the fixtures carry them, so the phone
   says what the desktop says.
5. **Decidability is tested.** A core test pins, for `desktop` and `mobile`, which operations need
   a proof and which are one tap. Changing either list fails it, and the change shows in the PR.

## Security
**What the phone stores:**
- the device key, non-exportable in StrongBox or the TEE, usable only after a fingerprint;
- the `sfm_` token, encrypted by a Keystore key and left out of backups;
- the read cache and capture queue in the app's private storage, which Android encrypts at rest
  (file-based encryption, unlocked after the first unlock);
- the FCM registration token.

It stores no GitHub token, no model credential and no runner key.

**What a lost phone can do:**
- **Locked:** nothing useful. Notifications show only "#13 · ready to merge", unless the person
  turned details on. Notification actions that call the door (Accept recommended) need the phone
  unlocked: they are `setAuthenticationRequired(true)` on Android 12 and up, and on Android 10 and
  11 the action opens the app instead.
- **Unlocked, with the thief's own fingerprint:** impossible without the PIN. Enrolling a
  fingerprint needs the PIN, and doing so destroys the key (ADR 0541).
- **Unlocked, without a fingerprint:**
  - it can read the cache;
  - it can do every one-tap action: capture, answer planning and build questions with their
    defaults or other answers, send back, request changes, edit, reorder, move and release backlog
    items, message agents (owner only), pause and stop runs, and chat;
  - it can't merge, approve a plan, approve a policy change, renew the token or turn approvals
    back on.
  - The worst cases: work released early (it still goes through every gate and the merge gate),
    work sent back, a run stopped, and a planner answered wrongly. Each is visible and reversible,
    and none reaches `main`. See open question 2 (an app lock).

**Cutting it off:**
- remove the phone from the desktop's Settings → Devices or the website (`device.revoke`);
- its token fails at once (`unauthenticated`), its push registration is deleted, and a last
  `device.revoked` push tells the app to wipe itself if it is online;
- the token also lapses after 30 days unless renewed with a fingerprint;
- the journal shows every call by `deviceId`, so the person can see what was done.

**Other rules:**
- **Notification content:** none in the push (ADR 0542). The phone fetches it, posts it
  `VISIBILITY_PRIVATE`, and shows details on the lock screen only if the person turned that on.
- **Mockups:** planning mockups are untrusted HTML from an agent. The viewer is a WebView with
  JavaScript limited to spec 21's `postMessage` bridge, loading only from the sandboxed mockup
  origin, with no file access, no cookies and no navigation out.
- **Chat and agent text** is shown as text. Links open in a Custom Tab. Nothing an agent writes
  becomes a button that decides anything.

## Build plan
Small PRs, in order. Each leaves main working. Each app PR includes **screenshots from the
emulator, light and dark, beside the mockup**:
- an AVD of 1170 × 2532 at 480 dpi, which is 390 × 844 dp, running Android 14;
- the screenshot taken with `adb exec-out screencap -p`;
- the mockup rendered by headless Chrome at 390 × 844;
- shown as a three-column table in the PR: mockup, light, dark.

A screen with no drawn dark mode shows only light and dark of the build.

Before anything, the **gaps table above** is the list of operations that don't exist. PRs 1a, 2, 3,
6 and 8 add the ones this spec owns. PRs 5, 9 and 10 wait on specs 26 and 21 and on a factory-chat
spec.

**PR 1a: server: phone devices, pairing and proofs** (cloud only)
- Migration 0310; the `mobile.*`, `device.*` and `presence` changes; attestation; `review.merge`
  with `headSha`; `mobile` on the door with `MOBILE_MIN_PROTOCOL`; the website's `/mobile/connect`,
  Add a phone and `assetlinks.json`; `deviceDecidable`.
- Acceptance:
  1. A captured real attestation chain (a fixture from a Pixel, with the challenge) registers. Each
     of these is refused, and nothing is minted:
     - a chain that doesn't reach a pinned root;
     - a revoked certificate;
     - a wrong challenge;
     - a key without biometric auth, or with an auth timeout;
     - another package or signing certificate;
     - a key from a software level.
     A chain whose boot state is unverified registers with `key_storage = software`.
  2. The browser flow and the QR flow each mint exactly one `sfm_` token. A reused offer, a reused
     code, a wrong PKCE verifier and an expired offer are refused. Five wrong typed codes close the
     offer.
  3. Desktop and website **Add a phone** work. On the desktop, `mobile.pairOffer` needs a Touch ID
     proof. Runner, CLI and desktop approvals stay refused on `desktop` even with a proof.
  4. On `mobile`:
     - `review.merge`, `spec.approve` and approving with `approval.decide` need a proof;
     - `question.answer` and `planning.answer` with a security, privacy or irreversible kind need
       a proof, and the other kinds don't;
     - `review.sendBack`, `spec.requestChanges` and rejecting with `approval.decide` don't;
     - the replay, wrong-op, wrong-digest, expired, other-device, revoked-device and
       `decides = false` proofs are refused.
     The decidability test pins all of this.
  5. `review.merge` with a stale `headSha` is refused with `conflict`, and nothing merges.
  6. Revoking a phone makes its token fail `unauthenticated` on the next call. The old desktop
     rows still work after migration 0310.
  7. The spec 40 and spec 07 tests pass unchanged.
- Screenshots: the website's `/mobile/connect` and Add a phone, before and after.

**PR 1b: the app: sign-in, the Inbox and the merge gate** (the first app PR)
- `apps/mobile` scaffold; CI (`mobile.yml`); the generator with stale-check; canonical-JSON vectors;
  tokens and theme; the door client; DeviceKeyPlugin; the screens `SignIn`, `Pair`, `PairConfirm`,
  `Inbox`, `InboxEmpty` (online part), `MergeGate`, `Fingerprint` and `SendBack`.
- Acceptance:
  1. On the emulator, the `dev` flavour against a local engine (see "The dev build flavour"), it
     signs in by the browser and by a QR from the website, and registers as `software`. The Inbox lists every org's waiting items, and the
     chips filter.
  2. Merging from the gate or the card opens the fingerprint sheet (on the emulator the engine then
     refuses the software key's proof, and the app says "this phone can't approve"). Its text equals the engine's
     summary, with the short SHA. Merging records `openedFullDiff`.
  3. Send back requires a note and sends it in one tap.
  4. A stale head shows "A new push withdrew this approval" and re-reads.
  5. The Dart vectors match core's byte for byte. The generated file is fresh.
     `flutter analyze` is clean, and the `flutter test` widget tests cover the three decision paths.
  6. On a real phone with the `dev` flavour against a local engine (the owner, by hand), StrongBox
     or the TEE registers, and a merge asks for the fingerprint once.
- Screenshots: SignIn, Pair, PairConfirm, Inbox, MergeGate, Fingerprint, SendBack.

**PR 2: push and notification settings**
- `push.*`, `device.notifications.*`, the FCM sender, the fan-out, `run.stuck`, `runner.offline`,
  `incident.opened`, the daily summary; on the app, FCM, channels, `LockScreen` behaviour,
  `Notifications`.
- Acceptance:
  1. A gate opening produces exactly one push per subscribed phone, after commit. Its body is
     exactly `{v, type, item}`. A test asserts that no title, number or text is in it.
  2. A type switched off sends nothing. An `UNREGISTERED` token removes the registration.
  3. Tapping a merge notification opens `MergeGate`. Nothing is approved from a notification.
  4. **Accept recommended** answers a planning question from the notification, and it isn't
     offered for security, privacy or irreversible questions or when offline.
  5. With details off, the lock screen shows only the number and kind.
  6. `FCM_SERVICE_ACCOUNT` is never logged, and FCM tokens are stored encrypted.
- Screenshots: LockScreen (details on and off) and Notifications.

**PR 3: the diff**
- `review.diff`; the `Diff` screen.
- Acceptance: files one at a time, capped; a stale head is refused; opening it sets
  `openedFullDiff`.
- Screenshot: Diff.

**PR 4: You, devices, renewal and revocation**
- The `You` screen; the Devices list (not drawn); `mobile.renew`; Sign out; the wipe on revoke;
  update checks shown (installing them comes in PR 7).
- Acceptance:
  1. Revoking from the desktop wipes the phone on its next call or push.
  2. Renewal asks for a fingerprint and replaces the token.
  3. Turning approvals off makes `presence.challenge` refuse, and turning them on takes a
     fingerprint.
- Screenshots: You, Devices.

**PR 5: planning**
- `PlanQuestions`, `PlanChat`, `PlanApprove`, `InboxQuestion`; and `PlanEdit` and Overturn once
  spec 26 has the operation.
- Acceptance:
  1. Answers and Skip are one tap, and security questions ask for a fingerprint.
  2. Accept all never covers what bulk accept excludes.
  3. Approve plan asks for a fingerprint naming the item and its split.
  4. Chat with interrupt, and Stop, work.
  5. Tabs re-read every 3 s while open.
- Screenshots: PlanQuestions, PlanChat, PlanApprove, InboxQuestion (and PlanEdit when it lands).

**PR 6: work**
- `WorkBacklog`, `ItemBacklog`, `WorkReady`, `WorkRunning`, `ItemRunning`; `capacity` on the board;
  `run.pause` and `run.stop` if still unclaimed.
- Acceptance:
  1. Drag to reorder persists.
  2. Plan it, Ready, To backlog and Release work.
  3. Release is disabled, with the engine's reason, when an item waits for another.
  4. The composer is disabled with a reason for a run on someone else's runner.
  5. Pause and Stop reach the run.
- Screenshots: all five.

**PR 7: capture, offline and updates**
- `Capture`, `CaptureVoice`, `CaptureShare`, the capture queue, the read cache, the offline banner
  (`InboxEmpty`), the in-app update and `mobile-release.yml`.
- Acceptance:
  1. In airplane mode, reads show "as of", and captures queue and send once when back online. A
     replay test checks there are no duplicates.
  2. Every other write is disabled with a note.
  3. Sharing a URL and an image from Chrome prefills the capture.
  4. A canary published by CI is offered and installs over the previous one.
  5. No signing material is in the repo.
- Screenshots: Capture, CaptureVoice, CaptureShare, InboxEmpty.

**PR 8: policy approval**
- `config.propose`, `config.proposal.get`, `config.approve`, version digests, `PolicyApprove`.
- Acceptance:
  1. A proposal by the chat actor changes nothing until approved.
  2. `config.approve` with a proof applies exactly that version. A changed document, a moved base
     or a different digest is refused, and nothing is applied.
  3. `approval.decide` refuses to approve a config proposal.
  4. Agents, the CLI and MCP can't approve.
  5. The screen's loosening marks come from `policyImpact`, and an unclassifiable change shows as
     loosening.
- Screenshot: PolicyApprove.

**PR 9: mockups** (after spec 21)
- `PlanMockups` and the full-screen viewer.
- Acceptance: choose, comment with a pin, ask for another; the viewer can't navigate out or read
  cookies.
- Screenshots: PlanMockups and the viewer.

**PR 10: chat** (after the factory-chat spec)
- `ChatList` and `ChatThread`, with item, backlog and draft cards, and voice.
- Acceptance: the chat can add to the backlog, message an agent and draft a change. It never
  approves or merges. Its draft opens `PolicyApprove`.
- Screenshots: ChatList, ChatThread.

## What the owner must do
1. **Create the Firebase project.**
   1. At <https://console.firebase.google.com>, choose **Create a project**. Name it
      `software-factory` and turn Google Analytics off.
   2. In the project, choose **Add app → Android**. Package name: the one confirmed in open
      question 1 (default `com.zerobsai.factory`). Nickname "Software Factory". Skip the SHA-1. Skip
      downloading `google-services.json`, or download it and keep it private; it isn't committed.
   3. **Project settings → Cloud Messaging:** check that the *Firebase Cloud Messaging API (V1)*
      is enabled.
   4. In <https://console.cloud.google.com> for the same project, go to **IAM & Admin → Service
      accounts → Create service account**. Name it `sf-engine-fcm` and give it the role
      **Firebase Cloud Messaging API Admin**, nothing else. Then **Keys → Add key → JSON**.
   5. Put the key on the engine yourself; don't paste it in a chat or a PR:
      `pnpm --filter sf-engine exec wrangler secret put FCM_SERVICE_ACCOUNT` and paste the JSON.
      Then delete the downloaded file.
   6. From **Project settings → General → Your apps**, add the Android app's values (`projectId`,
      `appId`, `apiKey`, `messagingSenderId`) as a JSON object in the GitHub Actions secret
      `MOBILE_FIREBASE_OPTIONS`, in the `release` environment. These aren't secret, but they
      identify your Google project.
   7. Hand over: only "done", and the package name. Nothing else needs to reach the agents.
2. **Create the signing key** (once; losing it means every phone must uninstall to update).
   1. Run
      `keytool -genkeypair -v -keystore sf-mobile-release.jks -alias sf-mobile -keyalg RSA -keysize 4096 -validity 10000`
      and choose a strong password.
   2. Back it up offline (a password manager entry and an offline copy).
   3. Add the GitHub Actions secrets in the `release` environment:
      - `MOBILE_KEYSTORE_B64` (`base64 -i sf-mobile-release.jks`);
      - `MOBILE_KEYSTORE_PASSWORD`;
      - `MOBILE_KEY_ALIAS` (`sf-mobile`);
      - `MOBILE_KEY_PASSWORD`.
   4. Run `keytool -list -v -keystore sf-mobile-release.jks -alias sf-mobile` and hand over the
      certificate's **SHA-256** line. It is public: it goes into `MOBILE_SIGNING_CERTS` and
      `assetlinks.json`.
3. **On the phone, once:** allow your browser to install apps (Settings → Apps → Special access →
   Install unknown apps). For PR 1b's check by hand, enable USB debugging, or install the debug APK
   from the CI artifact.
4. **Approve the loosenings** at the merge gate on this PR (ADRs 0541 and 0543):
   - approving a phone pairing from the desktop with Touch ID;
   - one-tap answers, send back and request changes on the phone;
   - chat proposing config changes.

## Open questions for the owner
Only what the interview and the designs didn't settle. Until answered, the build uses the default
in brackets.
1. **The package name.** It is permanent once phones install the app. [`com.zerobsai.factory`]
2. **An app lock.** Should opening the app need the fingerprint or PIN, so that an unlocked phone
   in someone else's hand can't answer, send back, release or stop? [No lock; only approvals take
   the fingerprint, as decided.]
3. **No PIN fallback.** Approvals take a fingerprint only, never the PIN. A broken sensor or a new
   fingerprint means pairing again, or approving on the desktop. Is that acceptable? [Yes:
   fingerprint only.]
4. **Unlocked or rooted phones.** Should a phone whose bootloader is unlocked or whose boot isn't
   verified be refused outright, or registered as a phone that can't approve? [Registered, can't
   approve.]
5. **A canary channel on the phone**, as on the desktop, or stable only? [Both; the phone follows
   stable unless switched in You.]
6. **Build questions answered by one tap.** The designs show a run's question accepted without a
   fingerprint, and the plan says "ordinary answers are one tap". On the desktop these still take
   Touch ID. Keep them different, or relax the desktop to match? [Different: one tap on the phone
   only; the desktop is unchanged.]

## Out of scope
- iOS (same code later, with its own key and attestation work).
- Tablets, languages other than English, and Android older than 10.
- Editing workflows, agents, skills or policy by hand.
- Linking items and bulk actions.
- Typing into a terminal.
- Search.
- Web push for browsers (spec 15).
