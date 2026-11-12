# Spec 27: People edit the plan and comment on its parts

Read first: [ADR 0471](../adr/0471-people-edit-the-plan.md), [spec 26](26-planning-loop-to-kim.md),
and `docs/design/factory-ui/PlanFocus.html` (an edited line, its note, the Edit and Comment buttons).

## Goal
A person working with the planner can change a line of the plan directly, or comment on it, and
the planner takes it in: it keeps the person's wording, updates the answers the edit settles, and
replies to comments. This is slice 2 of planning to kim's standard; it comes before spec 21.

## Scope
- `spec.edit` (person, app or desktop): replace source lines of the current plan, checked against
  the version and the text it was made from. It creates a new plan version and a `core_spec_edits`
  row, logs a `spec.edited` user event and takes the spec back from the gate.
- `spec.revise` keeps every standing edit word for word, or is refused.
- `question.answerFromEdit` (the planner): answer a question as the person whose edit settled it.
  Refused for security, privacy, irreversible and other work items' edits.
- `chat.send { anchor }`: a comment anchored to plan lines, with its quote.
- News: `spec.edited` events, and `anchor` on chat messages.
- `planning.get`: the standing edits (lines, before, after, who, when) and each message's anchor.
- The Planning tab (desktop): Edit on a plan block, an edited block shown as the person's ("You
  edited this line…"), Comment on a block, and a marker on commented blocks that opens their thread.

## Out of scope
Comments on mockups and designs (specs 21, 22), resolving comments, editing the acceptance
criteria, assumptions or coverage lists (they are the planner's structured fields; a person comments
on them), and sf-app's tab.

## Acceptance criteria
1. A person edits a line: a new plan version by them exists, the edit is recorded with what it
   replaced, and the planner's next news has `spec.edited` with before and after.
2. An edit against an older version, or lines that no longer read `before`, is refused
   (`conflict`) and changes nothing.
3. `spec.revise` that drops or rewords a standing edit is refused; one that keeps it word for word
   succeeds.
4. `question.answerFromEdit` answers the question as the editor, marked as from the edit; it is
   refused for a security, privacy or irreversible question and for an edit of another work item.
5. An edit while the spec waits at the gate takes it back (ADR 0470), and `planning.ready` is
   refused until the edit is read.
6. A comment anchored to lines reaches the planner with its quote, and the Planning tab marks those
   lines.
7. The Planning tab shows Edit and Comment on plan blocks and an edited block as the person's, with
   before and after screenshots.

## As built
(Filled in by the PR.)
