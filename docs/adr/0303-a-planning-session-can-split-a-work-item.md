# ADR 0303: A planning session can split a work item

Status: accepted, 2026-11-11 (planning interview).

## Context
Planning often produces more than one work item's worth of work. The interview that produced this
ADR produced several specs, for example. `core_work_items.parent_work_item_id` exists, and
[ADR 0006](0006-work-item-workflows.md) allows agents to spawn work items within cascade and depth
limits, but nothing uses either.

## Decision
- **The planning agent may propose a split.** It lists child work items in the parent's spec, each
  with a title, a size and its own spec slice: Goal / Scope / Acceptance criteria, with provenance
  pointing back at the parent.
- **The children are approved with the spec**, through one decision: "Approve spec + N work items".
  The children are created only on approval, as work items with `parent_work_item_id` set and
  intake actor `planning`.
- **Each child runs its own pipeline.** Its triage starts from its spec slice and the parent's
  record. A child whose slice is complete may skip planning, under the autonomy policy, with the
  reason logged.
- **Order:** a child may declare `after: <sibling>`, and its Workflow waits until that sibling has
  merged.
- **Cross-cutting decisions** (ADRs, design-system changes, vocabulary) land once, with the parent's
  spec commit. The parent has no build stage of its own when it split. It closes when its last
  child merges, or as cancelled if every child is cancelled.
- **Depth is 1:** a child cannot split again. This is the cascade and depth limit ADR 0006 left
  open, for planning.

## Consequences
- Amends ADR 0006. The inbox and the work list group children under their parent.
- Built in [spec 24](../specs/24-planning-splits.md).

> Amended 2026-11-13 by [ADR 0630](0630-a-split-parent-lands-its-plan-then-its-children-build.md):
> the children are held until the parent's plan merges (its PR may carry only the approved files,
> checked in code), `after` is a "waits for" link, and a child whose sibling ends without merging
> asks the owner.
