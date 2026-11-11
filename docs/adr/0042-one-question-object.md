# ADR 0042: One Question object; interview sessions are views

Status: accepted, 2026-11-11 (review decisions, [`docs/reviews/2026-11-11-review-decisions.md`](../reviews/2026-11-11-review-decisions.md), answering the [design review](../reviews/2026-11-11-design-review.md)).

## Context
[ADR 0028](0028-planning-built-in.md) (amended) made planning sessions the core object, with four
types (planning, clarification, design review, decision). The review found four session types for
what is one thing: a decision someone needs to make.

## Decision
- The core planning object is the **Question**: work item, decision domain, assignee, default,
  recommendation, blocking or not, visibility (who may see it and its context), answer and status.
- An **interview session** is a **view** over questions: the owner's planning view, a guest's
  clarification view (only their questions and shared mockups), a design review, a single decision.
  Sessions hold no state of their own beyond the filter and who it is for.
- **Ask fewer questions**: a reversible choice is recorded as an **assumption** on the spec (visible,
  can be overturned) instead of a question.
- **Bulk accept** ("accept remaining defaults") never covers questions in the security & privacy
  domain or questions marked irreversible; those are answered one by one.
- Each blocking question has a timeout from the autonomy policy. On timeout it goes to the
  **backup owner** (the domain owner's backup, else the project approver); it never auto-accepts.

## Consequences
- Amends ADR 0028's session model and ADR 0029's routing (domains route questions).
- `question.ask`, `question.answer`, `question.delegate` are the operations; sessions are queries.

> Amended 2026-11-11 (planning interview, [`.kim/plans/2026-11-11-factory-planning.md`](../../.kim/plans/2026-11-11-factory-planning.md)): the Question gains `kind` (text, single-choice, multiple-choice, yes-no, number), multi-value defaults, `position`, `revision` and revisable answers, as in kim. The agent adds, edits, reorders and deletes questions freely during a planning session; there are no rounds ([ADR 0260](0260-planning-is-a-live-session-on-a-runner.md)). Bulk accept and escalation are unchanged.
