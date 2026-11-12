# ADR 0330: The factory runs its own merge queue, one per project

Status: accepted, 2026-11-11. Spec [06](../specs/06-merge-queue.md). Builds on
[ADR 0320](0320-factory-branches-stay-mergeable.md) (its "Merge queue" section),
[0037](0037-factory-verify-pinned-and-sha-bound.md), [0041](0041-in-app-review-packet-is-the-merge-gate.md),
[0053](0053-workflow-versioning.md), [0230](0230-check-only-incident-fixes-auto-merge.md) and
[0280](0280-protect-main-with-a-generated-ruleset.md).

## Context
ADR 0320 merges the default branch into a run branch before every build, so a factory PR is
mergeable when verify starts. That doesn't stop conflicts. `main` can move between verify and the
merge, and with the default-branch ruleset's strict up-to-date rule (ADR 0280) every move means
another update and another CI run. Several approved PRs can chase `main` and each other.

GitHub's merge queue serializes merges, but GitHub only offers it on organization-owned repos.
`software-factory` is a personal-account repo. It also rejects a conflicting PR rather than
resolving it. And it needs CI on `merge_group` plus `factory/verify` posted for the queue's
temporary SHAs, a change to ADR 0037's verify-per-head-SHA model.

## Decision
1. **Approved merges go through a per-project queue** (`core_merge_queue`, migration 0100).
   - In Workflow v4, approving the merge gate doesn't merge. It puts the item in the queue.
   - The head is the project's oldest open entry whose work item is still open. An item that
     ended can never hold the queue.
   - Only the head is updated or merged, so nothing else lands while its CI runs. Each PR runs CI
     once, against the default branch it lands on.
2. **The head is brought up to date by GitHub's update-branch**, done server-side by the App with
   `expected_head_sha`, with no runner involved.
   - `mergeQueue.update` accepts the new head only if it's that clean merge: first parent the head
     the queue had, second parent a commit on the default branch.
   - A head that moved any other way is `moved`: it leaves the queue and goes back to build.
   - Branch confinement (ADR 0052) allows this push, because no run is active at the merge stage.
3. **The approval carries over a clean update.** The reviewed diff is unchanged, so the person
   isn't asked again.
   - The review packet is copied to the new head, marked `carriedFrom`.
   - `factory/verify` on the new head passes only on green CI there, like any packet. ADR 0037
     still holds: the check is bound to the SHA that merges.
   - The approval is bound to the operation and the work item, not the SHA. So `pr.merge` checks
     the SHA against the queue instead: a queued item merges only at the head, at the head SHA the
     queue recorded.
4. **What leaves the queue:**
   - **A conflict** goes back to build with ADR 0320's conflict note. The runner resolves it, then
     the item is verified and approved again, since the resolution is new code. Like ADR 0320's
     conflicts, the first three are free of `retryLimit`.
   - **Red CI after the update** is a failed attempt: merging the default branch broke it.
   - **An item that finishes or is cancelled** releases its entry and wakes the next head.
5. **A check-only incident fix (ADR 0230)** enters the queue before auto-merge is tried, and
   auto-merges at the head.
   - If the rule refuses it, it leaves the queue for the normal merge gate.
   - If the project's policy asks a person, the wait for that decision happens outside the queue.
     The item then queues again with the approval.
6. **Waking:** leaving the queue sends `mergeq-<item>` to the next head's Workflow. Queued items
   also re-read their position every hour, so a missed event only costs time. A merge-stage item
   waiting for CI is woken by the check-suite webhook, like verify.

## Consequences
- With the queue as the only way the factory merges, the strict up-to-date rule never costs more
  than one CI run per merge. Throughput is one merge per CI run, about 1.5 minutes here; batching
  can come later.
- A PR merged outside the factory (a bootstrap exception, a person's own PR) just puts the head
  behind. The queue updates it. In-flight v3 instances still merge directly; they aren't held to
  the queue.
- **Workflow files:** the App has no `workflows` permission, so GitHub refuses an update whose
  merge brings in `.github/workflows/` changes. The item goes back to build, and the runner's merge
  hits the same limit. Granting `workflows` is a separate decision.
- GitHub's merge queue can become an alternative backend for org-owned repos. The Workflow only
  sees `enter`, `position`, `update` and `leave`.

**Amended 2026-11-12** (spec [53](../specs/53-the-babysitter-delivers-approved-work.md), proposed):
the queue becomes the babysitter's delivery table. From Workflow v11 an item no longer lands itself:
the per-repository deliverer updates and merges the head (ADR 0580), and §3's carry-over also requires
an unchanged change digest and checks passing again on the new head (ADR 0582).
