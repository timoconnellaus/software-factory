# ADR 0320: Factory branches stay mergeable, and "can't merge" and "no CI" are not build failures

Status: accepted, 2026-11-11 (incident [2026-11-11 bootstrap #7](../incidents/2026-11-11-bootstrap.md#7-a-factory-pr-that-couldnt-merge-waited-for-ci-that-never-came)).
Builds on [ADR 0035](0035-lease-fencing-and-one-branch-per-run.md), [0037](0037-factory-verify-pinned-and-sha-bound.md),
[0053](0053-workflow-versioning.md), [0230](0230-check-only-incident-fixes-auto-merge.md),
[0250](0250-runner-host-pushes-and-harness-projection.md) and [0280](0280-protect-main-with-a-generated-ruleset.md).

## Context
Work item #1 (attachments) built for about an hour on a branch cut from `main` at #20. Meanwhile
#21, #22 and #24 landed, touching the same files. The factory opened PR #23 30 seconds after #24
merged, and it conflicted with `main` from the start. **GitHub runs no `pull_request` workflows on a
PR it can't build a merge commit for**, so no `ci` check suite was ever created for the head.

The v2 Workflow only knew CI as `success | failure | pending | missing`. It waited three rounds,
read `missing`, failed the review packet ("no CI has reported on 510bc9d"), and sent the item back to
build with that line as the thing to fix. The builder had no way to act on it. It pushed the same
head, failed the same way, used up `retryLimit` and opened a factory incident whose real cause was
the factory's own.

## Decision
1. **A build starts from the latest default branch.** The job carries `repo.defaultBranch`
   (optional, additive). The runner host fetches it with the job token, into its own ref namespace,
   alongside the item branch. Before the session it merges it into the run branch with a merge
   commit, never a rebase.
   - A **conflict is left in progress** (MERGE_HEAD, the markers) for the build agent. The build
     prompt says to resolve it keeping both sides, and to commit the merge.
   - A session that leaves **unmerged paths fails without a push**.
   - A clean merge on its own counts as a build only when the branch already has work of its own,
     as on a retry. On a fresh branch it is still "no commits".
   - The diff artifact is taken from after the host's merge, so it shows the session's work.
2. **"Can't merge" is its own state.** `ci.read` also returns the PR's `mergeable`
   (`GitHubService.pullRequestMergeability`, `GET /pulls/{n}`). It is null when unknown, still
   computing, or the PR's head isn't the SHA asked about. Workflow **v3** reads it:
   - right after the PR opens, a few times while GitHub computes it. A conflict there skips the
     verify run.
   - on every CI read while waiting. `main` moving mid-verify is caught within one CI wait.

   Either way the item goes back to build with a note the agent can act on. The first
   `MERGE_ROUNDS` (3) of these send-backs aren't failed attempts, because the default branch moving
   isn't the build's fault. After that they count against `retryLimit` like any other.
3. **CI that never reports asks a person.** When CI is still `missing` and the PR isn't conflicting,
   v3 doesn't fail the packet or retry the build. The cause is outside the code: Actions off, a run
   waiting for approval, no workflow on `pull_request`, an outage. So v3 asks a blocking Question
   (domain `operations`) naming the likely causes, with two options:
   - **Re-check CI** reads CI again (and asks again if it's still missing);
   - **Stop this work item** ends it as failed, with no incident.
4. **Versioning.** All of this is v3 (`WORKFLOW_VERSION = 3`), and v3 only adds steps. v2
   instances replay unchanged: they ignore `mergeable` and keep the old missing-CI behaviour. The
   prompt change and the host's merge apply to every new build job, whatever version queued it.

## Merge queue
Not adopted now. A merge queue answers a different problem: it re-tests a green PR on top of the
latest `main` before merging. It rejects a conflicting PR rather than resolving it, so it wouldn't
have unstuck #23. It also needs CI on `merge_group` events and `factory/verify` posted for the
queue's temporary SHAs, which changes ADR 0037's verify-per-head-SHA model. For now two things
cover it: ADR 0280's strict required checks (the branch must be up to date) and branches the
factory keeps current itself. Revisit when merge volume makes up-to-date re-runs the bottleneck.

## Consequences
- A factory PR is mergeable when verify starts, unless `main` moved during the session. Either way
  conflicts come back to the build agent as work, not as a mystery CI failure.
- The host now writes to the run branch before the session, a merge commit by the factory's
  identity, and only on the run branch the job token may push.
- Number collisions (ADRs, migrations claimed in `docs/parallel-work.md` on unmerged branches) still
  only show up at merge time. The build prompt asks the agent to renumber on collision. A
  control-plane allocator for those numbers is a possible follow-up.
- Not built: re-checking open factory PRs on every default-branch push (the CI reads catch it within
  one wait); listing the conflicting files (GitHub's API doesn't give them; the host's merge does,
  in the job's events).
