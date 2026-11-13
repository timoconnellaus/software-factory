# ADR 0587: A person's push to a factory branch re-verifies the new head

Status: accepted, 2026-11-13. Extends [ADR 0037](0037-factory-verify-pinned-and-sha-bound.md) and
[ADR 0290](0290-an-outside-pr-is-attached-and-verified.md) to factory-built items; Workflow v13.

## Context
Work item #61 (factory-built, PR #135) was at its merge gate for `b0cb9a5` when a person pushed
`8015041` to its branch. `verify.refresh` posted `factory/verify` failure on the new head ("A new
push needs verify to run again", ADR 0037), and nothing else happened: the gate stayed open for the
old head, approving it was refused ("the branch moved after you approved"), and nothing told the
person why. An attached PR (ADR 0290) already withdraws its gate and re-verifies on a push; a
factory-built item did not, because its branch was assumed to move only by the factory.

## Decision
1. **Who pushed decides.** The `push` webhook's sender, as #134 tells the factory's own merge from
   an outside one: `<app-slug>[bot]` is the factory (a run's branch, the control plane's moves, the
   babysitter's update-branch merge), checked by branch confinement as before. Anyone else's push to
   a factory item's own branch (`factory/<n>-<slug>`, never a run branch), while the item is in
   verify or at merge, is a person's push. `push.observe` handles it, after checking on GitHub that
   the branch's head is the pushed commit, so a late delivery of an older push changes nothing.
2. **Workflow v13 (`reverify-on-push`):** the item's head becomes the pushed commit. An open merge
   gate for the old head is withdrawn ("a new commit was pushed by `<login>`"), and an approval the
   babysitter holds is closed and its delivery ends `withdrawn`. The item goes back to **verify**,
   not build: a fresh verify run on the new head with the project's checks run there, a new review
   packet, a new merge gate. No build attempt is used.
3. **In flight.** A verify run that finishes on a head that is no longer the item's opens no gate
   and counts no failure; a CI wait on it is woken and sees it is stale; a packet recorded for it is
   only that head's record. The item then verifies the newest head, once, however many pushes came
   while it ran. A build in flight is unchanged: `branch.advance` refuses to move a branch that is
   not a fast-forward, which fails that attempt as before (a person pushing during a build is
   pushing to a branch the factory is about to write).
4. **Earlier versions.** An open merge gate is withdrawn the same way at any version, and the
   Workflow verifies the new head (a withdrawal never reached a factory item's gate before, so no
   running instance changes what it did). A babysitter's approval is closed too; v12 re-verifies,
   v11 treats it as a failed delivery. With nothing open to withdraw (verify running on v12 or
   earlier), the item keeps the head it verifies and the push is recorded on its activity: the gate
   that opens is for the old head, and Send back verifies the new one.
5. **The person sees it.** The item's activity says "`<login>` pushed `<sha>`: verifying again";
   the withdrawn gate's Inbox card goes, and a new one comes when verify is done.
6. **The babysitter merging it right now** is left to the babysitter: GitHub refuses its merge for a
   moved head and it withdraws the approval itself (spec 53).

## Consequences
- A person can push a fix to a factory PR without the item getting stuck; their commit is verified
  like the factory's own before anyone may merge it.
- A verify run already going when the push lands still runs to the end (its result is discarded);
  cancelling it on the runner is a possible follow-up.
