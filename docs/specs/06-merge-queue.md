# Spec 06: The merge queue

**Read first**: [ADR 0330](../adr/0330-the-factory-runs-its-own-merge-queue.md),
[ADR 0320](../adr/0320-factory-branches-stay-mergeable.md) (its "Merge queue" section),
[ADR 0037](../adr/0037-factory-verify-pinned-and-sha-bound.md), [ADR 0053](../adr/0053-workflow-versioning.md),
[spec 04](04-verify-and-pr.md).

## Goal
Approved merges land one at a time per project, each tested once against the default branch it
will land on. Updating before verify (ADR 0320) keeps conflicts rare. The queue closes the gap left
after that: `main` moving between verify and the merge.

## Scope
- `core_merge_queue` (migration 0100): one open entry per work item, kept after it ends. The head
  is a project's oldest open entry whose work item is still open.
- Operations:
  - `mergeQueue.enter`, `mergeQueue.position` and `mergeQueue.list` (read);
  - `mergeQueue.update`: brings the head up to date with GitHub's update-branch and accepts only
    that clean merge;
  - `mergeQueue.leave`: ends the entry and wakes the next head.
- `pr.merge` and `pr.autoMerge` refuse a queued item that isn't the head, or a head SHA the queue
  didn't record.
- **The review packet carries over** to a clean update's head, marked `carriedFrom`. `factory/verify`
  there passes on green CI.
- **Workflow v4.** After the merge gate approves, the item enters the queue, waits for its turn,
  is updated, waits for CI on the new head, and lands with the approval. A check-only incident fix
  enters the queue before auto-merge is tried.
- Ending or cancelling a work item releases its entry. The work item detail shows its place in
  the queue.

## Out of scope
- Batching several PRs into one CI run, as GitHub's queue does.
- GitHub's merge queue as a backend (org-owned repos only).
- A dashboard of the queue beyond `mergeQueue.list` and the detail line.
- Updating a head when the update touches `.github/workflows/`: the App has no `workflows`
  permission, so GitHub refuses it and the item goes back to build.

## Acceptance criteria
1. Two approved items in one project merge in approval order. While the first one's CI runs, the
   second is queued at position 2 and neither is merged.
2. A head that's behind the default branch is updated by a merge commit. Its first parent is the
   approved head and its second parent is on the default branch. CI runs on that head before it
   merges, and the second item's update contains the first item's merge.
3. The approval carries over a clean update without a second gate, and the packet is copied to the
   new head with `carriedFrom`.
4. **Conflict at the head:** the item leaves the queue and goes back to build with the conflict
   note, without spending a retry. The next item becomes head and lands.
5. **Red CI after the update:** the item leaves the queue and goes back to build as a failed
   attempt, with a note that merging the default branch broke CI.
6. Only the head can be updated (`mergeQueue.update` on another item is a `conflict`). `pr.merge`
   refuses a queued item that isn't the head.
7. Cancelling or ending the item at the head frees the queue, and the next item lands.
8. v1–v3 instances replay unchanged. v4's step names are frozen in `workflow-versions.test.ts`.
