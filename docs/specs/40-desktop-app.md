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
- **Not yet:**
  - The `update_required` version handshake.
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

**Owner steps** (by hand, once; nothing in Xcode)
1. **Register the App ID.** [developer.apple.com/account](https://developer.apple.com/account) →
   Certificates, Identifiers & Profiles → Identifiers → **+** → App IDs → App. Platform macOS,
   description `SF Keys`, **Explicit** Bundle ID `com.software-factory.desktop.keys`. Use the team
   that issued the Developer ID Application certificate in `MACOS_CERT_P12` (the App ID prefix shown
   is that Team ID, `APPLE_TEAM_ID`). **Tick no capabilities** (no iCloud, App Groups or Push): the
   team's own `<TeamID>.com.software-factory.desktop.keys` keychain group is authorised by the
   profile's application identifier. Nothing else gets an App ID; the main app needs none.
2. **Make the profile.** Profiles → **+** → Distribution → **Developer ID** (macOS; not "Mac App
   Store", not "Mac Development"). Choose the App ID `com.software-factory.desktop.keys`, then the
   **same** Developer ID Application certificate that is in `MACOS_CERT_P12` (if there are several,
   the one whose SHA-1 matches `security find-identity -v -p codesigning`; a profile naming another
   certificate makes macOS kill the helper). Name it `SF Keys Developer ID` and download the
   `.provisionprofile`.
3. **Store it.** In the GitHub repo's `release` **environment** (not the repo's secrets), add
   `MACOS_KEYS_PROFILE` = the profile as one line of base64:
   `base64 -i SF_Keys_Developer_ID.provisionprofile | pbcopy`. It isn't secret strictly (every
   shipped app embeds it), but it belongs with the other release inputs.
4. **After the first M4b canary installs:** open the app, approve the one Touch ID prompt that makes
   the key, and approve this Mac again on the website when the app asks you to sign in (a new key is
   a new device; signing out revokes the software-key device).
5. **When the Developer ID certificate is renewed (5-year expiry) or revoked:** make a new profile
   for the new certificate (step 2) and replace `MACOS_KEYS_PROFILE`, or the helper stops launching
   and the app falls back to a software key (gate decisions then stop working from the desktop).
6. `DESKTOP_ALLOW_SOFTWARE_KEYS` stays empty in production. Nothing about M4b changes that.

**Build**
- **The bundle.** `scripts/bundle.sh` builds `vendor/SF Keys.app` from `native/sf-keys.swift`: the
  executable in `Contents/MacOS/sf-keys`, an `Info.plist` with `CFBundleIdentifier`
  `com.software-factory.desktop.keys` and `LSUIElement` true, and, on a release,
  `Contents/embedded.provisionprofile` from `MACOS_KEYS_PROFILE`. `electrobun.config.ts` copies it to
  `Resources/app/native/SF Keys.app`; `device-key.ts` runs `…/SF Keys.app/Contents/MacOS/sf-keys`.
- **The helper's signature.** Signed on its own, before Electrobun signs the app, with the Developer
  ID, the hardened runtime and exactly these entitlements (`native/sf-keys.entitlements`, Team ID
  filled in at build time): `com.apple.application-identifier` and `keychain-access-groups` =
  `<TeamID>.com.software-factory.desktop.keys`, `com.apple.developer.team-identifier` = `<TeamID>`.
  No JIT, no `disable-library-validation`. The app's own entitlements stay JIT-only.
- **First thing to check:** that Electrobun's signing of the app leaves the nested helper's
  signature, entitlements and profile alone. If it re-signs nested code with the app's entitlements,
  the release re-signs the helper and then the app's outer seal before notarizing, and says so here.
- **The helper's code.** `create`, `public`, `sign` and `delete` add `kSecUseDataProtectionKeychain`
  and `kSecAttrAccessGroup` (`<TeamID>.com.software-factory.desktop.keys`, read from its own
  entitlements at run time, so the Team ID isn't hard-coded). The key stays P-256 in the Secure
  Enclave with `.privateKeyUsage` and `.userPresence`, `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`,
  and no `touchIDAuthenticationAllowableReuseDuration`. `sign` keeps refusing anything but a presence
  message and builds the prompt from its summary line.
- **The release.** `desktop-release.yml` decodes `MACOS_KEYS_PROFILE` into the bundle and **fails**
  without it (a release that silently can't decide is worse than none). After signing, "Check the
  signature" also checks the helper: `codesign --verify --strict` with the requirement
  `anchor apple generic and identifier "com.software-factory.desktop.keys" and certificate
  leaf[subject.OU] = "$TEAM_ID"`; `codesign -d --entitlements -` shows the access group on the
  helper and **none** on the app's `bun` or launcher; the embedded profile (`security cms -D -i`)
  names `<TeamID>.com.software-factory.desktop.keys` and the signing certificate.
- **Migration.** A Mac signed in with a software key on an earlier signed build: on launch, when the
  helper works and the stored key is `software`, the app says "This Mac can now keep its key in the
  Secure Enclave: sign in again". Choosing it signs out as today (`desktopDevice.revoke` on its own
  device, then the software key is forgotten), and the sign-in makes the Secure Enclave key and
  registers it as a new device (`desktop.authStart`). Unsigned dev builds
  have no profile, so `create` fails as today and they keep a declared software key
  (`keyStorage: "software"`), which can't decide gates.

**What it does and doesn't protect against**
- **Does:** a same-user process (an agent, any script the app's `bun` runs) can't use the key: the
  keychain gives an access group's items only to a process whose own signed entitlements name it,
  and only the helper's do; adding the entitlement to anything else means re-signing it, which
  breaks the Developer ID chain the profile names, and macOS kills it. Hardened runtime with library
  validation keeps code from being injected into the helper.
- **Doesn't:** stop a same-user process from running `SF Keys.app` itself. It can make a prompt
  appear for a call of its choosing (the summary names that call truthfully, and the engine refuses a
  signature over any other), and a person who approves an unexpected prompt approves that call
  (ADR 0391: **an unexpected Touch ID prompt is a reason to stop**). It can also run `create` or
  `delete` and destroy the key, which is denial of service (the person signs in again), not a
  forged decision. With `.userPresence` the proof is as strong as the Mac's login password.

**Acceptance criteria**
- A release build's helper launches, makes the key and signs a presence message after a Touch ID
  prompt that shows the call's summary; the app shows `keyStorage: "secure-enclave"`, and a gate
  decided from the desktop is recorded with its presence proof.
- The release fails without `MACOS_KEYS_PROFILE`, and its signature check fails if the access group
  is on anything but the helper or the helper's requirement doesn't hold.
- Run on the M5 with a dummy key (tag `com.software-factory.desktop.m4b-test`, made by the release
  helper, never the real device key): a test binary that is not the helper (the app's `bun` running a
  script, and an ad-hoc signed Swift tool) asking for that tag in the access group gets nothing
  (`-34018` or not found); the helper finds it. The test deletes the dummy key afterwards.
- `sign` with no reuse window prompts on every call (two signatures in a row, two prompts).
- A Mac signed in with a software key on an earlier build is asked to sign in again once and then
  holds a Secure Enclave key; an unsigned dev build still signs in with a declared software key.
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
