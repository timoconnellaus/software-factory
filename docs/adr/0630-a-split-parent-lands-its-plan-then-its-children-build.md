# ADR 0630: A split's parent lands its plan, then its children build

Status: accepted, 2026-11-13 (spec 24, the coordinator's decisions). Amends
[ADR 0303](0303-a-planning-session-can-split-a-work-item.md) and
[ADR 0491](0491-work-starts-in-a-backlog-and-is-released-to-the-factory.md).

## Context
ADR 0303 lets a plan split a work item: the children are created when a person approves the
spec, the parent builds nothing and closes when its last child merges, and the parent's spec and
kept `.kim/` files merge through the parent's PR. Nothing reaches main without `factory/verify`
and the merge gate (ADR 0020), so the parent's PR needs a path through them that has no build
and no criteria to judge, and that can't be used to carry code to main.

## Decision
1. **The children are created with the approval, held in Ready.** `spec.revise` takes `children`
   (at most 8, each with a key, title, size, Goal / Scope / Acceptance criteria and an optional
   `after`), checked for unique keys and no `after` cycle. Approving the spec gate creates them in
   the approval's batch, with `parent_work_item_id`, source `planning`, the slice as body and its
   criteria. A repeated approval creates none. A child's own plan can't split (depth 1).
2. **The parent's PR is the approved plan's files only, decided in code.** On Workflow feature
   `splits` (v16), a parent whose approved spec has children skips build. Its PR is opened, CI is
   read, and the review packet is recorded with no reviewer run. The verdict passes only when CI is
   green and every changed path is one of the approved files (the spec, the plan's copy under
   `.kim/plans/`, and the `.kim/` files recorded at approval), each added or modified. Any other
   path, a removal or a rename fails it. It then goes through the merge gate like any change. A
   failure or a send-back waits for a push, since there is nothing to build.
3. **The children start after the plan merges.** Once the parent's PR has merged, `split.release`
   moves its children from Ready to the queue together. They triage and plan against a main that
   already has the parent's spec and `.kim/` files.
4. **`after` is a "waits for" link** (ADR 0491). The dependent child isn't pulled until its
   sibling is done (merged). If the sibling ends without merging, the dependent child parks with a
   question to the owner: start it without that sibling (the link goes), or cancel it.
5. **A child may skip planning** when triage finds its slice complete and asks to skip, unless it
   is large. A person approved the slice with the parent's spec. The reason is logged.
6. **The parent closes when its last child ends.** It is done if any child merged and cancelled if
   none did. If its own PR hasn't merged by then, it stays at its gate. A parent that ends before
   its plan merges cancels the children it still holds in Ready.

## Consequences
- Migration 0401: `core_specs.children` and `core_work_items_parent_idx (parent_work_item_id,
  status)`, read when a child ends, at release, and by the parent's wait (at most 9 rows).
- `workItem.finish` takes `cancelled`, used only by a split's parent.
- The parent waits for `split-<item>`, sent when its last child ends; it re-reads the children
  once a day in case the event was missed.
