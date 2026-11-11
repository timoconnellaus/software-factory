# Spec 10 (R1): Sign-in and the org & account switcher

Read first: [`docs/ui-plan.md`](../ui-plan.md), ADRs [0024](../adr/0024-identity-orgs-and-multi-session.md),
[0031](../adr/0031-dashboard-stack-and-inbox-first.md), [0043](../adr/0043-a-client-is-its-own-org.md);
spike ADR 0120 (`spikes/auth-multisession/docs/`); mockup
[`org-switcher.html`](../../.kim/mockups/org-switcher.html); design system
[`.kim/design-system/`](../../.kim/design-system/).

> Amended 2026-11-11 ([review decisions](../reviews/2026-11-11-review-decisions.md)): R1 keeps orgs and multi-session but is built in three
> milestones (see [README](README.md)). This spec's acceptance criteria are split by milestone.
> Tables are CRM style (`core_*`) with Better Auth mapped onto them. A client is its own org.

## Goal
A person signs in, lands in the app shell, and can see and switch between every org across every
account signed in on this browser.

## Scope
- **(a)** `apps/app` becomes TanStack Start + shadcn/ui on Workers (Cloudflare Vite plugin). Sidebar
  app shell from the mockups; theme follows the system.
- **(a)** Better Auth on D1, tables mapped to `core_*`. Sign-in with GitHub and passkeys. Every new
  user gets a **Personal** org automatically. The signed-in principal is the `human` actor for
  `invoke()`.
- **(a)** Hierarchy: user → org → factories → projects (tables and operations; projects can be stubs).
- **(b)** The organization and multi-session plugins. Sidebar top: the org & account switcher. "All
  factories" (default) plus each account → org → factories, with waiting counts. "Add another
  account", "Create organisation", "Manage signed-in accounts".
- **(b)** Server: enumerate device sessions, list orgs per session, merge into one view. Every item
  is tagged with its account and org.
- **(c)** Guests: a person invited to answer questions on one work item signs in and sees only the
  clarification view of their questions (ADR 0042), nothing else in the org.

## Out of scope
Org settings and team view (R3), invitations UI beyond what Better Auth gives, the GitHub App install
flow (spec 04).

## Acceptance criteria
**Milestone (a): one user, one repo**
1. Signing in with GitHub, or with a passkey, shows the app shell; signing out returns to sign-in.
2. A new user has exactly one org, named Personal.
3. Auth secrets are env-only; no session or provider secret is in D1 config or the repo.
4. Light and dark both follow the system setting.

**Milestone (b): orgs and multi-session**
5. With two accounts signed in, "All factories" lists orgs from both, each tagged with its account.
6. An action on an item runs under that item's own session: a test where account A tries to act on
   account B's org through A's session is refused.
7. The switcher matches the mockup's structure and works with the keyboard.

**Milestone (c): domains, clarification, shared runners**
8. A guest sees only their own questions and the mockups shared with them; any other URL in the org
   is a not-found page.
