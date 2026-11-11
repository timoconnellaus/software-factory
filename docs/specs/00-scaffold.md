# Spec 00: Scaffold

Read first: [`AGENTS.md`](../../AGENTS.md), [`CONTEXT.md`](../../CONTEXT.md),
[`docs/architecture.md`](../architecture.md), ADRs [0002](../adr/0002-cloudflare-control-plane.md),
[0019](../adr/0019-repo-shape-and-tooling.md).

> Amended 2026-11-11 ([review decisions](../reviews/2026-11-11-review-decisions.md)): `packages/gatekeeper-webhook` is now
> `packages/connector-webhook` (ADR 0010) and `docs/stages/` is now `docs/specs/`. This spec is done.

## Goal
An empty but building monorepo in the plan's repo shape, plus the repo practice documents, so every
later spec only adds features.

## Scope
- pnpm workspace + Turborepo + Biome + strict TypeScript; Node 24 pinned (`.nvmrc`, `packageManager`).
- `packages/config`: shared `tsconfig`, Biome preset, Vitest preset (workerd).
- Placeholders with a stub `index.ts`, a typecheck and one trivial test: `apps/app` (`sf-app`),
  `apps/engine` (`sf-engine`), `packages/{core, db, sdk, runner-contract, harness-claude,
  gatekeeper-webhook}`, `local/runner-host`, `presets`, `evals`.
- `spikes/**` excluded from the workspace and from Biome.
- `AGENTS.md`, `CLAUDE.md`, `CONTEXT.md`, ADRs 0001–0032, specs, `docs/parallel-work.md`,
  `docs/handoff.md`.

## Out of scope
Any feature: operations, D1 schema, auth, TanStack Start, runners. `packages/runner-orca` (added
when the runner spike lands). CI workflows and deploy scripts.

## Acceptance criteria
1. `pnpm i && pnpm lint && pnpm typecheck && pnpm test` passes on a clean checkout.
2. Every workspace package has a stub index, a `typecheck` script and one passing test.
3. Worker packages run tests in workerd; `local/*`, `presets` and `evals` run them in Node.
4. A file under `spikes/` is neither linted nor a workspace member.
5. No account IDs or secrets are committed.
