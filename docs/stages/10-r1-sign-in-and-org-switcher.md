# Stage 10 (R1): Sign-in and the org & account switcher

Read first: [`docs/ui-plan.md`](../ui-plan.md), ADRs [0024](../adr/0024-identity-orgs-and-multi-session.md),
[0031](../adr/0031-dashboard-stack-and-inbox-first.md); mockup
[`org-switcher.html`](../../.kim/mockups/org-switcher.html); design system
[`.kim/design-system/`](../../.kim/design-system/).

## Goal
A person signs in, lands in the app shell, and can see and switch between every org across every
account signed in on this browser.

## Scope
- `apps/app` becomes TanStack Start + shadcn/ui on Workers (Cloudflare Vite plugin). Sidebar app
  shell from the mockups; theme follows the system.
- Better Auth on D1 with the organization and multi-session plugins. Sign-in with GitHub and
  passkeys.
- Every new user gets a **Personal** org automatically.
- Hierarchy: user → org → factories → projects (tables and operations; projects can be stubs).
- Sidebar top: the org & account switcher. "All factories" (default) plus each account → org →
  factories, with waiting counts. "Add another account", "Create organisation", "Manage signed-in
  accounts".
- Server: enumerate device sessions, list orgs per session, merge into one view. Every item is
  tagged with its account and org.
- The signed-in principal is the `human` actor for `invoke()`.

## Out of scope
Org settings and team view (R3), invitations UI beyond what Better Auth gives, the GitHub App install
flow (stage 4).

## Acceptance criteria
1. Signing in with GitHub, or with a passkey, shows the app shell; signing out returns to sign-in.
2. A new user has exactly one org, named Personal.
3. With two accounts signed in, "All factories" lists orgs from both, each tagged with its account.
4. An action on an item runs under that item's own session: a test where account A tries to act on
   account B's org through A's session is refused.
5. The switcher matches the mockup's structure and works with the keyboard.
6. Auth secrets are env-only; no session or provider secret is in D1 config or the repo.
7. Light and dark both follow the system setting.
