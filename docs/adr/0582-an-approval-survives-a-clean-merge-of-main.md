# ADR 0582: An approval survives a clean merge of main, and nothing else

Status: accepted, 2026-11-13; proposed 2026-11-12 (spec [53](../specs/53-the-babysitter-delivers-approved-work.md),
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

> Amended 2026-11-13 (second review of PR #105, and the owner's answer to question 1: the change is
> identical **and all checks pass again**): a surviving approval no longer carries the old head's
> packet or posts `factory/verify` from it. The delivery ends `reverify`; the item verifies the new
> head on its own (Workflow v12), and only if that passes re-enters with the same approval, which
> `mergeQueue.enter` accepts only for a head whose change digest is the approved one. The change is
> read by its changed paths (GitHub's compare, then those paths' entries), never whole trees, and
> fails closed past 250 changed paths.

> Amended 2026-11-13: the owner answered spec 53's eight questions and accepted every
> recommendation (spec 53, **Decisions**). This ADR is accepted as written.

> Amended 2026-11-13 (work item #61, an approval withdrawn in a loop; revised after review): a file
> both sides changed no longer withdraws the approval **when the merge is bound to the factory's own
> update-branch call**. This reverses the 2026-11-12 "from git trees" rule (a file both sides changed
> withdraws) for bound updates only; every other case keeps it, and the change digest stays the strict
> one (mode and blob per changed path).
>
> - **Bound.** The trust anchor is the commit's identity. GitHub's update-branch API doesn't return
>   the merge commit, so a new head is bound only when all of these hold: exactly two parents; the
>   first is the head the queue asked GitHub to update from (`update_from_sha`); the second is exactly
>   the default branch's head the queue read when it asked (`update_base_sha`), not any commit on it;
>   GitHub signed it and committed it as its web-flow identity (`GitHub <noreply@github.com>`); and its
>   author is this App's bot (`<slug>[bot]`, `<id>+<slug>[bot]@users.noreply.github.com`), which is how
>   GitHub authors an update made through the API by the App (recorded from a real one:
>   `packages/core/test/fixtures/update-branch-merge.json`). A merge in GitHub's web conflict editor
>   is signed the same way and has the same parents, but is authored by the person: it isn't bound.
>   The commit is the PR's head, so a commit pushed after it fails the parents. A request no merge
>   answered (already current, a conflict, a refusal) is cleared, and an accepted merge uses it up.
> - **Judged from the merge base** (as a resolution is, #175): a path only the item changed must be
>   the approved head's, a path only the default branch changed must be its, a path neither changed
>   must be unchanged. An ambiguous merge base (criss-cross history) withdraws. A path both changed
>   is GitHub's three-way result. With none, the change must also be identical by the strict digest.
> - **What is given up.** After a bound update, a file both sides changed holds content **no person
>   looked at**: GitHub's textual merge, in which the default branch's change can land next to, or
>   inside the context of, the PR's hunk. The safeguards are only these: the binding above; the full
>   verify stage on the new head (Workflow v12), which the approval waits for; and `factory/verify`
>   on that exact head. Traced for this amendment: `pr.merge` doesn't check `factory/verify` itself.
>   It merges with `sha` = the head it was given, and GitHub refuses that merge unless the org
>   ruleset's required `factory/verify` from the App is green on it (no bypass, ADR 0037). Where that
>   ruleset is missing, the verify stage passing is the only check.
> - **The new head's digest becomes the approval's** (`approved_digest`), so `mergeQueue.enter` takes
>   the approval back only for that change. The timeline says, in words, that the default branch was
>   merged in cleanly, the approval carried, and on which head it was verified again.
> - **A loop guard:** when the item's last two delivery attempts were both withdrawn at an update for
>   the same reason (counted back from the latest, so an update that carried the approval in between
>   starts again), it isn't updated a third time on its own: it is held and a person asked, with the
>   reason, recommending to wait. A reopened merge gate says plainly that the approval was withdrawn,
>   when and why, and that it was verified again.
