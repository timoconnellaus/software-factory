# ADR 0394: The key helper is its own signed bundle with a Developer ID profile

Status: accepted, 2026-11-12. Spec [40](../specs/40-desktop-app.md) M4b. Carries out
[ADR 0391](0391-the-client-door-desktop-devices-and-presence.md)'s "only the key helper can use the
key" on a Developer ID build.

## Context
ADR 0391 makes the desktop's gate decisions need a presence proof: a signature by a Secure Enclave
key that asks for Touch ID (or the login password, `.userPresence`) every time, and whose prompt shows
the engine-written summary of the call. It also says only the key helper, `sf-keys`, may use the key,
because the app's `bun` runs any script under the app's signature (the spike's finding, retested on
the M5 on 2026-11-12: no keychain ACL that names the app keeps a same-user agent out).

What keeps the key to the helper is a **keychain access group**: the key is made in the
data-protection keychain under a group, and `securityd` lets a process use items in a group only if
the process's own signed entitlements list it. Tested on the M5 with the real Developer ID:

- A command-line `sf-keys` signed with `keychain-access-groups` is killed at launch. On macOS that
  entitlement is restricted: AMFI allows it only when an embedded provisioning profile for the
  binary's App ID authorises it, and a bare executable can't carry a profile.
- Without the entitlement the Secure Enclave refuses to make a permanent key (`-34018`,
  `errSecMissingEntitlement`).

So signed builds today fall back to a software key, and the engine refuses software keys for gate
decisions (`DESKTOP_ALLOW_SOFTWARE_KEYS` stays empty in production). On 2026-11-12 the owner chose to
keep gate approvals on the desktop with Touch ID, so the helper has to be made to work.

## Decision
1. **The helper becomes a small app bundle**, `SF Keys.app`, with bundle id
   `com.software-factory.desktop.keys` (a child of the app's `com.software-factory.desktop`). It
   has no UI of its own (`LSUIElement`), and the app runs its executable directly, as it runs
   `sf-keys` today. **It sits at `Contents/Helpers/SF Keys.app`**, the standard place for nested
   code: Apple's bundle layout puts helper apps there and expects `Contents/Resources` to hold no
   code (codesign seals nested code elsewhere as a resource, which is fragile). The one condition is that Electrobun's build leaves the helper's signature,
   entitlements and embedded profile alone there. Electrobun signs, notarizes and packages inside
   one `electrobun build`, and probably signs nested Mach-O files itself, so the first build PR is a
   spike (spec 40 M4b, "Build") that tries `Contents/Helpers` and `Contents/Resources` at each of
   Electrobun's hooks and reports which one survives into the notarized app, the download zip and
   the update archive. The helper goes where Electrobun leaves it alone, `Contents/Helpers`
   if both do, and the result is recorded here as a dated amendment, with why.
2. **It has its own explicit App ID and a Developer ID provisioning profile**, made by the owner in
   the Apple Developer portal for the same team and the same Developer ID Application certificate
   that signs the app. No capability is ticked on the App ID: the team's own
   `<TeamID>.com.software-factory.desktop.keys` access group is authorised by the profile's
   application identifier, not by a portal capability. The profile is embedded as
   `Contents/embedded.provisionprofile` and comes from the release environment's
   `MACOS_KEYS_PROFILE` secret (base64).
3. **Only the helper is signed with the access group.** Its entitlements are exactly
   `com.apple.application-identifier` and `keychain-access-groups` (both
   `<TeamID>.com.software-factory.desktop.keys`) and `com.apple.developer.team-identifier`, under the
   hardened runtime with library validation, and nothing else (no JIT, no
   `disable-library-validation`). The app's own entitlements stay JIT-only: no access group.
4. **The key is unchanged in kind**: a P-256 Secure Enclave key, `.privateKeyUsage` and
   `.userPresence` (as ADR 0391 decided: Touch ID, or the login password as a fallback), with no
   LocalAuthentication reuse window. It is made, found and deleted in the data-protection keychain
   (`kSecUseDataProtectionKeychain`) under that access group.
5. **The helper still signs only a presence message** (nonce, op, input digest, summary) and builds
   the prompt from the message's own summary line. It takes no prompt text from its caller.
6. **Without the profile, the release ships without the helper**, as before M4b (a software key, no
   gate decisions from the desktop), and says so in a notice; the CI steps that need
   `MACOS_KEYS_PROFILE` skip cleanly. With it, a release that fails any helper check fails: it
   never ships a helper that macOS would kill or that can't decide. Unsigned dev builds keep the
   software key and say so (`keyStorage: "software"`).
7. **The helper's surface is small.** Four commands (`create`, `public`, `sign`, `delete`), a tag
   from a compiled-in allowlist (the device key and a test tag), and the rule that **the key signs
   presence messages only**. Distinct exit codes for cancelled, no key, refused message and
   authentication failed; the app kills it when the 60 s challenge expires and it calls
   `LAContext.invalidate()` on `SIGTERM`; one prompt at a time.

## Why the app's `bun` running any script doesn't defeat this
- **Using the key needs the entitlement, not the app's signature.** `securityd` checks the
  *calling process's* entitlements for the access group. The app's `bun`, and any script it runs,
  carries the app's entitlements, which name no access group, so a lookup of the key from it finds
  nothing (`-34018` or not found). A script can't add the entitlement to a binary without re-signing
  it, which breaks the Developer ID signature the profile is bound to, and macOS then kills that
  binary at launch.
- **The helper can't be borrowed from inside.** Hardened runtime with library validation refuses
  `DYLD_INSERT_LIBRARIES` and unsigned libraries, and the helper takes no code, plug-ins or
  arguments beyond a tag and a presence message.
- **Running the helper itself is allowed, and is the case ADR 0391 already covers.** A same-user
  process can run `SF Keys.app` with a presence message for a call of its choosing. The engine
  wrote that message's summary and refuses a signature over any other, the prompt names that call
  truthfully, and nothing is signed until a person touches the sensor (or types the password). No
  reuse window means one prompt, one signature. **An unexpected Touch ID prompt is a reason to stop,
  not to approve.**
- **The prompt's policy is in the chip.** The key's access control (`.userPresence`) is fixed when
  the key is made, inside the Secure Enclave; no caller can relax it later.

## Consequences
- **The owner has steps to take by hand** (spec 40 M4b, "Owner steps"): register the App ID, make the
  profile against the right certificate, store it as `MACOS_KEYS_PROFILE`, and redo the profile when
  the Developer ID certificate is renewed or revoked, or the helper stops launching and the app falls
  back to a software key (and gate decisions stop working from the desktop).
- **A new key is a new device.** Macs signed in with a software key on an earlier signed build sign
  in again once: signing out revokes the software-key device, and the sign-in registers the Secure
  Enclave key as a new one.
- **The server still can't tell** a Secure Enclave key from a software one (no attestation on
  macOS); the app declares where its key lives, as before. What changes is that a signed build can
  now truthfully declare `secure-enclave`.
- **Moving to the Secure Enclave key can be phished.** The key-storage marker sits in the app's
  keychain, which a same-user agent can write: it can flip it, make the "sign in again" banner
  appear and race its own `desktop.authStart`. The app shows the new key's fingerprint and the
  website's approval page shows the requested key's, and the person approves only when they match.
- **A downgrade orphans the key.** An older build can't reach the Secure Enclave key, signs in again
  with a software key, and leaves the old key in the keychain, unused.
- **It all assumes System Integrity Protection is on.** With SIP off, the profile and entitlement
  checks that keep the key to the helper can be bypassed by an admin.
- `DESKTOP_ALLOW_SOFTWARE_KEYS` stays empty in production. This ADR doesn't change which keys may
  decide.

## Amendment, 2026-11-13: where and when the helper is signed (the spike)
Tried with the real Developer ID and the `SF Keys Developer ID` profile, on a signed `electrobun
build` (Electrobun 2.0.6):
- **Electrobun re-signs nested bundles wherever they are.** A helper placed in `postBuild` (the
  only hook before Electrobun signs) at `Contents/Helpers/SF Keys.app` *and* at
  `Contents/Resources/SF Keys.app` came out signed with the app's entitlements (JIT,
  unsigned-executable-memory and `disable-library-validation`), without its access group. The
  profile stayed but authorised nothing. Neither place survives, so `Resources` buys nothing.
- **`postWrap` is too late**: by then the app is already in the update archive (`.app.tar.zst`),
  and what it wraps is the self-extractor we don't ship.
- **So the helper goes in at `postPackage`** (`apps/desktop/scripts/keys-helper.ts`), the spec's
  third route: unpack Electrobun's archive, put the helper at `Contents/Helpers/SF Keys.app`, sign
  it with its own entitlements, re-sign the app's outer seal (main executable and seal only, no
  `--deep`, with the entitlements Electrobun used), run the helper once (the launch smoke test),
  notarize and staple again ourselves, then tar and compress as Electrobun does and rewrite the
  `-update-v2.json` manifest's `tarSha256`/`tarSize`. The first-install zip is made from that
  archive, as before. **Delta patches are off** on releases with the helper
  (`release.generatePatch`): Electrobun diffs against its own archive, which this replaces.
- Locally (signed, not notarized) the rebuilt app and the zip both pass `codesign --verify --deep
  --strict`; the helper keeps its identifier, Team ID, secure timestamp, hardened runtime, its three
  entitlements and the byte-identical profile, and launches and reports the access group. The same
  helper without its profile is killed at launch (exit 137), which is what the smoke test catches.
  Notarization, `spctl --assess` and the stapled ticket are proved on the first release run with
  `MACOS_KEYS_PROFILE` (the `release` environment only runs on main).

