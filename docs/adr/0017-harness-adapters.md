# ADR 0017: Harness adapters

Status: accepted, 2026-11-11 (from the product plan, `.kim/plans/2026-11-10-personal-software-factory-design.md`).

## Context
A runner starts an agent CLI inside a workspace. Agent CLIs differ in hooks, output formats and features.

## Decision
- A **harness** adapter per agent CLI, with a capability manifest (`packages/harness-claude` first).
- v1 supports Claude Code only. Codex, pi and OpenCode come later.
- Billing is not the factory's concern: a runner uses whatever agents and credentials its owner has set up.

## Consequences
- The factory never stores model provider keys or subscriptions.
- Rules that need two harnesses (an independent reviewer, [ADR 0018](0018-model-roles.md)) only warn until a second harness exists.
