# ADR 0583: The `babysit` job is woken only for judgement

Status: accepted, 2026-11-13; proposed 2026-11-12 (spec [53](../specs/53-the-babysitter-delivers-approved-work.md),
question 2 and 3). Builds on [ADR 0580](0580-approval-and-delivery-are-separate.md),
[ADR 0052](0052-job-tokens-and-branch-confinement.md), [ADR 0018](0018-model-roles.md) and AGENTS.md's
"no ambient authority".

## Context
Some of what the patientos babysitter does needs a model: is a failed check a flake or a regression,
how is a conflict resolved, which landing turned `main` red. That runs in a loop on a schedule there.
Here the engine already knows when such a question arises.

## Decision
1. **A new built-in job kind, `babysit`**, claimed by a runner from the light pool like any job, in
   the repository, with the per-job repo token and nothing standing. Role `babysit`, never a model id.
   At most one open per repository.
2. **The deliverer starts it, only with reasons**: `conflict`, `check-failed`, `main-red`. Reasons
   arriving meanwhile queue on it; it ends when `babysit.next` has nothing left. No polling, no
   schedule.
3. **What it may do without a person**, each an operation with its floor in code: rerun a failed
   check once as a flake (`ci.rerun`, refused a second time for that check and SHA) and record it
   (`flake.record`, the known-flake list); merge the default branch into a branch to resolve a
   conflict, on a run branch that the engine advances (which withdraws the approval, ADR 0582); open a
   fix as a `repair` item that goes through verify, the merge gate and delivery; ask the engine for a
   revert (ADR 0584); send an item back to build with a regression.
4. **What it never does**: push to the default branch, merge, approve, deploy or roll back, change
   settings, rulesets or config, close a PR, force-push.
5. A flake seen three times in 14 days opens a backlog item to fix it; it is never released by itself.

## Consequences
- A runner slot is used only while there is something to judge.
- Attached PRs' conflicts still go to their author (ADR 0290): the factory never pushes to them.

> Amended 2026-11-13: the owner answered spec 53's eight questions and accepted every
> recommendation (spec 53, **Decisions**). This ADR is accepted as written. Decision 3: a check that flakes three times in 14 days opens a backlog item to fix it. Decision 8: an attached PR that conflicts goes back to its author; the `babysit` job never pushes to its branch.
