# ADR 0018: Model roles, not model ids

Status: accepted, 2026-11-11 (from the product plan, `.kim/plans/2026-11-10-personal-software-factory-design.md`).

## Context
Models change monthly. Code and config that name model ids rot. Borrowed from Relationship OS ADR 0009.

## Decision
- Code and config ask for a **model role**: `triage`, `foreman`, `spec`, `implement`, `review`, `summarise`.
- A registry maps each role to a harness and model.
- "The reviewer must be a different model or harness from the implementer" is a setting. The
  factory warns when it is violated.

## Consequences
- Swapping a model is a config change, not a code change.
- Open question: whether the role map lives in the factory repo, `.factory/`, or runner config, given
  that runners own their credentials ([ADR 0017](0017-harness-adapters.md)).
