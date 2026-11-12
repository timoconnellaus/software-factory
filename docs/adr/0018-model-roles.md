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

> Amended 2026-11-11 (V1 core + engine): V1 roles are `triage`, `implement`, `review`, `summarise`
> (the foreman and spec stages run as `triage`). The default map is `packages/core/src/model-roles.ts`,
> the only source file allowed to name a model (a guard test enforces it); a project overrides it in
> `.factory/policy.json` `modelRoles` ([ADR 0054](0054-factory-policy-file.md)). Jobs name the role and
> carry the resolved model for the harness.

> Amended 2026-11-12 ([ADR 0352](0352-agents-are-harness-neutral.md), spec 08 M2): the open question is answered. Roles get a tier (`standard` | `light`). Defaults stay in `model-roles.ts`; the project states preferences in its config version; a runner owner's caps win. The run records the model it actually used.
