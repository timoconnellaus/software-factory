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
- ~~A tag publishes stable.~~ (2026-11-12) Stable is a manual run on `main`, refused until the
  owner has locked the `release` environment down (`docs/deploying.md`, "Before stable releases"):
  a tag runs the tagged commit's own workflow file with the signing material.
- No signing material is in the repo.
- The app applies only an update that is a higher version, signed by its own Team ID and accepted
  by Gatekeeper, and no job is cancelled for an update unless the person says so.

**As built (M4a).** `.github/workflows/desktop-release.yml` runs on a macOS runner in the `release`
environment, on `main` only (it refuses any other ref and any commit that isn't on `origin/main`):
- **Signing:** the Developer ID goes into a throwaway keychain, and Electrobun's own
  `mac.codesign`/`notarize` sign (hardened runtime, JIT entitlements) and notarize with the App
  Store Connect key. Signing from a build hook doesn't work: Electrobun writes the build hash into
  `Resources/version.json` after every hook, which broke the seal ("damaged" on first launch, found
  on the M5). A `postPackage` hook zips the first-install download: the plain signed, notarized
  and stapled app from the update archive, not Electrobun's self-extracting wrapper. The wrapper
  showed a "Software Factory Setup" window that waited for a click, failed ("Installation failed")
  when macOS ran it translocated from Downloads, and rewrote its own bundle on first launch. Tested
  on the M5 (2026-11-12): the plain app passes `codesign --verify --deep --strict` and `spctl` before
  launch, after the first launch and after a relaunch, and its `launcher` and `bun` run.
  The certificate's password never reaches a command line, and the keychain and every key file are
  removed on failure too. Actions are pinned to commit SHAs.
- **Triggers:** pushes to `main` that touch `apps/desktop`, `packages/**`, `local/runner-host`, the
  root `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` or `.nvmrc`. That is a superset of the
  app's bundled workspace closure (the closure spec 38 computes for the runner, plus the view's
  packages): a path filter can't compute a closure, and an extra canary is harmless. Canary and
  stable have separate concurrency groups; nothing cancels a queued run.
- **Node:** the runner's Node is downloaded from nodejs.org at a pinned version and checked against a
  sha256 committed in `scripts/vendor-node.mjs` (not the same server's `SHASUMS256.txt`). CI refuses
  to build without `NODE_DIST_VERSION`.
- **Upload:** `scripts/publish-release.ts`, with an R2 token scoped to the bucket and held only by
  the `release` environment. Artifacts go to R2 bucket `sf-desktop-releases` under `desktop/`, served
  at `https://downloads.zerobsai.com/desktop` (the build's `release.baseUrl`), under versioned names,
  manifests last. It refuses a version that is already published or not higher than the live one.
- **The app** (`src/bun/updates.ts`) checks every 6 hours and lets Electrobun download and stage in
  the background. Electrobun trusts the bucket (it installs any manifest whose build hash differs,
  checks only a sha256 from that same manifest, and its helper checks no signature), so the app
  decides:
  - it refuses a manifest whose version isn't higher than its own (no downgrades);
  - it reads Electrobun's real state after the download (which swallows errors) and tries again in
    30 minutes;
  - before offering the update, and again right before applying it, it runs `codesign --verify
    --deep --strict` on the staged bundle against `anchor apple generic and identifier
    "com.software-factory.desktop" and certificate leaf[subject.OU] = "<Team ID>"`, with the Team ID
    read from the running app's own signature (never the manifest), and `spctl --assess`. An
    unsigned build takes no updates (`src/bun/update-verify.ts`);
  - after that check it reads the version and channel from the staged bundle's own
    `Contents/Resources/version.json`, which is inside the seal just verified, and requires the
    manifest's version, higher than its own, on its own channel. The manifest's version is only
    the bucket's word: a genuine older signed build served as "9.9.9" would pass the signature
    checks;
  - an app that can't replace itself (translocated from Downloads, or a folder this account can't
    write) says "Move Software Factory to your Applications folder" instead of failing silently.
- **Check for updates** (2026-11-13): a person can ask. *Check for Updates…* sits under About in
  the app menu (and in the menu bar's menu), always enabled; **Settings > This Mac** has an
  *Updates* card with the installed version and channel, when it last checked, what it found and a
  *Check for updates* button. Both show the same state (`UpdateStatus.phase`, worded once in
  `src/shared/update-check.ts`): *Checking…* (the button disabled), then exactly one of *You're up
  to date (0.1.x)*; *Downloading 0.1.y…* then *0.1.y is ready: Restart to update* (the same
  `restartToUpdate`, so no job is cancelled unless the person picks *Restart now*); or the reason
  in plain words (offline, the list of versions couldn't be read, the update was refused and why)
  with *Try again*. From the menu with the window open, it opens This Mac; with it closed, the menu
  bar shows *Checking for updates…* / *Downloading…* and a notification says what it found.
  A person's press is not held back by `ON_DEMAND_GAP_MS` (that gap is for the door's
  `update_required`); every trigger shares one check in flight, so pressing twice, or pressing
  during the 6-hourly check, joins it. An update already staged is reported ready, never downloaded
  again, and no check above is skipped. Dev builds and unsigned builds say *Updates are off in this
  build* and never check (an unsigned build could never apply one). Setting the app menu replaces
  the whole bar, so the standard Edit and Window menus are set with it. Tested in
  `test/updates.test.ts`; screenshots in `docs/screenshots/check-updates/`.
- **Restart to update** waits for the runner: no job is cancelled for an update (spec 38's rule).
  The app reads the runner host's `live-jobs.json`, at the path the runner child resolves (it gets
  only HOME, PATH and SF_RUNNER_DESKTOP, not the app's XDG or SF_RUNNER_* variables). While jobs
  run, the menu shows how many, offers *Restart to update when they finish*, and *Restart anyway
  (cancels N jobs; their unpushed work is lost)*. To close the window between reading the jobs and
  stopping the runner, the app first asks it to stop claiming (SIGUSR2; the runner host drains and
  rewrites `live-jobs.json` once any claim in flight has landed), reads the jobs again, and stops
  only an idle runner; if a job turned up it waits for idle, the runner still drained. If the
  update doesn't start (nothing staged, a refused signature, a quit handler said no, or a throw),
  the runner and the live socket come back (`src/bun/restart-update.ts`).
- **CI without the upload token:** a push to `main` checks for `DESKTOP_R2_*` first and, without
  them, skips building, signing, notarizing and uploading with one notice in the job summary.
  `publish-release.ts` fails closed: only a real 404 means "not published".
- **Verified only by hand:** a canary-to-canary update on a real Mac (download, stage, the
  signature check passing on a real staged bundle, the swap, the relaunch). The unit tests
  (`test/updates.test.ts`, `test/release.test.ts`, `test/restart-update.test.ts`) cover the
  decisions with a fake updater and fake `codesign`, plus a real ad-hoc signed bundle on macOS
  (the seal covers `version.json`; an old signed build sold as 9.9.9 is refused); `codesign`/`spctl` accepting a staged `….app.prepared-<hash>` copy of a real signed
  build, and refusing it with a wrong Team ID or one changed file, was checked on the M5
  (2026-11-12).
- **The version handshake** ([ADR 0393](../adr/0393-the-client-door-version-handshake.md)): the app
  sends `x-sf-client-protocol` (`DOOR_PROTOCOL`, `src/bun/protocol.ts`) on every door request and
  the live socket. Below sf-engine's `DESKTOP_MIN_PROTOCOL` (empty: serve every build) a desktop
  sign-in or token gets 426 `update_required`. The check is one gate at the top of the door's
  handler, so every route and socket gets it (spec 42's terminal socket too; its WebSocket client
  must send the protocol headers). A floor above the newest protocol the engine knows is ignored,
  not enforced. The app checks for an update (at most every 10 minutes) and the view shows an
  **Update required** screen instead of everything else: *Restart to update* when a verified update
  is staged (waiting for the runner's jobs, or naming what restarting now cancels), otherwise the
  download link and *Try again*. Recovery from a wrong floor is on the engine (ADR 0393). Tested in
  `apps/engine/test/desktop.test.ts` and `apps/desktop/test` (`update-required.test.ts`,
  `live.test.ts`).
  - The live socket: the WebSocket API hides a refused upgrade's status, so a socket that closes
    without ever opening asks the same URL over plain HTTPS once; a 426 `update_required` there
    shows the screen and stops reconnecting (*Try again* starts it again). Any other failure
    reconnects with backoff as before.
  - The terminal socket (spec 42) does the same: it sends the protocol headers on its upgrade, and
    one that never opened asks the door why; `update_required` closes it with *Update required*
    and shows the screen (`terminal.test.ts`).
  - *Restart to update* first asks the runner to stop claiming and shows **Waiting for the
    runner** (the menu, and the screen with a countdown) until it answers, for at most 30 s
    (`DRAIN_TIMEOUT_MS`, `restart-update.ts`). A runner that doesn't answer in time isn't stopped:
    the app says so and updates once it is idle (or *Restart anyway*). Terminals close with the
    live socket before the restart, and on quit.
  - A floor can't outrun the builds: each release writes `<channel>-macos-arm64-protocol.json`
    (the live build's version and `DOOR_PROTOCOL`) after its manifests, and
    `scripts/deploy/desktop-floor.ts`, in CI and before the deploy, refuses a
    `DESKTOP_MIN_PROTOCOL` above the protocol of the newest build on any channel that has
    published, failing closed (no protocol file for the live version, an unreadable bucket).
- **Not yet:**
  - **M4b, the Secure Enclave key:** its own section below. Until it ships, signed builds sign in
    with a software key, `DESKTOP_ALLOW_SOFTWARE_KEYS` stays empty in production, and gate decisions
    are made on the website. (2026-11-12, tested on the M5: no keychain restriction protects the
    desktop token or a software key from an agent running as the same user, because the app's `bun`
    runs any script under the app's signature, so a keychain ACL naming the app admits the agent
    too. That is why only a key the agent can't use may decide.)

## M4b: the Secure Enclave key helper
The owner chose (2026-11-12) to keep gate approvals on the desktop with Touch ID, so the key helper
is made to work on signed builds ([ADR 0394](../adr/0394-the-key-helper-is-its-own-signed-bundle.md)).
Tested on the M5 with the real Developer ID: a command-line `sf-keys` signed with
`keychain-access-groups` is killed by macOS (a restricted entitlement needs an embedded profile, and
a bare executable can't carry one), and without the entitlement the Secure Enclave refuses to make
the key (`-34018`). So the helper becomes `SF Keys.app`, a small bundle inside the app with its own
App ID and an embedded Developer ID provisioning profile. ADR 0391's guarantees hold unchanged: only
the helper can use the key, the key asks for the person every time (`.userPresence`: Touch ID, or
the login password as the fallback, as ADR 0391 decided; no reuse window), and the prompt shows only
the signed, engine-written summary of what is being approved.

Everything here assumes **System Integrity Protection is on** (the macOS default). With SIP off,
AMFI's profile check and the keychain's entitlement check can be bypassed by anyone with admin
rights, and no app-level design protects the key.

**Owner checklist** (by hand, once; nothing in Xcode). Exact values:
1. **App ID.** [developer.apple.com/account](https://developer.apple.com/account) → Certificates,
   Identifiers & Profiles → Identifiers → **+** → App IDs → App.
   - Platform: **macOS**.
   - Description: `SF Keys`.
   - Bundle ID: **Explicit**, `com.software-factory.desktop.keys` (check the spelling: a first
     attempt registered `om.software-factory.desktop.keys`, which is useless; delete it).
   - Team: the one that issued the Developer ID Application certificate in `MACOS_CERT_P12` (the App
     ID prefix shown is that Team ID, `APPLE_TEAM_ID`).
   - Capabilities: **none ticked** (no iCloud, App Groups or Push). The team's own
     `<TeamID>.com.software-factory.desktop.keys` keychain group is authorised by the profile's
     application identifier. Nothing else gets an App ID; the main app needs none.
2. **Profile.** Profiles → **+** → Distribution → **Developer ID** (macOS; not "Mac App Store", not
   "Mac Development"). App ID `com.software-factory.desktop.keys`; certificate: the **same**
   Developer ID Application certificate that is in `MACOS_CERT_P12` (if there are several, the one
   whose SHA-1 matches `security find-identity -v -p codesigning`; a profile naming another
   certificate makes macOS kill the helper). Name it `SF Keys Developer ID` and download the
   `.provisionprofile`.
3. **Verify it** before storing it: `security cms -D -i SF_Keys_Developer_ID.provisionprofile | plutil -p -`
   must show
   - `Entitlements` → `com.apple.application-identifier` = `<TeamID>.com.software-factory.desktop.keys`
     (exactly; a typo here is the mistyped bundle id),
   - `Entitlements` → `keychain-access-groups` includes `<TeamID>.*`,
   - `Entitlements` → `com.apple.developer.team-identifier` = `<TeamID>`, and `TeamIdentifier`
     = [`<TeamID>`],
   - `DeveloperCertificates`: one certificate, the Developer ID Application one in `MACOS_CERT_P12`
     (compare its SHA-1 with `security find-identity -v -p codesigning`),
   - `ExpirationDate`: note it; the release check prints it too.
4. **Store it.** In the GitHub repo's `release` **environment** (not the repo's secrets), add
   `MACOS_KEYS_PROFILE` = the profile as **one line** of base64:
   `base64 -i SF_Keys_Developer_ID.provisionprofile | tr -d '\n' | pbcopy`. It isn't secret
   strictly (every shipped app embeds it), but it belongs with the other release inputs.
5. **After the first M4b canary installs:** the app asks this Mac to sign in again. Making the key
   (`SecKeyCreateRandomKey`) never prompts. The app shows the new key's fingerprint; approve this
   Mac on the website only if the fingerprint there matches (a new key is a new device; signing out
   revokes the software-key device). **The first Touch ID prompt comes with the first gate decision
   made from the desktop** (an approval, a merge), showing that call's summary. Sign-in doesn't sign
   anything with the key.
6. **When the Developer ID certificate is renewed (5-year expiry) or revoked, or the profile
   expires:** make a new profile for the certificate (step 2), verify it (step 3) and replace
   `MACOS_KEYS_PROFILE`, or the helper stops launching and the app falls back to a software key
   (gate decisions then stop working from the desktop).
7. `DESKTOP_ALLOW_SOFTWARE_KEYS` stays empty in production. Nothing about M4b changes that.

**Until `MACOS_KEYS_PROFILE` is set**, every CI step that needs it skips cleanly with a notice
saying so. The release then ships without `SF Keys.app`, as today: a software key, no gate decisions
from the desktop. Once it is set, every helper step and check runs and must pass: a release with
the profile never ships a helper that failed a check.

**Build**
- **First build PR: the signing spike.** Electrobun signs, notarizes and packages (the zip and the
  update `tar.zst`) inside one `electrobun build`, so there is no step between "Electrobun signed
  the app" and "Electrobun notarized it" for the release to re-sign anything in, and Electrobun
  probably signs every Mach-O it finds itself (today's notarized builds carry `sf-keys` and Node
  under `Resources`, which notarization only accepts signed). Before the real helper is written, a
  throwaway PR settles how the helper survives that:
  - a minimal Swift bundle (no key use: it prints its own entitlements and exits), built on the macOS
    CI runner, signed with its own entitlements and embedded profile when `MACOS_KEYS_PROFILE` is
    present (and skipped cleanly when it isn't);
  - placed at `Contents/Helpers/SF Keys.app` (the standard place for nested code) and, to compare,
    under `Contents/Resources`;
  - signed at each hook Electrobun offers (`postBuild`, before its signing; `postWrap`; or
    `postPackage` with a re-sign of the outer seal and a second notarization of our own), until
    the final notarized app, the download zip and the update archive all carry a helper whose
    `codesign -dvvv --entitlements -` shows its own identifier, entitlements and Team ID, whose
    `embedded.provisionprofile` is intact, and that `spctl --assess` and `codesign --verify --deep
    --strict` accept, along with the outer app.
  The spike's PR reports exactly what works. The placement and hook it finds are written here and in
  ADR 0394 (dated amendment) before the helper is built.
  **Found (2026-11-13, ADR 0394's amendment):** Electrobun re-signs a nested bundle in
  `Contents/Helpers` or `Contents/Resources` with the app's entitlements, and `postWrap` comes
  after the update archive is made, so the helper goes in at **`postPackage`**
  (`scripts/keys-helper.ts`): into `Contents/Helpers/SF Keys.app` of the unpacked update archive,
  signed with its own entitlements, the outer seal re-signed, notarized and stapled again, the
  archive and its manifest rebuilt. Delta patches are off on releases with the helper. If no hook works, the fallback is to sign,
  notarize and package outside Electrobun (it builds unsigned, the release does the rest), recorded
  as its own ADR.
- **The bundle.** `scripts/bundle.sh` builds `vendor/SF Keys.app` from the Swift package
  `native/sf-keys-app` (built for macOS 14, arm64; `SFKeysCore` holds the parser, allowlist and exit
  codes, unit-tested by `swift test` in CI's `key helper (macOS)` job and before each release): the
  executable in `Contents/MacOS/sf-keys`; an `Info.plist` with `CFBundleIdentifier`
  `com.software-factory.desktop.keys`, `CFBundleName` and `CFBundleDisplayName` `SF Keys` (the
  Touch ID sheet names the process by it), `CFBundleExecutable` `sf-keys` and `LSUIElement` true;
  and, on a release with the profile, `Contents/embedded.provisionprofile` from
  `MACOS_KEYS_PROFILE`. It goes where the spike says (`Contents/Helpers/SF Keys.app` unless the
  spike shows Electrobun re-signs it there); `device-key.ts` runs `…/SF Keys.app/Contents/MacOS/sf-keys`.
- **The helper's signature.** The Developer ID, `--options runtime`, `--timestamp`, and exactly these
  entitlements (`native/sf-keys-app/sf-keys.entitlements`, Team ID filled in at build time):
  `com.apple.application-identifier` and `keychain-access-groups` =
  `<TeamID>.com.software-factory.desktop.keys`, `com.apple.developer.team-identifier` = `<TeamID>`.
  No JIT, no `disable-library-validation`. The app's own entitlements stay JIT-only.
- **The helper's surface.** Four commands: `create <tag>`, `public <tag>`, `sign <tag> <message>`,
  `delete <tag>`. The tag must be on an allowlist compiled into the helper: the device key
  (`com.software-factory.desktop.device-key`, as today) and the test tag (`com.software-factory.desktop.m4b-test`);
  any other tag is refused before the keychain is touched. The message's op must be one a desktop
  presence proof decides: the list is generated from the registry into
  `SFKeysCore/PresenceOps.swift`, and `test/keys-helper.test.ts` fails when it drifts. **The key signs presence messages only**:
  `sign` parses its message as a presence message (nonce, op, input digest, summary, ADR 0391) and
  refuses anything else, and that rule is what keeps the key from being used as a general signer.
  Every call adds `kSecUseDataProtectionKeychain` and `kSecAttrAccessGroup`
  (`<TeamID>.com.software-factory.desktop.keys`, read from its own entitlements at run time, so the
  Team ID isn't hard-coded). The key stays P-256 in the Secure Enclave with `.privateKeyUsage` and
  `.userPresence`, `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`, and no
  `touchIDAuthenticationAllowableReuseDuration`.
- **The prompt.** `sign` sets `localizedReason` from the summary line, worded to complete macOS's
  sentence "SF Keys is trying to …" (for example "SF Keys is trying to merge 3f2a91c into main of
  acme/widgets: "Fix the inbox count""). The summary is the engine's (`describeDecision`); the helper
  takes no prompt text from its caller.
- **Timeouts and cancel.** A presence challenge lives 60 s. The app kills the helper (`SIGTERM`, then
  `SIGKILL` after 2 s) when the challenge expires or the person cancels in the app; the helper
  handles `SIGTERM` by calling `LAContext.invalidate()`, which takes the Touch ID sheet down, and
  exits as cancelled. **One prompt at a time:** the app runs at most one `sign`; a second decision
  while one waits is refused in the app ("Another approval is waiting for Touch ID"). While it
  waits the app shows **Waiting for Touch ID: \<summary\>**, the same words as the sheet, so the
  person can match the two.
- **Exit codes** (`device-key.ts` maps each to its own error and message):
  `0` done; `2` usage or a tag not on the allowlist; `3` no key under the tag; `4` cancelled (by the
  person, by `SIGTERM` or by the system); `5` the message is not a presence message (refused); `6`
  authentication failed (wrong password too often, biometry locked out); `1` anything else, with
  the `OSStatus` on stderr.
- **The release** (`desktop-release.yml`), with `MACOS_KEYS_PROFILE` set, after Electrobun's build:
  - the helper's requirement holds: `codesign --verify --strict` with `anchor apple generic and
    identifier "com.software-factory.desktop.keys" and certificate leaf[subject.OU] = "$TEAM_ID"`;
  - it is signed with a secure timestamp (`codesign -dvvv` shows `Timestamp=`, not
    `Signed Time=`) and the hardened runtime (`flags=0x10000(runtime)`);
  - `codesign -d --entitlements -` shows the access group on the helper and **none** on the app's
    `bun`, launcher or any other Mach-O in the bundle;
  - **every entitlement the helper claims is allowed by its embedded profile's `Entitlements`**
    (each key present; `keychain-access-groups` and `application-identifier` matched against the
    profile's values, where `<TeamID>.*` allows the group), and the profile's certificate is the
    signing certificate;
  - the step prints the profile's `ExpirationDate`, and warns when it is under 60 days away.
- **In the app (2026-11-13):** `device-key.ts` runs `Contents/Helpers/SF Keys.app/Contents/MacOS/sf-keys`
  (the bare `sf-keys` in `Resources` is gone); "Waiting for Touch ID: \<summary\>" is a toast with
  Cancel; the re-enrol offer is a toast on launch and a button on This Mac; the sign-in screen shows
  the new key's fingerprint while it waits for the browser.
- **Migration.** A Mac signed in with a software key on an earlier signed build: on launch, when the
  helper works and the stored key is `software`, the app says "This Mac can now keep its key in the
  Secure Enclave: sign in again". Choosing it signs out as today (`desktopDevice.revoke` on its own
  device, then the software key is forgotten), and the sign-in makes the Secure Enclave key and
  registers it as a new device (`desktop.authStart`). **This can be phished:** the key-storage
  marker lives in the app's keychain, which an agent running as the person can write, so an agent
  can flip it to `software`, make the banner appear, and race its own `desktop.authStart` (with a key
  it holds) so the person approves the agent's device on the website. So the app shows the new
  key's fingerprint while it waits for approval, the website's approval page shows the fingerprint
  of the key in the request (`/desktop/connect` does today), and the person approves only when they
  match. Unsigned dev builds have no profile, so `create` fails as today and they keep a declared
  software key (`keyStorage: "software"`), which can't decide gates.
- **Downgrade.** An older build (before M4b) can't reach the Secure Enclave key: it looks for a
  software key, finds none, and signs in again with a new software key. The Secure Enclave key is
  orphaned in the keychain (harmless: only the helper can use it, and its device is revoked when the
  person signs out or removes it on the website). Upgrading again finds it, but the device it
  belonged to was signed out, so the app makes a fresh key (`delete`, then `create`) and signs in.

**What it does and doesn't protect against**
- **Does:** a same-user process (an agent, any script the app's `bun` runs) can't use the key: the
  keychain gives an access group's items only to a process whose own signed entitlements name it,
  and only the helper's do. The profile ties that entitlement to the Developer ID certificate, so no
  caller check in the helper is needed: adding the entitlement to anything else means re-signing
  it, which breaks the chain the profile names, and macOS kills it. Hardened runtime with library
  validation keeps code from being injected into the helper.
- **Doesn't:** stop a same-user process from running `SF Keys.app` itself. It can make a prompt
  appear for a call of its choosing (the summary names that call truthfully, and the engine refuses a
  signature over any other), and a person who approves an unexpected prompt approves that call
  (ADR 0391: **an unexpected Touch ID prompt is a reason to stop**). It can also run `create` or
  `delete` and destroy the key, which is denial of service (the person signs in again), not a
  forged decision. With `.userPresence` the proof is as strong as the Mac's login password. Nothing
  here holds with SIP off.

**Tests the build must have.** GitHub's macOS VMs have no Secure Enclave, so CI can't make a key:
- **Launch smoke test (CI, on the signed release build, when the profile is set):** run the signed
  helper with `public com.software-factory.desktop.m4b-test` (a tag with no key) and expect exit
  `3`, "no key", not `SIGKILL`: that proves AMFI accepted the profile and entitlements.
- **Swift unit tests** for the presence-message parser and the tag allowlist (a well-formed
  message; a missing line; extra lines; a non-hex digest; an unknown op; an empty or overlong
  summary; a tag not on the list), run by `swift test` (or a test target compiled with `swiftc`) on
  the macOS runner.
- **The release checks above** (requirement, timestamp, hardened runtime, entitlements against the
  profile, the access group only on the helper, the profile's expiry), as a script with its own
  tests against fixture profiles.
- **On the M5, by hand,** the dummy-key test in the acceptance criteria.

**Acceptance criteria**
- A release build's helper launches, makes the key and signs a presence message after a Touch ID
  prompt that shows the call's summary; the app shows `keyStorage: "secure-enclave"`, and a gate
  decided from the desktop is recorded with its presence proof.
- **What the prompt shows.** The summary of a merge names the repository, the commit being merged
  (short SHA) and the work item's title, and says so plainly when the merge is without checks
  (`mergeWithoutChecks`): `Merge 3f2a91c into main of acme/widgets, without its checks: "Fix the
  inbox count"`. Every client sends `headSha` with `review.merge`, so the proof binds the commit.
  **The engine's facts come first and any title last** (amended 2026-11-13, review of #150): a
  title is agent-written, so it is quoted last with double quotes, format characters (Cf) and line
  breaks removed, and the whole summary is cut to 120 characters (`titled`, `MAX_SUMMARY`). A title
  can't pose as the repository or push "without its checks" off the sheet, and can't make an item
  undecidable (the helper refuses Cf, Zl, Zp and control characters). Every `describeDecision` case
  follows this, new ones included.
- Killing the helper on expiry or cancel takes the Touch ID sheet down; each exit code above maps to
  its own message in the app; a second decision while one waits is refused; the app shows "Waiting
  for Touch ID: \<summary\>".
- Without `MACOS_KEYS_PROFILE`, the release skips the helper with a notice and ships as today. With
  it, the release fails if any check above fails: the launch smoke test, the requirement, the
  timestamp, an entitlement the profile doesn't allow, the access group on anything but the helper.
- Run on the M5 with a dummy key (tag `com.software-factory.desktop.m4b-test`, made by the release
  helper, never the real device key): a test binary that is not the helper (the app's `bun` running a
  script, and an ad-hoc signed Swift tool) asking for that tag in the access group gets nothing
  (`-34018` or not found); the helper finds it. The test deletes the dummy key afterwards.
- `sign` with no reuse window prompts on every call (two signatures in a row, two prompts).
- A Mac signed in with a software key on an earlier build is asked to sign in again once, the app
  and the website show the same key fingerprint, and it then holds a Secure Enclave key; an
  unsigned dev build still signs in with a declared software key.
- `DESKTOP_ALLOW_SOFTWARE_KEYS` is empty in every deployed config (the existing test still passes).

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
