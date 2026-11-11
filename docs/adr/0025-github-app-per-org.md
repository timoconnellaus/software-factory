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
