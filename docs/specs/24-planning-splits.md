# Spec 24: Planning splits a work item

Read first: ADRs [0303](../adr/0303-a-planning-session-can-split-a-work-item.md) and
[0006](../adr/0006-work-item-workflows.md); [spec 20](20-planning-loop.md); the mockup
[`planning-session-states.html`](../../.kim/mockups/planning-session-states.html) (the spec gate
card).

## Goal
One planning session can plan several pieces of work, and the approver creates them all in one
decision.

## Scope
- **The spec's split**: the spec carries a `children` list. Each child has a title, a size, a spec
  slice (Goal / Scope / Acceptance criteria with provenance) and an optional `after`.
- **The gate**: one decision, "Approve spec + N work items".
  - On approval, the children are created with `parent_work_item_id` and intake actor `planning`.
    The parent's spec and kept artifacts are committed once, on the parent's branch, and merge
    through the parent's PR.
  - A parent with children has no build stage. It closes when the last child merges.
- **Children**
  - Triage reads the slice and the parent's record. A complete slice may skip planning under policy,
    with the reason logged.
  - `after` makes a child wait until its sibling merges.
- **Depth limit 1**: a child's planning can't split again; `spec.revise` refuses `children`.
- **App**: children are grouped under their parent in the inbox and the work list. The parent shows
  its children's stages.

## Acceptance criteria
1. Approving a spec with two children creates exactly two work items, each with
   `parent_work_item_id` and its spec slice. A repeated approval creates none (`alreadyDecided`).
2. A child with `after: <sibling>` doesn't start building until that sibling has merged.
3. A child's `spec.revise` with `children` is refused.
4. The parent closes as done when its last child merges, and as cancelled when all its children are
   cancelled.
5. The parent's spec and kept artifacts are committed once, and no child commits them again.

## Decisions (2026-11-13, the coordinator)
1. The parent's spec-only PR goes through verify and the merge gate **right after approval**, so
   the children read the parent's spec and `.kim/` from main. Its verify confirms in code that the
   PR holds exactly the approved files; any other path fails it. The parent closes done when its
   last child merges, cancelled if all its children were cancelled, and stays at its gate while its
   own PR is unmerged. Children don't start until the parent's PR has merged.
2. `after: sibling` is spec 50's "waits for" link: the dependent child isn't pulled until the
   sibling has merged. If the sibling is cancelled, the dependent child parks with a question for
   the owner.

## As built
### Part A: the server and Workflow v16 ([ADR 0630](../adr/0630-a-split-parent-lands-its-plan-then-its-children-build.md), migration 0401)
- `spec.revise { children }`: at most 8, keys unique, `after` a sibling's key, no cycle
  (`splitProblem`). Refused on a child (criterion 3). A person's edit of the plan keeps them.
- Approval (`spec.approve` or `approval.decide`, through `approvingSpecGate`) creates the children in
  its batch, in Ready, source `planning`, with the slice as body and its criteria, and an `after` as
  a waits-for link. A repeated approval creates none (criterion 1).
- `spec.commit` returns `children`. On feature `splits` (v16) the Workflow's `runSplit` skips build:
  `pr.open`, CI, `reviewPacket.record` (the verdict from the diff: only the approved files,
  `splitFiles`), the merge gate through `mergeV4`. Then `split.release` queues the children, and it
  waits for `split-<item>` (criteria 2, 4, 5).
- A child that ends tells its siblings (one waiting for it parks with a question when it didn't
  merge, `source: "split"`; answering "Start #N without #M" drops the link, "Cancel #N" cancels it)
  and, as the last, the parent. A parent that ends before merging cancels the children it holds.
- A child triage finds complete (asks to skip, not large) skips planning, with the reason logged.
- After the review of #171 (ADR 0630 amended, migration 0402): `spec.approve` for a split carries
  `specVersion` and `splitDigest`; verify compares every committed file's content hash at the head
  (`core_specs.committed_files`); the parent waiting for its children holds no active slot
  (`awaiting_children`); a child is bound to its approved slice (`split_slice`) for skipping
  planning and keeps the approved criteria; a held child can't be released before the plan merged.
- Tests: `core/test/splits.test.ts`, `engine/test/split-flow.test.ts` (the cancelled path, and the
  done path with `activeLimit` 1), the query-plan guard (the parent's read of its children),
  `engine/test/workflow-versions.test.ts`.

### Part B (next): the app
The gate's "Approve spec + N work items", the children under their parent in the inbox and the
work list, and the parent showing its children's stages.

