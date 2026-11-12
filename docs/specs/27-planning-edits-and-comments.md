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
  - Migration 0242 adds `released_at` and `released_by`. (The unique index on `core_specs
    (work_item_id, version)` it first added was dropped in round 2: the table has had that
    `UNIQUE` since migration 0020, so no duplicate can exist and nothing needs de-duplicating.)
  - Tests cover edit against revise in both orders (`beforeCommit`), an edit after approval,
    appended text, a deletion, a covering edit, a release, stale, off-topic and unassigned
    `answerFromEdit`, and a tag on an open question.
- After the second review (round 2 on #85):
  - **One segmentation.** `planBlocks` (runner-contract `plan-blocks.ts`) is the only way the plan
    is cut into blocks. The desktop renders the plan block by block from it (`PlanBody`): each
    block's own source lines through Markdown, indented by its depth, so a block on screen is a
    block on the server by construction. A nested list item, and a paragraph or fence inside an
    item, are blocks of their own. Fences follow CommonMark (a longer fence isn't closed by a
    shorter one, an unclosed one runs to the end, four spaces of indent isn't a fence). A comment
    no block reads like is an orphan, never an error.
  - **Section and count.** Each block knows its section (the heading path). An edit stores its
    footprint (`core_spec_edits.footprint`): the blocks it wrote, by section, and for a deletion
    the blocks it removed with how many copies were left. Edits are kept as a multiset, in order,
    so moving a person's line to another section, or deleting their copy of a duplicated line,
    doesn't count as keeping it. Fence content is compared exactly (trailing space aside); space
    is folded only outside fences.
  - **Edits the plan would misread are refused.** `spec.edit` takes whole blocks, and refuses an
    edit whose lines the resulting plan reads differently from how they read alone: an unclosed
    fence that swallows what follows, or a line that loses its list marker and joins the item
    above.
  - **A person's later word stands.** A person's edit retires every earlier standing edit it
    makes the plan stop keeping (it rewrote part of it, or brought back what it deleted).
  - **Release, always.** Under the plan, "Edits the planner keeps word for word" lists every
    standing edit, kept or not, with Release; the gate bar lists the ones not kept.
    `planning.ready` and `spec.revise` name each edit not kept, its section and its author.
  - **`question.answerFromEdit` takes the edit's own words**: the answer must appear in what the
    person wrote and not in what was there before (so a typo fix on a tagged line settles
    nothing). Chosen over recording the planner's reading of the edit because it needs no new UI
    and can't put words in the person's mouth.
  - **`spec.propose`** is refused while a planning session writes the plan, refuses a spec that
    drops a standing edit, and is guarded on the plan version it replaces.
  - `chat.send` checks an anchor's quote is what those lines of that version say.
  - Race tests prove each guard: the refused call's audit row must say a guard caught it, not the
    version's `UNIQUE`. Edit against approval and against `planning.ready` both ways, and two
    edits at once.
- After the third review (#85):
  - **An answer from an edit is what the edit changed**: the whole changed span of the tagged
    line, as written, or one of the question's options named in that span with no negation ("not",
    "instead", "rather", "except", …). "TBD" → "not Postgres, use SQLite" can't be recorded as
    "Postgres". The answered row shows the edit's words beside the answer as the planner's reading,
    and a click corrects it.
  - **A replacement remembers what it removed**: no more blocks of that section may say the removed
    words (even inside a longer line) than the edit left.
  - **Headings.** Renaming a heading carries the edits beneath it to the new section. Deleting a
    section leaves its edits standing, listed as not kept with the reason ("its section … is no
    longer in the plan"), never dropped silently; only edits the new one overrides (it removed what
    they wrote, or wrote back what they removed) are retired. Repeated headings are told apart
    ("Notes", "Notes (2)"), a setext heading is a section, and a nested block knows its parent item,
    which is part of what an edit keeps.
  - **Only what changed is the person's**: an untouched neighbour inside the edited lines stays the
    planner's.
  - CRLF plans parse as LF. An edit is compared with its own lines dedented, so a fence inside a
    `10.` item edits cleanly.
  - Rendering: ordered items show their number in the list, reference links resolve across blocks
    (a definition-only block shows its source), loose lists keep their spacing; the comment count
    and controls sit in a gutter inside the block; the edits list renders its Markdown and says why
    an edit isn't kept.
  - Screenshots: `docs/screenshots/planning/blocks-*.png` (nested lists, a fence, kept edits and a
    comment on each) and `edits-dropped-*.png` (the edits list with one not kept, and Release).
- Deferred: resolving comments, editing the structured lists (acceptance criteria, assumptions,
  coverage), and sf-app.
- After the fourth review (#85):
  - **An answer from an edit, simplified**: the planner records one only when the changed span IS
    one of the question's options (case and edge punctuation aside), or, for a question with no
    options, the whole changed span as written (`editAnswer` in runner-contract). Anything else
    answers nothing. The app offers the person a one-tap confirm above the open question ("You
    edited Q3's line to '…'. Record that as your answer?" with the options), except for security,
    privacy and irreversible questions. The negation list is gone.
  - **A person's structural edit carries edits along** (`structureMoves`, `rekeyFootprint`). Any
    block outside the edited lines keeps its identity, so rewording a parent item, or inserting,
    deleting or reordering headings ("Notes" becoming "Notes (2)"), re-keys the stored edits it
    moves in the same batch. When the planner's revision breaks an edit, the refusal names the
    edit, its author, its section and what differs (missing, moved, or what stands there instead).
  - **Removed blocks match only as whole blocks** in their section. A longer line that mentions
    one is allowed and listed under the edit ("the planner mentions something you removed: …")
    with Release or Keep.
  - The 200-edit cap counts after retiring what an edit overrides. ADR 0541 is amended to name
    `spec.edit` and `spec.releaseEdit` as one tap on the phone.

