# ADR 0372: The website shrinks to auth, links go through a trampoline

Status: accepted, 2026-11-12. Spec [30](../specs/30-desktop-app.md). Amends
[ADR 0240](0240-v1-app-sign-in-and-server-functions.md) and [0241](0241-app-runs-next-to-d1-and-loads-pages-in-one-request.md).

## Context
With the desktop app as the daily UI ([ADR 0370](0370-the-desktop-app-is-the-daily-ui.md)), sf-app
would be a second front end to keep in step. Some flows still need a browser: OAuth sign-in, the
GitHub App install redirect, approving device logins, and links that arrive from outside the app
(GitHub checks, PR comments, email, a phone).

## Decision
1. **sf-app keeps only:**
   - sign-in, sign-out and the account;
   - Connect GitHub (the install flow and its callbacks);
   - the device-login approval pages (`/runners/connect`, `/cli/connect`, `/desktop/connect`);
   - device management (list and revoke desktop devices and CLI tokens);
   - the trampoline.
2. **The trampoline:** `/open/<path>` (for example `/open/work/123`, `/open/attach?repo=…&pr=…`)
   tries `sf://<path>`. If the app isn't installed, it offers "Get the app" and a sign-in. The
   `factory/verify` check, PR comments and notifications link to it.
3. **The screens move to `apps/desktop`:** inbox, work items, planning, review packet, Setup's
   checklist, runners. They move only once the desktop has them (spec 30 M3). The strip-down
   (M5) is its own PR.

## Consequences
- Approving a gate from a phone isn't possible while the website is auth-only. If that's missed, a
  phone path would need its own presence proof (WebAuthn), not the old browser rule.
- ADR 0241's page-load design stays relevant for the desktop's batched reads (`batch` on the client
  door), not for sf-app.
