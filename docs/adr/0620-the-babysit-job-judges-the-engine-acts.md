# ADR 0620: The babysit job judges; the engine acts on its verdict

Status: accepted, 2026-11-13 (spec [53](../specs/53-the-babysitter-delivers-approved-work.md) part d).
Builds on [ADR 0583](0583-the-babysit-job-is-woken-for-judgement.md) and
[ADR 0585](0585-one-babysitter-per-repository.md).

## Context
Spec 53 §4 names the `babysit` job's operations (`ci.rerun`, `flake.record`, `babysit.next`) as
calls the job makes. A job's agent has no channel to the factory of its own: build, verify and
triage agents hand back a result file, and only a planning session reaches operations, through the
runner host's relay and a dedicated MCP server in the harness. Giving the babysitter that path would
mean a second relay and MCP server in `local/runner-host` and `packages/harness-claude`, whose
owning session has ended. The job's agent also holds no GitHub credentials (ADR 0033), so it can't
read a check's log or ask GitHub to rerun one.

## Decision
1. **The job judges; code acts.** A `babysit` job hands back one verdict for the one reason it was
   woken for (`babysitResultSchema`: `flake`, `regression`, `resolved` or `person`, with the check,
   the test and a note). The deliverer reads it when the job ends and acts through operations, each
   with its own floor, as the babysitter (`BABYSITTER`), under its pass's lease (ADR 0586) and the
   job's **delivery fence** (ADR 0585):
   - `flake` → `ci.rerun` (once per check per SHA: `core_ci_reruns`' key refuses a second); when CI
     then passes, `flake.record` adds the check to `core_flakes`, and a third flake in 14 days opens
     a backlog item to fix it (decision 3). A second failure ends the delivery as a regression.
   - `resolved` (a conflict) → `branch.advance` moves the item's branch to the job's run branch,
     which the runner host pushed after merging the default branch in (never a rebase or force
     push), and the delivery ends `withdrawn`: the item verifies the new head and a person approves
     the resolution (decision 1).
   - `regression` or `person` → the delivery ends (`failed` or `conflict`) with the job's note.
   - `babysit.next` closes the job.
2. **The engine gives the job its evidence.** `babysit.wake` puts the failing checks' own reports
   (output and annotations, `checkRunDetail`) and the repository's known flakes into the prompt.
3. **One job per reason, one reason at a time.** The deliverer works one head at a time, so a job
   has one reason. A job that dies (no usable result) is replaced once by a job with a higher fence;
   the dead job's late hand-back is refused by the item's lease and any write with its fence by the
   repository's.
4. **Where it is woken.** A conflict at delivery (`mergeQueue.update` or GitHub's mergeability) on a
   factory item whose Workflow re-verifies a withdrawn approval (v12+); a required check that is red
   on the head when the deliverer reads CI before merging. An attached PR's conflict is refused in
   code and goes back to its author (decision 8). Older items keep the old behaviour (back to
   build).

5. **Only a runner that can babysit gets the job** (review of #158). A `babysit` capability, declared
   by the runner host (whose job runner handles the stage), is required by every babysit job; an
   older runner never claims one. With no capable runner online the job waits saying "no runner
   that can babysit is online", and after ten minutes it is cancelled and the delivery ends with
   that reason, as it did before the babysitter.
6. **A job that pushes nothing gets a read-only token.** A `check-failed` job's job token is
   `contents: read`; only a conflict job's can push (its run branch only, ADR 0052).
7. **`core_jobs` has no CHECK on its stage any more** (migration 0390, the last rebuild of it): the
   stage is validated in code (`JOB_STAGES` and the operations that write jobs), so a new stage
   needs no migration.

## Consequences
- Nothing the agent writes can merge, approve, rerun more than once or move a branch except by
  fast-forward to its own run branch.
- The runner host changes are small: a `babysit` job sent to resolve a conflict is prepared, merged
  and pushed like a build (`pushesRunBranch`).
- Not covered yet: the reopened merge gate shows the whole new head, not only the resolution
  against a plain merge of main (decision 1's "the person sees only the resolution"); that is the
  next PR.
- Not covered yet: a check that fails on a head the queue updated is read by the item's Workflow
  when it re-verifies that head (ADR 0582), so it goes back to build as before rather than to the
  babysitter. Routing it there needs a Workflow feature row.
- The run branch is `<item branch>-run-<n>` like every run's, not spec 53's `-babysit-<n>`: branch
  confinement already knows it.
- The job asks for the `implement` model role; a separate `babysit` role can be added to the role
  registry later.
