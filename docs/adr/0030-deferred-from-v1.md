# ADR 0030: Deferred from v1

Status: accepted, 2026-11-11 (from the product plan, `.kim/plans/2026-11-10-personal-software-factory-design.md`).

## Context
Relationship OS and Cloudflare OS contain more machinery than one person or a small team needs now.

## Decision
Deferred, designed for but not built in v1:
- Simulation overlays (a git branch already is a simulation).
- The auto-approver, an adjudicator that can approve but never reject, run in shadow mode until it
  reaches at least 0.95 precision, and never for merge, deploy or self-modify (Relationship OS ADR 0031).
  v1 logs gate decisions now so it can be calibrated later.
- Per-item grants and capability introduction (agents requesting more repos or services).
- Extensions: `defineStage`, `defineAgentProfile`, quarantine after repeated failures.

Out of scope as overkill: multi-tenant control and Workers for Platforms, the Dynamic Worker
extension runtime and schema reconciler, full Cloudflare OS OAuth connect flows, identity adapters and
erasure machinery, signed release bundles and the installer CLI.

## Consequences
- Revisit each item with its own ADR when it is picked up.
