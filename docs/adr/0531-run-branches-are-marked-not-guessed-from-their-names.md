# ADR 0531: Run branches are marked, not guessed from their names

Status: accepted, 2026-11-12. Spec [43](../specs/43-runners-under-load.md). Amends
[0380](0380-runner-local-tmux-and-hook-status.md) and [0260](0260-runners-attach-to-the-existing-checkout.md).

## Context
runner-local deleted a local run branch only when its name matched `factory/<n>-<slug>-run-<k>`, so
that it would never touch an owner's branch. Runs for an attached PR (ADR 0290) use
`<pr-branch>-run-<k>`, so:
- release never deleted them, and about 70 built up in the owner's checkout on the M5;
- `prepareWorkspace` never cleared a stale one. When a PR was re-attached, its new item's `-run-1`
  collided, `git worktree add -b` exited 255, and the item burned all its retries in minutes (#47).

## Decision
- **The branch a job creates is the job's.** `job.branch` is the run's own (ADR 0035, one branch
  per run). When `prepareWorkspace` creates it, it records a marker ref,
  `refs/software-factory/run-branches/<branch>`, in the checkout, and the workspace remembers it
  created the branch (`createdBranch`).
- **Release** deletes exactly that branch and its marker, unless a worktree has it checked out.
  Unmarked `factory/…-run-<k>` branches from before the marker are still deleted by name.
- **`prepareWorkspace`** treats an existing local `job.branch` that no worktree has checked out as
  stale and deletes it, whatever its name. If one is checked out anywhere, it refuses with the path.
- **The reaper and `sf-runner doctor`** sweep marked branches that no worktree has checked out
  (`orphan-branch`). They cover the configured checkouts as well as the ones job worktrees hang
  off. An unmarked branch is never touched.
- A marker ref lives in the checkout's own refs, not in its config. Git ignores it everywhere except
  `for-each-ref`.

## Consequences
- An owner's branch is only ever deleted if it has exactly a job's branch name and nothing has it
  checked out. Since `job.branch` names a run, that is the run's leftover by definition.
- The markers keep the branches' start commits reachable until they're swept. That's harmless, and
  the sweep removes them.
- Container job repos (ADR 0430) are their own clones, deleted whole, and their temporary fetch ref
  in the checkout is deleted in a `finally`. They don't have this leak. Sprites (#74) gets the same
  check when it lands.
