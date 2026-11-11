# ADR 0010: Gatekeepers for intake and outbound

Status: accepted, 2026-11-11 (from the product plan, `.kim/plans/2026-11-10-personal-software-factory-design.md`).

## Context
Work comes from GitHub, Linear, Slack, chat/CLI, phone, cron, Sentry and logs, and live local
sessions. Results go back as comments, PRs and replies. Borrowed from the Relationship OS
`gatekeeper-webhook` and the Cloudflare OS gatekeeper concept (Relationship OS ADR 0007).

## Decision
- A **gatekeeper** per source verifies signatures and deduplicates provider events into typed intake
  events, which become work items.
- Outbound actions (GitHub comments, PRs, status replies) are journaled operations keyed by an action
  kind. Some kinds can be marked auto-approvable, such as labelling an issue.
- **Agents never hold raw tokens.** Credentials live in gatekeepers.

## Consequences
- `packages/gatekeeper-webhook` is the first gatekeeper.
- GitHub access goes through the GitHub App per org ([ADR 0025](0025-github-app-per-org.md)).

> Amended 2026-11-11 (review decisions, [`docs/reviews/2026-11-11-review-decisions.md`](../reviews/2026-11-11-review-decisions.md)): **gatekeeper is renamed connector** ("gate", "gatekeeper" and "factory gate" collided).
> `packages/gatekeeper-webhook` is now `packages/connector-webhook`. Everything else in this ADR
> holds for connectors. The GitHub connector also mints the per-job repo tokens runners push with
> ([ADR 0033](0033-per-job-github-app-tokens.md)), so agents still never hold a standing token.
