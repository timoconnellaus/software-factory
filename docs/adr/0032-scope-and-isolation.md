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
