# ADR 0013: Triage sizes the spec gate

Status: accepted, 2026-11-11 (from the product plan, `.kim/plans/2026-11-10-personal-software-factory-design.md`).

## Context
Coding before a spec exists wastes runs; requiring a spec for a one-line fix wastes the approver's time.

## Decision
- The triage stage sizes every work item.
- Small, clear work items skip the spec stage.
- Bigger ones get a living spec with acceptance criteria, and the spec gate needs an approver.
- The threshold comes from the project's preset ([ADR 0008](0008-autonomy-presets-and-floor.md)).

## Consequences
- Spec approval is split per decision domain where domains are declared ([ADR 0029](0029-decision-domains.md)).
- Open question: what "small" means concretely (diff size, files touched, or a foreman judgement).
