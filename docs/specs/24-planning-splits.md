# Spec 24: Planning splits a work item

Read first: ADRs [0283](../adr/0283-a-planning-session-can-split-a-work-item.md) and
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
