# ADR 0032: Scope and isolation

Status: accepted, 2026-11-11 (from the product plan, `.kim/plans/2026-11-10-personal-software-factory-design.md`).

## Context
The factory serves side projects, client repos, greenfield builds, maintenance and content.

## Decision
- Pipelines are configurable per project, so content work can skip code stages.
- Each client is isolated in its own factory or project, with its own config, runner limits and approvers.

## Consequences
- Client repos can be restricted to their owner's hardware ([ADR 0015](0015-scheduler-runtime-pool-and-capabilities.md)).
- Open question: whether a client gets its own org or a factory inside the owner's org.

> Amended 2026-11-11 (review decisions, [`docs/reviews/2026-11-11-review-decisions.md`](../reviews/2026-11-11-review-decisions.md)): **a client is its own org** ([ADR 0043](0043-a-client-is-its-own-org.md)), which resolves
> the open question. **Content is cut from v1** ([ADR 0046](0046-content-cut-from-v1.md)), so
> pipelines are code pipelines for now.
