# ADR 0028: Planning is built in

Status: accepted, 2026-11-11 (from the product plan, `.kim/plans/2026-11-10-personal-software-factory-design.md`).

## Context
Specs are better when written with the approver than for them. The interviewer patterns already work.

## Decision
- **Planning** is native to the factory: questions with defaults and recommendations, a **living spec**,
  mockups and system designs.
- It is used at triage, spec, agent questions, design review and greenfield kickoff.
- It is not an integration with an outside interviewer tool.

## Consequences
- Planning questions are pending actions routed by decision domain ([ADR 0029](0029-decision-domains.md)).
- Open question: planning scope in v1 (the UI plan leaves it open).

> Amended 2026-11-11 (UI interview, `.kim/plans/2026-11-11-software-factory-ui-design.md`): the v1
> scope is settled. Planning is used at the spec stage, for agent questions mid-run, triage
> clarifications, design review, review packet decisions and greenfield kickoff. v1 has questions
> with a default and a recommendation ("accept remaining defaults"), a living spec, adaptive
> follow-ups, per-question chat with the planning agent, mockup option cards and system designs on a
> canvas. **Planning sessions** are the core object, several per work item by type: planning
> (owners, full view), clarification (a guest sees only their questions and shared mockups; answers
> roll up), design review, and decision (a one-off question). The owner delegates questions, never
> the whole feature. On approval the living spec is committed to `docs/stages/NN-*.md`. UI: a
> Planning tab on the work item, inbox cards for single questions, and a full-screen canvas.
