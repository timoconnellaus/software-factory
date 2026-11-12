# ADR 0582: An approval survives a clean merge of main, and nothing else

Status: proposed, 2026-11-12 (spec [53](../specs/53-the-babysitter-delivers-approved-work.md),
question 1). Amends [ADR 0330](0330-the-factory-runs-its-own-merge-queue.md) §3; keeps
[ADR 0037](0037-factory-verify-pinned-and-sha-bound.md).

## Context
The merge gate approves one head ("a new push withdraws it"). The babysitter must bring an approved
head up to date with `main`, which makes a new head. ADR 0330 already carries the approval over
GitHub's update-branch when the new head's parents are the approved head and a commit on `main`. That
proves how the commit was made, not that the change the person approved is the change that merges.

## Decision
1. **An approval survives a new head when all hold:** it is a clean merge of the default branch into
   the approved head (ADR 0330's parent rule); the **change digest** (each changed file's path and
   patch without line numbers, from GitHub's compare of the merge base with the head, read by the
   engine) equals the approved one; CI is green on the new head, and once spec 51 PR B is in, the
   checks that proved each criterion pass again there. With `autoApprove` on (ADR 0515), its five
   conditions are re-checked on the new head.
2. **Anything else withdraws it**: a conflict resolved by a `babysit` job, a fix, anyone's push. The
   item goes back to its merge gate. For a resolution the packet shows only the resolution (where the
   resolved merge differs from a plain merge of both sides) and the checks on the new head.
3. The copied packet records `carriedFrom` and the digest it was checked against.

## Consequences
- A person never re-reviews an unchanged change because `main` moved, and never misses a changed one.
- The digest is computed by the engine from GitHub, never from a runner's report.

> Amended 2026-11-12 (review of PR #105): the digest fails closed and is taken from git trees, not
> patches. The change is every path whose mode or blob differs between the head and its merge base,
> with both sides; identical means equal entry for entry, so a file both sides changed withdraws.
> Unreadable or truncated means no digest, and no digest never matches. Only the update-branch
> merge the factory asked for, made and signed by GitHub, with exactly the approved head and a
> commit on the default branch as parents and no file that is neither side's, is accepted. A
> withdrawal closes the approval and carries neither the packet nor `factory/verify` to the new
> head; the item verifies the new head again (Workflow v12) before a person decides.

