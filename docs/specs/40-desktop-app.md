# Spec 40: The desktop app

**Read first**: [ADR 0390](../adr/0390-the-desktop-app-is-the-daily-ui.md),
[0391](../adr/0391-the-client-door-desktop-devices-and-presence.md),
[0392](../adr/0392-the-website-shrinks-to-auth.md),
[ADR 0340](../adr/0340-a-cli-for-people-gates-stay-in-the-browser.md) (the CLI door and the
browser-only rule this amends), the spike [`spikes/electrobun`](../../spikes/electrobun/README.md),
and the plan [`.kim/plans/2026-11-11-software-factory-desktop-app-electrobun.md`](../../.kim/plans/2026-11-11-software-factory-desktop-app-electrobun.md).

## Goal
A person runs the factory from a macOS app.
- It tells them when a gate is waiting and lets them decide it, with Touch ID as proof that a person
  decided.
- It keeps this Mac's runner up.
- It opens from any factory link.

The website keeps only sign-in, device approval and the GitHub install flow.

The build lands as five milestones, each one PR (or more), in order.

## M1: the client door, desktop devices and presence (cloud only)
**Scope**
- **Migration 0160:**
  - `core_desktop_auth_requests`: id, the PKCE challenge, device name, device public key (JWK),
    state, status `pending|approved|denied|consumed`, `user_id`, the hash of the one-time code,
    timestamps, expiry 10 min.
  - `core_desktop_devices`: id, `user_id`, name, public key (JWK), `created_at`, `last_seen_at`,
    `revoked_at`.
  - `core_presence_challenges`: id, `device_id`, op, `input_digest`, `summary`, the nonce's hash,
    `expires_at` (60 s), `consumed_at`.
  - `core_cli_tokens` gains `kind` (`cli|desktop`, default `cli`) and `device_id`.
- **Operations:**
  - `desktop.authStart` and `desktop.authExchange`: unsigned, as `DESKTOP_DEVICE_ACTOR`. The
    exchange checks the PKCE verifier (S256), consumes the code once, registers the device and
    mints a `write` desktop token for it.
  - `desktop.authLookup` and `desktop.approveDevice` (browser-only), `desktop.denyDevice`.
  - `desktopDevice.list` and `desktopDevice.revoke`. Revoking a device revokes its tokens.
  - `presence.challenge { op, inputDigest }`: desktop surface only. Returns the nonce and a summary
    of the decision the engine writes from the input (the Touch ID prompt shows it).
  - The browser-only operations listed as presence-decidable in ADR 0391 carry
    `presenceDecidable: true`.
- **`invoke()`:**
  - `desktop` joins `SURFACES`.
  - `Origin` gains `deviceId` and `presence { op, inputDigest }`.
  - Step 4c allows a browser-only call on `desktop` only when the op is presence-decidable and
    `origin.presence` matches the op and the SHA-256 of the canonical JSON of the input.
  - Every refusal still says `browserOnly: true`.
- **The door:**
  - `sf-engine` serves `/client/v1/{device/start,device/poll,call,batch,ops}` and the desktop
    routes `desktop/start` and `desktop/exchange`. `/cli/v1` is an alias.
  - The token's kind sets the surface.
  - `call` accepts `presence { challengeId, signature }`. The door verifies the ECDSA P-256
    signature over `nonce ‖ "\n" ‖ op ‖ "\n" ‖ inputDigest ‖ "\n" ‖ summary` with the device key, consumes the
    challenge and sets `origin.presence`.
  - `batch` runs up to 20 `read`-risk calls.
- **The website:**
  - `/desktop/connect?request=…` shows the device name and approves or denies. Approving redirects
    to `sf://auth/callback?code=…&state=…`.
  - `/open/*` is the trampoline.
  - Devices are listed and revoked in Setup.

**Acceptance criteria**
1. The desktop auth flow (`authStart` → approve → `authExchange` with the right verifier) yields a
   desktop token once. A wrong verifier, a reused code or an expired request is refused, and nothing
   is minted.
2. A desktop token runs `inbox.list` and `workItem.create` on the `desktop` surface, and the audit
   row records `deviceId`.
3. Without a presence proof, `review.merge`, `spec.approve`, `question.answer` and
   `approval.decide` are refused on `desktop` with `forbidden` and `browserOnly: true`.
4. With a valid proof for that op and input, the call runs. Each of these is refused:
   - the same proof replayed;
   - a proof for another op;
   - a proof whose digest doesn't match the input;
   - an expired challenge;
   - a signature from another device or a revoked device.
5. `cli.approveDevice`, `desktop.approveDevice`, runner registration and turning a kill switch off
   stay refused on `desktop` even with a proof.
6. A proof from a device with a software key is refused, unless the engine runs with
   `DESKTOP_ALLOW_SOFTWARE_KEYS=1`. The default refuses.
7. A CLI token can't ask for a challenge (`presence.challenge` is desktop-only). Its gate calls are
   refused as before.
8. Revoking a device makes its token fail `unauthenticated` on the next call.
9. `/cli/v1` keeps working for `sf` unchanged. The spec 07 tests pass.
10. `/open/work/123` renders a page that links to `sf://work/123`, plus a sign-in fallback.

## M2: `apps/desktop`: the shell, sign-in and the runner
Built as **M2a** (everything here except the live socket; the inbox count polls `inbox.list` every
15 s) and **M2b** (the WebSocket hub, which brings notifications under 5 s, criterion 3).

**Scope**
- `apps/desktop` on Electrobun 2.x and Hutch, from the spike. Outside Biome's view of the Hutch
  devkit; its own `typecheck` and `build` turbo tasks.
- **Sign-in:**
  - a Secure Enclave key with `.userPresence`, usable only by the `sf-keys` helper (its own
    keychain-access-group entitlement), which builds the Touch ID prompt from the signed summary;
  - the browser flow;
  - the token in the Keychain, used only by the main process;
  - **Sign out** revokes the token.
- **The runner:**
  - supervision on a bundled Node 24 with restart and backoff;
  - the single-instance lock, and `sf-runner`'s host lock;
  - launchd takeover;
  - menu-bar status.
- **Live updates:** a WebSocket from the app to a Durable Object per user on `sf-engine` (inbox
  changes, gate opened). On reconnect the app re-reads `inbox.list`.
- Notifications, the dock badge and launch at login.
- `sf://` deep links routed into the SPA, including a link that cold-starts the app.

**Acceptance criteria**
1. A fresh install signs in through the browser and shows the inbox count in the menu bar.
2. The runner restarts after a crash. It keeps running when the window closes and stops on quit.
   A second app instance focuses the first. A second `sf-runner` refuses to start.
3. A gate opening on the engine notifies within 5 s while the app is running.
4. `sf://work/<n>` opens that work item, whether the app is running or not.
5. The token never reaches the webview (a test asserts the RPC schema has no token field) and is
   absent from disk outside the Keychain.

## M3: the screens at parity
Inbox, New work, work item detail (with Planning), review packet (Merge / Send back, with Touch ID),
Setup, runners. Moved from `apps/app` to `apps/desktop`, loaders on `batch`.

**Acceptance criteria**
- Each screen's existing tests pass against the client door.
- Approving a merge in the app asks for Touch ID once and merges through the merge queue.

**As built** (`desktop-m3-screens`)
- **Shared logic** moved out of `apps/app` into `packages/client` (operation types and `OpError`,
  format, inbox grouping, the review packet, planning, questions, work item steps, runner labels,
  attachment checks, runner pairing); both apps import it, and its tests moved with it. The view's
  attachment rules come from `@software-factory/core/attachment-rules`, which has no runtime
  dependencies.
- **The React screens were ported, not shared**: `apps/desktop/src/mainview/{routes,components}`
  follow sf-app's markup, wording and test ids. sf-app's copies go in M5.
- **Data:** `read()` batches each tick's reads into one `batch` call on the door (up to 20); `op()`
  takes an idempotency key; a held call answers `pending`. Who is signed in comes from `org.list`,
  which now returns the caller's `userId`.
- **Gate decisions** go only through `decide()`: the view's `op()` refuses them, and so does the
  main process's `call`. A test checks the desktop's list against core's `presenceDecidable`
  operations.
- **Attachments:** the door carries bytes as `{ "$bytes": "<base64>" }` both ways
  (`apps/engine/src/wire-bytes.ts`), so New work and the work item upload through
  `workItem.attachment.add` and show images from `workItem.attachment.get`. Files and rulesets
  are saved to ~/Downloads through the main process (`saveDownload`).
- **Planning** re-reads `planning.get` every 3 s while the tab is open: the door has no planning
  stream yet (sf-app uses Server-Sent Events).
- **Still on the website:** browser-only operations (registering a runner or rotating its key,
  approving devices, a kill switch off) and project settings and workflows (spec 09, which came
  after this spec). Setup links to the website for them. M5 has to keep those pages or move
  project settings into the desktop first.
- **Tests:** the timeline's wording renders in the desktop; every page's loader asks for what the
  page renders; merge and send back run through the main process's handlers and the door client
  against a fake door, signing exactly once (`test/client-door.test.ts`). Touch ID itself and
  the merge queue aren't exercised here: the queue is the engine's (spec 06), and the proof's
  redemption is covered in `apps/engine/test/desktop.test.ts`.

## M4: signing, notarization and updates
GitHub Actions on macOS builds, signs and notarizes the app, and uploads canary and stable to R2.
The in-app updater follows the channel. The client door's version handshake can answer
`update_required`.

**Acceptance criteria**
- A merge to `main` touching the app publishes a canary that an installed canary picks up.
- A tag publishes stable.
- No signing material is in the repo.

**As built (M4a).** `.github/workflows/desktop-release.yml` runs on a macOS runner in the `release`
environment (only `main` and `v*` tags may use it):
- **Signing:** the Developer ID goes into a throwaway keychain, and Electrobun's own
  `mac.codesign`/`notarize` sign (hardened runtime, JIT entitlements) and notarize with the App
  Store Connect key. Signing from a build hook doesn't work: Electrobun writes the build hash into
  `Resources/version.json` after every hook, which broke the seal ("damaged" on first launch, found
  on the M5). A `postPackage` hook zips the signed wrapper as the first-install download.
- **Node:** the runner's Node is downloaded from nodejs.org at a pinned version and checked against
  `SHASUMS256.txt`.
- **Upload:** artifacts go to R2 bucket `sf-desktop-releases` under `desktop/`, served at
  `https://downloads.zerobsai.com/desktop` (the build's `release.baseUrl`).
- **The app** checks every 6 hours, downloads in the background and offers *Restart to update*,
  stopping the runner cleanly first.
- **Not yet:**
  - The `update_required` version handshake.
  - **M4b, the Secure Enclave key.** Tested on the M5 with the real Developer ID: a command-line
    `sf-keys` signed with `keychain-access-groups` is killed by macOS (restricted entitlement, no
    profile), and without the entitlement the Secure Enclave refuses (`-34018`). So the key helper
    has to become its own small bundle (`SF Keys.app` inside the app) with an embedded **Developer ID
    provisioning profile** for its own App ID. That profile is made in the Apple Developer portal.
    Until then signed builds sign in with a software key and decide gates on the website.

## M5: the website shrinks to auth
`apps/app` keeps sign-in, Connect GitHub, the device approval pages, device management and
`/open/*`. Everything else is removed. The `factory/verify` check and notifications link through
`/open/`.

**Acceptance criteria**
- Every removed route redirects through `/open/`.
- No screen exists in both apps.

## Out of scope
- Windows and Linux.
- A phone path for gate decisions (would need WebAuthn presence).
- A presence reuse window: not adopted (ADR 0391).
