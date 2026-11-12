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
- Migration 0242: `core_spec_edits`, `core_planning_messages.anchor`, and
  `core_questions.answered_via_edit`.
- `spec.edit` (in `operations/planning.ts`) is `browserOnly` and `desktopDecidable`, like the
  other steering. It checks that the plan is still `specId` and that lines `lineStart..lineEnd`
  (0-based, inclusive) still read `before`, both now and guarded in the batch. It writes a new
  version by the person and a `core_spec_edits` row, replacing an earlier edit whose `after` was
  these lines. It logs `spec.edited` (a user event, so it wakes the planner and must be read before
  `planning.ready`), takes the spec back from the gate and resumes a yielded session.
- `spec.revise` refuses a body that drops a standing edit (`droppedEdits`: the edit's `after` must
  still appear, spaces aside; a deletion's `before` must stay gone).
- `question.answerFromEdit` (in `operations/questions.ts`, a planning tool) answers as the editor
  with the note "from their edit to the plan". It is logged as `answer.fromEdit`, which isn't news
  to the planner. It is refused for sensitive questions (the shared `isSensitiveQuestion`) and for
  another work item's edit.
- `chat.send { anchor }`. News carries `anchor { lineStart, lineEnd, quote }` on chat messages and
  `spec.edited` events. `planning.get` returns `edits` and each message's `anchor`.
- The Planning tab (desktop) hangs Edit and Comment on each plan block, from the block's source
  position in the markdown (a paragraph inside a list item belongs to the item).
  - Edit opens the lines in place; ⌘-Enter saves.
  - An edited block shows who edited it and that the planner keeps the wording, and which questions
    it updated.
  - A commented block shows a count that opens the chat with the anchor. Chat messages say "on the
    plan".
  - An answered question recorded from an edit reads "from your edit".
- Screenshots: `docs/screenshots/planning/edits-*.png`.
- After review (fixes on #85):
  - **Block-exact.** The plan is split into blocks (`planBlocks` in runner-contract: a heading, a
    list item with its continuation, a paragraph or a fence; spaces folded). An edit is kept only
    while each block it wrote is still a whole block of the plan. Text the planner adds to an
    edited block makes the block the planner's (refused while the edit stands), and a short edit
    no longer matches inside another block. The exact block text is the anchor: an edit has no
    position that could drift, and the app marks a block as a person's only when it is exactly
    one of the blocks the edit wrote.
  - **A lifecycle.** A later edit whose rewritten blocks include every block an earlier edit wrote
    retires it (`coveredEdits`). `spec.releaseEdit` lets a person release an edit, which reaches
    the planner as their message. A deletion is kept while the blocks it removed stay out.
  - **After approval.** `spec.edit` refuses once the spec gate is decided (`takeBackFromGate` says
    `decided`), and the guards make that hold in a race.
  - **Guards.** `spec.revise` updates `current_spec_id` only if it is still the version it
    replaces. `planning.ready` refuses a plan that doesn't keep a standing edit. `planning.get`
    marks each edit `kept`, and the gate bar warns when one isn't.
  - **`question.answerFromEdit`** also needs the edit to stand, be newer than the question's last
    answer, carry the question's `[Qn]` before and after, and be made by someone who may answer
    (the assignee or an approver).
  - **Tags.** An edit can't add `[Qn]` while Qn is open.
  - **Comments.** A comment is anchored to the block with its text (the nearest one when several
    read the same). One whose block is gone is listed under the plan, not dropped. `chat.send`
    checks the anchor's plan version belongs to the item.
  - Migration 0242 adds `released_at` and `released_by`, and a unique index on `core_specs
    (work_item_id, version)`.
  - Tests cover edit against revise in both orders (`beforeCommit`), an edit after approval,
    appended text, a deletion, a covering edit, a release, stale, off-topic and unassigned
    `answerFromEdit`, and a tag on an open question.
- Deferred: resolving comments, editing the structured lists (acceptance criteria, assumptions,
  coverage), and sf-app.
