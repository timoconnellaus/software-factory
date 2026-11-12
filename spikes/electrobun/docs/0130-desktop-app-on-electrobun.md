# 0130. The desktop app on Electrobun

Status: promoted to [ADR 0390](../../../docs/adr/0390-the-desktop-app-is-the-daily-ui.md) and [0391](../../../docs/adr/0391-the-client-door-desktop-devices-and-presence.md), 2026-11-12
Date: 2026-11-12

## Context
The [desktop app plan](../../../.kim/plans/2026-11-11-software-factory-desktop-app-electrobun.md)
makes a macOS app the day-to-day factory UI and the supervisor for the Mac's runner, and shrinks
sf-app to auth. It allows gate decisions in the app **with only the signed-in token**, on the basis
that the token lives in the Keychain where only the signed app can read it. The spike checked this
on Electrobun 2.0.6.

## Decision
1. **Build the app on Electrobun 2.x with Hutch.** `apps/desktop` keeps pnpm for dependencies and Vite
   for the view; Hutch fetches the Electrobun devkit and builds the bundle. The main process is Bun.
   The view is a TanStack Router (hash history) + Query SPA on `packages/ui`.
2. **The runner is a supervised child on a bundled, pinned Node 24** running the bundled `sf-runner`,
   with a scrubbed environment. The app takes a single-instance lock, and `sf-runner` takes a lock of its
   own so that an orphaned or second host can't run alongside it.
3. **The `desktop` token is not proof of a person.** The Keychain trusts the app's `bun`, which runs any
   script it is given, so any process of the same user can use the token. The token may carry the
   desktop surface's ordinary operations (the same as the CLI's, plus live updates). **Gate decisions
   (`spec.approve`, `pr.merge`, answering a gate) need a presence proof:** a per-device Secure Enclave
   key created with `.userPresence` (Touch ID, or the password as fallback), held by a small signed
   native helper. It signs a server challenge bound to the decision (operation, work item, head SHA).
   `invoke()` accepts a gate decision on the `desktop` surface only with a valid signature from a
   registered, unrevoked device key. The browser-only rule is amended to "browser, or desktop with
   presence".
4. Deep links use an https trampoline on the website and `sf://` in the app; Bun holds a link that
   arrived before the view was ready.

## Consequences
- This **reverses the interview's "token only, no per-decision prompt"** answer. That answer rested on a
  Keychain guarantee that doesn't hold. It needs the owner's sign-off before the spec.
  Alternatives:
  - (a) accept that any local process can approve and merge, which breaks "merge always goes to a human";
  - (b) open the website for each gate decision.
- Touch ID can be made lighter with a short reuse window (LocalAuthentication allows up to 5 minutes)
  for a batch of approvals. The window has to be per device and visible in the audit trail.
- Electrobun gaps to fill ourselves: dock badge (ObjC FFI, done in the spike), login item
  (`SMAppService`), notification click-through (none in 2.0.6), Secure Enclave and LocalAuthentication
  (a native helper or FFI).
- Hutch writes to `~/.hutch` and the shell profile, and CI needs it on a macOS runner.
- The app is about 200 MB installed (Node 116 MB + Bun 85 MB), with a 61 MB update archive.
  Canary/stable builds self-extract on first launch, and notarization has to be checked against that.
