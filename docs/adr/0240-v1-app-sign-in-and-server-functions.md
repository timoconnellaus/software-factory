# ADR 0240: V1 app: GitHub-only sign-in for one user, and one allowlisted server function to the engine

Status: accepted, 2026-11-11 (V1 step 2, the app).

## Context
V1 has one user and one project ([`v1-scope.md`](../v1-scope.md)). `sf-app` authenticates the person
and calls operations on `sf-engine` over RPC ([ADR 0051](0051-operations-rpc-on-the-engine.md)).
Approvers in `.factory/policy.json` are named by GitHub login, so the login on `core_user` decides
who can merge.

## Decision
- **Sign-in is GitHub only**, through the org's GitHub App as the OAuth client (Better Auth's
  `github` provider). No email/password. Passkeys and the organization and multi-session plugins
  wait for milestone (b) (spec 10).
- **An allowlist gates sign-in**: `ALLOWED_GITHUB_LOGINS` (a var, comma-separated, case-insensitive).
  It is checked when the user row would be created (nobody else gets a row), on every new session,
  and on every request (removing a login locks them out). Empty lets nobody in.
- **`github_login` comes from GitHub only.** It is filled from the GitHub profile on sign-up, and
  Better Auth's `/update-user`, `/change-email` and `/delete-user` endpoints are disabled, so nobody
  can rename themselves into an approver.
- **The Personal org** (`kind = 'personal'`, the user as `owner`) is created by a Better Auth database
  hook on user creation, and again (idempotently) on each session, as Better Auth data in
  `core_organization` / `core_member`. Without the organization plugin, `active_organization_id` is
  unused in V1.
- **One server function forwards operations**, by name, to `EngineApi.invoke` with the actor set from
  the session (`{ type: "human", id }`, origin `app`). It forwards only the operations the dashboard
  uses (`APP_OPERATIONS` in `apps/app/src/lib/ops.ts`); agent, runner and connector operations
  are refused before the engine is called. The engine still enforces actor types and permissions.
- **`policy.sync` is never forwarded from the browser.** Setup's "Sync" is a separate server function
  that reads `.factory/policy.json` itself from GitHub at the default branch's head SHA and records
  that, until the GitHub connector does it on push ([ADR 0036](0036-policy-from-the-default-branch.md)).
  It reads public repos without a token (V1's one project is public).
- **The GitHub App installation id** for a new project is found with the user's own GitHub App user
  token from sign-in (`GET /user/installations`, read-only), so Setup doesn't ask for it.
- **Types, not code, from core.** The app imports operation input/output types from
  `@software-factory/core` (`import type`) so pages are typed against the zod schemas without
  bundling the registry into the browser.

## Consequences
- Adding a second user is a var change; adding orgs and multi-session is milestone (b) work in this app.
- `workItem.get` gained `policy` (autonomy policy, spec threshold, review packet sections),
  `approvers` (with the rule) and `viewer` (`isApprover`, `isRequester`), additively, so the detail
  page and review packet can render the section order and disable what the server would refuse.
- A private project repo needs the policy read through the App (the connector) instead.
