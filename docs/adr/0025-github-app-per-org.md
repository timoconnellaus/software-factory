# ADR 0025: A GitHub App per org

Status: accepted, 2026-11-11 (from the product plan, `.kim/plans/2026-11-10-personal-software-factory-design.md`).

## Context
User login tokens are broad and tied to one person.

## Decision
- Repo access goes through a GitHub App installed per org, held by a gatekeeper ([ADR 0010](0010-gatekeepers-for-intake-and-outbound.md)).
- Never via user login tokens.

## Consequences
- Runners push branches with their owner's git credentials; the factory opens PRs, comments and
  reads checks through the App.
- Open question: whether runners should push via short-lived App tokens instead.

> Amended 2026-11-11 (review decisions, [`docs/reviews/2026-11-11-review-decisions.md`](../reviews/2026-11-11-review-decisions.md)): the open question is resolved: runners push with **per-job, repo-scoped App tokens**,
> never with their owner's git credentials ([ADR 0033](0033-per-job-github-app-tokens.md)). Branch
> protection keeps `enforce_admins` on. The App is held by a **connector** (was gatekeeper).

> Amended 2026-11-11 ([ADR 0055](0055-github-installations-are-org-records.md)): an org's installations are records (`core_github_installations`), connected through GitHub's install flow and kept current by webhooks. A person's own GitHub user token is used once, to prove they may connect an installation on an organization account; it is never stored and never used for repo access.
