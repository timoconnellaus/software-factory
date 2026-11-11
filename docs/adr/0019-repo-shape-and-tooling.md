# ADR 0019: Repo shape and tooling

Status: accepted, 2026-11-11 (from the product plan, `.kim/plans/2026-11-10-personal-software-factory-design.md`).

## Context
We copy the Relationship OS repo practice (Relationship OS ADR 0013) so agents that know one repo know both.

## Decision
- pnpm workspaces + Turborepo, TypeScript strict, Biome for lint and format, Node 24.
- Vitest in workerd via `@cloudflare/vitest-plugin` for Worker-facing code; plain Vitest for Node packages.
- Layout:
  - `apps/app` (Worker `sf-app`): dashboard, MCP, operations API.
  - `apps/engine` (Worker `sf-engine`): Workflows, queues, cron. Renamed from the CRM's "runner"
    so it is not confused with execution runners.
  - `packages/{config, core, db, sdk, runner-contract, harness-claude, gatekeeper-webhook}`.
  - `local/runner-host`: the generic daemon that loads runner adapters.
  - `presets/`, `evals/`.
- `spikes/` is excluded from the workspace and from Biome. Spikes own their dependencies.

## Consequences
- `packages/runner-orca` is added when the runner-orca spike lands.
- Worker `Env` types come from `wrangler types`, never hand-written.

> Amended 2026-11-11 (review decisions, [`docs/reviews/2026-11-11-review-decisions.md`](../reviews/2026-11-11-review-decisions.md)): `packages/gatekeeper-webhook` is renamed `packages/connector-webhook`
> ([ADR 0010](0010-gatekeepers-for-intake-and-outbound.md)), and the build specs live in
> `docs/specs/` (was `docs/stages/`, which collided with pipeline stages). D1 tables follow the CRM:
> `core_*` snake_case names, with Better Auth's tables mapped onto that scheme.
