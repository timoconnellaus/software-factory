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

> Amended 2026-11-11 (planning interview, [`.kim/plans/2026-11-11-factory-planning.md`](../../.kim/plans/2026-11-11-factory-planning.md)): the Question gains `kind` (text, single-choice, multiple-choice, yes-no, number), multi-value defaults, `position`, `revision` and revisable answers, as in kim. The agent adds, edits, reorders and deletes questions freely during a planning session; there are no rounds ([ADR 0300](0300-planning-is-a-live-session-on-a-runner.md)). Bulk accept and escalation are unchanged.

## Amendment, 2026-11-12: planning answers on the desktop need no presence proof
Decided by the owner on 2026-11-12, in his words: "touch id approvals is overkill. We'll assume the
user's computer is secure." Answering a planning session's questions, one at a time
(`planning.answer`, which also skips) or in bulk (`planning.acceptDefaults`), is an ordinary member
write from the desktop: these operations are `desktopDecidable` and ask for no presence proof,
except for security, privacy and irreversible questions, which keep it until the owner decides
otherwise (review, 2026-11-12). They
stay `browserOnly` everywhere else, so a CLI or MCP token still can't answer for a person. Bulk accept
still never covers security, privacy or irreversible questions. `question.answer` and
`question.acceptDefaults` (questions outside a planning session) and every gate (spec, merge,
approval) keep their presence proof. Whether gates keep it is a separate decision. Spec 26, [ADR
0470](0470-planning-steering.md).

## Amendment, 2026-11-12: "Let the planner finish alone"
The owner approved the planning design (`docs/design/factory-ui`, PR #61) that offers "Let the
planner finish alone", and on 2026-11-12 approved its standing form: a person's explicit, revocable
instruction for one planning session (`planning.finishAlone`). It is not an acceptance on timeout,
so the rule above still holds. While it is on, every planning question bulk accept may cover is
accepted with its default, the open ones at once and each new one as the planner asks it. Conditions:
- only a person turns it on or off, in the app or the desktop: never an agent, the chat or the CLI;
- it is per session and off by default;
- security and privacy, irreversible and no-default questions still wait for a person;
- approving the spec stays a person's decision;
- every answer it gives is recorded as accepted under that instruction (`accepted_alone`), as the
  answer of the person who set it, with when they set it, and the Planning tab shows it that way;
- it turns itself off when the spec is sent back with changes requested.
See [ADR 0470](0470-planning-steering.md).
