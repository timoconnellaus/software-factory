# Software factory desktop app (Electrobun)

## Goal
A native macOS app built with [Electrobun](https://electrobun.dev/) that becomes **the** day-to-day factory UI and the supervisor for this Mac's runner. The website (sf-app) shrinks to sign-in and auth flows.

## Decisions

### What it is
- **One app:** the factory UI plus a supervised runner host. One install pairs the machine and keeps the runner alive.
- **Website is auth-only.** It keeps sign-in/out and account, Connect GitHub (App install and callbacks), the device-login approval pages (sf-runner, sf CLI), and an https trampoline (e.g. `/open/work/123`) that opens `sf://…` in the app, with "Get the app" and sign-in fallbacks. factory/verify, PR comments and emails link to the trampoline.
- **Screens move** from `apps/app` into `apps/desktop` as a TanStack Router SPA + TanStack Query on `packages/ui`, bundled in the app. Then `apps/app` is stripped down to auth.
- **Platform:** macOS, Apple Silicon only. **Code:** `apps/desktop` in the monorepo; Bun for the Electrobun main process only, Node 24 everywhere else; its own Turborepo/CI job.

### Auth and API
- **Sign-in:** browser sign-in on the website → `sf://` deep link with a one-time code (PKCE) → the app exchanges it for a **desktop token**.
- **API:** generalise sf-engine's `/cli/v1` into one client door for the CLI, the desktop and later MCP, with a new `desktop` surface. Reads are batched like `callReads` (ADR 0241). Add a version handshake that can reply "update required".
- **Gate decisions in the app with the token alone** (no per-decision prompt). The safeguards:
  - The desktop token is its own kind. It lives **only in the Keychain, readable only by the app's code signature**, and is never written to disk or env.
  - Only that token kind can use the `desktop` surface. CLI tokens stay refused for gates.
  - Every decision records the **device** in the audit trail, and devices can be **revoked from the website**.
  - Needs an ADR amending the browser-only gate rule. "Merge, deploy and self-modify always go to a human" still holds, with the person now identified through the device rather than the browser.

### Native
- Menu-bar icon (runner status + inbox count), notifications at gates, launch at login, `sf://` deep links, auto-update, dock badge.
- **Live updates:** a WebSocket from the app to a Durable Object on sf-engine (like the PlanningHub). On reconnect it catches up from `inbox.list`.

### Runner
- The app starts the existing **sf-runner as a supervised child process** on a **pinned Node 24 bundled in the .app** and signed with it.
- On first run it detects a launchd sf-runner and **offers to take over**: it unloads the plist and keeps the runner's identity and credentials. `sf-runner install` stays for headless Macs.

### Distribution
- Signed with a Developer ID and notarized. **GitHub Actions on a macOS runner** builds and signs, with secrets in Actions, and uploads to a **public R2 bucket on a custom domain**.
- **Channels:** canary on every merge to main that touches the app or its dependencies; stable on a tag.
- No certs, team IDs or account IDs in the public repo.

## Build order
1. **Spike** `spikes/electrobun`. It must prove:
   - Electrobun builds inside pnpm/Turborepo, with Bun only for the app.
   - A bundled Node 24 sf-runner child starts, is supervised and restarted, and survives the window closing.
   - The `sf://` scheme and the deep-link sign-in callback work.
   - **A Keychain item restricted to the app's signature can't be read from a shell or the Claude sandbox.** This is the most important check, because token-only gates depend on it.
   - Menu-bar icon, notification and dock badge.
   - A TanStack Router SPA from `packages/ui` runs in WKWebView with RPC to Bun.
   - Not in the spike: signing, notarization and updates (left to the CI PR).
2. **Spec** in `docs/specs/`. **ADRs** from a claimed block in `docs/parallel-work.md`: the desktop app; the client door and desktop tokens; the gate-rule amendment; the website shrinking to auth.
3. **PRs:**
   1. Client door + desktop auth + trampoline.
   2. `apps/desktop` shell + runner supervision + menu bar + live socket.
   3. Screens at parity.
   4. Signing/notarization/R2/channels CI.
   5. Strip `apps/app` to auth.

## Open
- Confirm the Developer ID Application certificate exists ("yes I think so").
- Approving gates from a phone is no longer possible while the website is auth-only. Revisit if that's missed.
