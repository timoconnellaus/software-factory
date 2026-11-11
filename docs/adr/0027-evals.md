# ADR 0027: Evals

Status: accepted, 2026-11-11 (from the product plan, `.kim/plans/2026-11-10-personal-software-factory-design.md`).

## Context
Changing a preset, prompt or model role should be measured, not guessed. Relationship OS keeps
`evals/` with recordings and dated reports.

## Decision
- `evals/` holds eval suites with recordings, replay and dated reports.
- Evals benchmark factory configs (Warp's "benchmarks"): the same work items run under different
  presets, roles or harnesses.

## Consequences
- Self-improvement PRs ([ADR 0009](0009-factory-config-in-git.md)) can cite eval results.
