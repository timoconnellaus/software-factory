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

> Amended 2026-11-11 (review decisions, [`docs/reviews/2026-11-11-review-decisions.md`](../reviews/2026-11-11-review-decisions.md)): the core object is now the **Question**, and interview sessions (planning,
> clarification, design review, decision) are **views** over questions
> ([ADR 0042](0042-one-question-object.md)). Reversible choices become assumptions instead of
> questions. On approval the living spec is committed to `docs/specs/NN-*.md` **on the work item's
> branch**, never directly to main. Clarification sessions stay in R1, in its third milestone.

> Amended 2026-11-11 (planning interview, [`.kim/plans/2026-11-11-factory-planning.md`](../../.kim/plans/2026-11-11-factory-planning.md)): planning is now a **live agent session on a runner**, modelled on kim (a factory-native rewrite, no shared code). The agent manages questions and the living spec through operations, hooks bring answers back while it works, and live and async are one mechanism ([ADR 0260](0260-planning-is-a-live-session-on-a-runner.md)). Specs carry provenance, coverage and a critic's notes ([ADR 0262](0262-spec-provenance-coverage-and-critic.md)). Mockups and system designs are stored in the factory and kept in `.kim/` ([ADR 0265](0265-planning-artifacts-and-the-kim-folder.md)). A session can split its work item ([ADR 0263](0263-a-planning-session-can-split-a-work-item.md)). V1's fixed question rounds are retired.
