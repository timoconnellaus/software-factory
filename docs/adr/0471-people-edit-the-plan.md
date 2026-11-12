# ADR 0471: People edit the plan and comment on its parts

Status: accepted, 2026-11-12 (spec 27, block AE). Builds on [ADR 0302](0302-spec-provenance-coverage-and-critic.md),
[0350](0350-how-the-planning-loop-is-wired.md) and [0470](0470-planning-steering.md).

## Context
Planning can be collaborative, and the owner wants to steer it through the plan itself, not only
through answers and chat. The approved design (`docs/design/factory-ui/PlanFocus.html`) shows a
person editing a line of the plan ("You edited this line 4 min ago. The agent keeps your wording
and updated Q3 to match") and commenting on a part of it. Kim has neither: there, the agent owns the
plan and people steer it through chat.

## Decision
- **An edit is a plan version by a person.** `spec.edit { workItemId, specId, lineStart, lineEnd,
  before, after }` replaces those source lines of the current plan, if `specId` is still current
  and the lines still read `before`. Otherwise it is a `conflict`, and the person sees the newer
  plan. The new version is the person's (`created_by`), and the edit is recorded in
  `core_spec_edits` with what it replaced. Editing the same lines again replaces the earlier edit.
- **The planner keeps a person's wording.** `spec.revise` is refused (`conflict`) if a person's
  standing edit is no longer in the plan word for word (spaces aside). If the planner thinks it
  must change, it asks in the chat; the person edits again or tells it to.
- **The planner hears the edit and updates what it decided.** Each edit is a `spec.edited` event in
  the agent's news (the lines before and after, and who), and a user event like an answer: it wakes
  the planner, takes the spec back from the gate (ADR 0470), and must be read before
  `planning.ready`. When an edit settles an open or answered question, the planner records it with
  `question.answerFromEdit { questionId, answer, editId }`. The answer is the editor's, marked as
  coming from their edit (`answered_via_edit`), and the Planning tab says so. It is refused for
  security, privacy and irreversible questions, which a person answers themselves, and for an edit
  of another work item.
- **A comment is a chat message anchored to plan lines.** `chat.send` takes `anchor { specId,
  lineStart, lineEnd, quote }`. The planner sees the quote in its news (`anchor`), and the Planning
  tab marks the lines with their comments. Replying works like any chat message.

## Consequences
- The plan has two authors. Provenance stays readable: an edited line is shown as the person's,
  and the edit log says what it replaced.
- The planner can't undo a person silently; the cost is a refused revision and a question in the
  chat when it disagrees.
- An answer the planner records from an edit is still the person's own decision. That is why it is
  refused for the questions bulk accept never covers.

## Amendment, 2026-11-12 (review of #85)
"Word for word" is whole blocks, not a substring: each block an edit wrote must still be a block of
the plan exactly, so the planner can't append to a person's line or match a short edit inside its
own text. Edits have a lifecycle: a later edit covering an earlier one retires it, and a person can
release an edit (`spec.releaseEdit`). An edit is refused once the spec gate is decided. The planner's
revision is guarded on the plan version it replaces, `planning.ready` re-checks the edits, and an
answer recorded from an edit must be about that question, newer than its last answer, and by someone
who may answer it.

