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
