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
> - **Bound** (revised in the second review of #190). The trust anchor is the SHA. An identity
>   fingerprint isn't one: a commit the factory's own `commitFiles` wrote (any per-job token of the
>   App can) has the same author (`<slug>[bot]`), committer (`GitHub <noreply@github.com>`) and
>   signature as GitHub's update-branch merge, with any parents and content. So the queue makes the
>   merge itself with `POST /repos/{o}/{r}/merges` (base: the PR's branch, head: the exact default
>   branch SHA it read), which is synchronous and returns the merge commit; it records that SHA
>   (`update_merge_sha`, migration 0394) with the approved head and main's head, and accepts only a
>   PR head equal to it, whose parents are exactly [approved head, main's head]. Any other head (a
>   commit beside it with the same parents, a push after it, a merge onto a branch that had moved)
>   withdraws. A request no merge answered is cleared, and an accepted one is used up. This also
>   ends the false withdrawal when main moved between reading its head and update-branch.
> - **Judged from the merge base** (as a resolution is, #175): a path only the item changed must be
>   the approved head's, a path only the default branch changed must be its, a path neither changed
>   must be unchanged. An ambiguous merge base (criss-cross history) withdraws. A path both changed
>   is GitHub's three-way result. With none, the change must also be identical by the strict digest.
> - **What is given up.** After a bound update, a file both sides changed holds content **no person
>   looked at**: GitHub's textual merge, in which the default branch's change can land next to, or
>   inside the context of, the PR's hunk. The safeguards are only these: the binding above; the full
>   verify stage on the new head (Workflow v12), which the approval waits for; and the factory's own
>   proof that this exact head was verified, checked before GitHub is asked by `pr.merge` and
>   `pr.autoMerge` alike (`requireVerifiedHead`; a test fails any other caller of the adapter's
>   merge): a review packet made for that SHA with verdict `pass` (`reviewPacket.record` takes only
>   the item's current head; a packet carried from another head doesn't count) and the factory's
>   `factory/verify` for that SHA completed with `success` (a head held while main is red isn't), read
>   from D1, never from GitHub alone. Tracing it showed both merges had relied on GitHub's ruleset
>   requiring `factory/verify`, and that ruleset may be off (it was off on this repository on
>   2026-11-13) or absent on a customer's. GitHub's required check, where it is on, is a second guard.
> - **No packet is carried to another head**, on any row. ADR 0330's carry for items that land
>   themselves (Workflow v4–v10) is gone: their update ends the turn (`moved`), the approval is
>   closed as withdrawn, and the item verifies the new head without a build (the path a withdrawn
>   approval takes at any version), then a person decides again. It costs them a verify and a new
>   approval each time main moves before they land; the loop guard below bounds it.
> - **Types and the adapter enforce it too** (third review): the adapter's merge takes a
>   `VerifiedHead`, which only `requireVerifiedHead` makes, and its merge of main into a branch
>   (`mergeIntoBranch`) refuses the repository's default branch, which it reads from GitHub. A
>   source scan keeps both: each merge is in a registered operation that checks the head first.
> - **The new head's digest becomes the approval's** (`approved_digest`), so `mergeQueue.enter` takes
>   the approval back only for that change. The timeline says, in words, that the default branch was
>   merged in cleanly, the approval carried, and on which head it was verified again.
> - **A loop guard:** when the item's last two delivery attempts were both withdrawn at an update for
>   the same reason (counted back from the latest, so an update that carried the approval in between
>   starts again), it isn't updated a third time on its own: it is held and a person asked, with the
>   reason, recommending to wait. An item that lands itself (v4–v10) gets the same after two turns in
>   a row that ended with main merged in and a trip back to verify (`mergeQueue.hold`, called by its
>   own Workflow). A merge the queue made is never made twice: while one is recorded the branch's own
>   ref is read (the PR's view can lag), so "nothing to merge" can't wipe the record. A reopened merge gate says plainly that the approval was withdrawn,
>   when and why, and that it was verified again.
