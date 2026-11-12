# ADR 0390: The desktop app is the daily UI and the runner's supervisor

Status: accepted, 2026-11-12. Spec [40](../specs/40-desktop-app.md). Promotes the spike's proposed
ADR 0130 ([`spikes/electrobun`](../../spikes/electrobun/README.md)). Plan:
[`.kim/plans/2026-11-11-software-factory-desktop-app-electrobun.md`](../../.kim/plans/2026-11-11-software-factory-desktop-app-electrobun.md).

## Context
The factory has two things on a person's Mac: a browser tab on sf-app, and `sf-runner` under
launchd. People step in only at gates, so what they need from the factory is to be told when a gate
is waiting and to have the runner stay up. A browser tab does neither well. The owner chose a
native app that replaces both for day-to-day use, with the website kept for auth.

## Decision
1. **`apps/desktop` is a macOS (Apple Silicon) app on Electrobun 2.x.**
   - Bun runs the main process. Hutch, Electrobun's toolchain, builds the bundle; pnpm still owns
     the dependencies, and Vite builds the view.
   - The view is a TanStack Router (hash history) + Query SPA on `packages/ui`, bundled in the app.
     It does not load sf-app.
   - The view holds no token. It asks the main process over Electrobun RPC, and the main process
     calls the factory.
2. **It supervises the runner.**
   - `sf-runner` runs as a child on a pinned Node 24 bundled in the app, never under Bun, with a
     scrubbed environment.
   - It is restarted with backoff, survives the window closing, and stops when the app quits.
   - The app holds a single-instance lock, and `sf-runner` holds a host lock, so a second or
     orphaned host can't run under the same runner identity. The spike showed that killing the
     launcher orphans both processes.
   - On first run the app offers to take over a launchd `sf-runner`, keeping its identity.
     `sf-runner install` stays for headless Macs.
3. **It is native where that matters:**
   - a menu-bar icon (runner state, inbox count) and a dock badge;
   - notifications when a gate opens;
   - launch at login;
   - `sf://` deep links, routed into the SPA, including a link that launched the app.
4. **Distribution:**
   - Developer ID signed and notarized.
   - Built by GitHub Actions on a macOS runner, with the certificate and notarization key in Actions
     secrets.
   - Served from a public R2 bucket on a custom domain.
   - A canary channel on every merge that touches the app; stable on a tag.
5. **Code asks for operations, never tables.** The app is one more surface on the client door
   ([ADR 0391](0391-the-client-door-desktop-devices-and-presence.md)).

## Consequences
- The app is about 200 MB installed (Node about 116 MB, Bun about 85 MB). Updates are about 60 MB
  compressed, less with Electrobun's diffs.
- Electrobun 2.0.6 has gaps that the app fills itself:
  - the dock badge, through Objective-C FFI (done in the spike);
  - the login item (`SMAppService`);
  - notification click-through;
  - the Secure Enclave and LocalAuthentication.
- Canary/stable builds self-extract on first launch. Notarization is checked on the extracted bundle.
- Hutch installs to `~/.hutch` and edits the shell profile. CI caches it.

## Amended 2026-11-12 (spec 40 M4 review)
- **Stable is not on a tag.** A tag-triggered workflow runs the tagged commit's own workflow file,
  so anyone able to push a tag could run it with the signing material. Stable is a manual run of
  the release workflow on `main`, refused until the owner has locked the `release` environment
  down (main only, a required reviewer, no admin bypass, a `v*` tag ruleset) and set
  `DESKTOP_STABLE_ENABLED`. Until then only canary ships.
- **The app checks updates itself.** Electrobun's updater trusts the bucket, so the app refuses a
  version that isn't higher than its own, and a staged bundle that isn't signed by its own Team ID
  (read from its own signature) or that Gatekeeper rejects. The upload uses an R2 token scoped to
  the bucket and held only by the `release` environment.
- **The download is the plain app**, not the self-extracting wrapper (the consequence above about
  self-extraction no longer holds).
