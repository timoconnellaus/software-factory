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

> Amended 2026-11-11 (review decisions, [`docs/reviews/2026-11-11-review-decisions.md`](../reviews/2026-11-11-review-decisions.md)): **LLM triage decides** whether the spec stage is skipped (the review's deterministic
> rule was not adopted), and **every skip is logged with its reason** in the audit journal and shown
> on the work item. This resolves the open question: "small" is the triage judgement, bounded by the
> autonomy policy's threshold. A Jev prompt-injection check on intake text before triage is a
> follow-up ([ADR 0047](0047-jev-injection-check-follow-up.md)). See the foreman's decisions in
> [ADR 0005](0005-hybrid-coordinator.md).

> Amended 2026-11-11 (planning interview, [`.kim/plans/2026-11-11-factory-planning.md`](../../.kim/plans/2026-11-11-factory-planning.md)): triage also scores **readiness** (ready / needs answers / not actionable) and can ask questions; a deterministic readiness pre-check runs first, and unactionable items are parked as `needs_info` ([ADR 0264](0264-triage-scores-readiness-and-can-ask.md)).
