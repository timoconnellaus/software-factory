# ADR 0120: Auth, orgs and multiple signed-in accounts

- **Status:** Proposed (from the `spikes/auth-multisession` spike)
- **Date:** 2026-11-11

## Context

The product plan makes the factory multi-user: users belong to orgs, orgs own factories, factories
own projects, and every user has a Personal org. One person often has a personal and a work
identity and wants one "All factories" view across both, without permissions ever mixing. Sign-in
is GitHub + passkeys. The control plane is Cloudflare Workers + D1, like the CRM, whose auth is
Better Auth 1.7.x on D1.

## Decision

1. **Better Auth 1.7.x on D1** (same version as the CRM), D1 passed straight in, with the
   `organization`, `multi-session` and `passkey` plugins. Sign-in: GitHub (with
   `prompt: "select_account"`, account linking off) and passkeys. Email + password only in
   local dev and tests.
2. **Hierarchy:** user → org (Better Auth `member` with role) → factory → project. Factory and
   project rows carry `organizationId` / `factoryId`; nothing below the org has its own ACL yet.
3. **Personal org:** created for every user from the user `create.after` hook, as one D1 batch
   (org + owner membership) with a deterministic id and `INSERT OR IGNORE`, re-run on read so a
   failed write heals itself. The org's `kind` column is `personal` and can't be set by clients;
   the `personal-` slug prefix is reserved.
4. **Factory permissions** are org access-control statements (`factory`, `project`) next to Better
   Auth's own, checked with `hasPermission`. Later, the operations gate (the CRM's `invoke()`
   pipeline) calls this for the human actor.
5. **Accounts on a device = Better Auth device sessions.** The server builds an **account
   session** per account (headers carrying only that account's signed token) from the verified
   `_multi-` cookies.
6. **Cross-account reads** run once per account session and are merged; every org (and, later,
   every work item) is tagged with the account it was read under.
7. **Every action names its account** (`accountUserId`) and runs under that account session only:
   401 if that account isn't signed in on this device, 403 if it lacks the permission. The active
   session is never a fallback. The Better Auth client is used only for sign-in, switching the
   active account and other active-account actions (e.g. adding a passkey).
8. **Session tokens stay server-side.** Our API exposes user ids, never tokens. Don't add the
   `bearer` plugin to the browser-facing auth without revisiting this.
9. **The schema is generated** with `getMigrations()` and committed as a D1 migration; a test
   asserts the committed schema matches the config.

## Consequences

- One browser holds up to 5 accounts (Better Auth's default). Past that, a new sign-in is not
  kept as a device session, silently, so the UI must stop offering "Add another account" at 5.
- The account-session trick relies on the multi-session cookie format. Better Auth is pinned, and
  the spike's tests cover it; re-run them on every Better Auth upgrade.
- D1 has no interactive transactions, so anything written alongside a Better Auth row goes in a
  D1 batch and must be idempotent.
- Each account's active org is separate (it lives on the session). Views that span accounts pass
  `organizationId` explicitly and never rely on the active org.
- Repo access stays separate: a GitHub App per org (gatekeeper), never user login tokens.

## Open

- Table naming: Better Auth defaults vs the CRM's `core_*` + snake_case.
- Whether a Personal org can ever take members.
- Whether production needs a sign-in method besides GitHub and passkeys.
