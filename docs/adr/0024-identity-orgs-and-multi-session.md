# ADR 0024: Identity, orgs and multi-session

Status: accepted, 2026-11-11 (from the product plan, `.kim/plans/2026-11-10-personal-software-factory-design.md`).

## Context
One person may hold a personal account and a work account; a team shares factories. Relationship OS
uses Better Auth on D1.

## Decision
- Better Auth (`better-auth` 1.7.x) on D1, with the **organization** plugin (orgs, members, roles,
  invitations) and the **multi-session** plugin.
- Sign-in with GitHub and passkeys.
- Hierarchy: user → org → factories → projects. Every user gets a Personal org.
- "All factories" view: the server enumerates device sessions, lists orgs and work per session and
  merges them. Each item is tagged with its account and org, and actions run under that item's own
  session, so permissions never mix.
- Approvers are set per project in `.factory/`.

## Consequences
- Auth secrets are env-only.

> Amended 2026-11-11 (review decisions, [`docs/reviews/2026-11-11-review-decisions.md`](../reviews/2026-11-11-review-decisions.md)): R1 keeps orgs and multi-session; they are R1's second internal milestone, after the
> core loop works for one user and one repo ([ADR 0031](0031-dashboard-stack-and-inbox-first.md)).
> Tables are CRM style (`core_*`, snake_case) with Better Auth mapped onto them. Spike ADR 0120
> (`spikes/auth-multisession/docs/`) has the mechanics. A client is its own org
> ([ADR 0043](0043-a-client-is-its-own-org.md)).
