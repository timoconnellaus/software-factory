# ADR 0622: The engine reverts a named culprit; a merged revert opens its reland

Status: accepted, 2026-11-13 (spec [53](../specs/53-the-babysitter-delivers-approved-work.md) §5,
decisions 2 and 5). Builds on [ADR 0584](0584-red-main-is-attributed-then-fixed-or-reverted.md)
and [ADR 0621](0621-a-culprit-is-proven-or-named-never-guessed.md).

## Decision
1. **Only a named culprit is reverted.** `mainRed.revert` refuses anything but the open episode's
   culprit as proven in code (the red reproduced, ADR 0621) or named by a person. A candidate not
   yet proven, or a culprit an agent named, is never reverted: never a guess.
2. **GitHub makes the revert.** The factory asks GitHub to revert the culprit's PR (GraphQL
   `revertPullRequest`, the PR page's Revert button): the exact inverse of its merge commit, from
   a branch GitHub makes. No code is written by the factory or an agent.
3. **It lands as a repair through its own gate.** The revert PR joins as an attached work item
   marked as a repair (it lands while the line is stopped, ahead of held work), verified like any
   attached PR. Its merge gate is a person's, and the episode's audience gets a phone push
   ("needs you", decision 4).
4. **Claimed before GitHub is asked.** `mainRed.revert` runs in three committed steps: a claim,
   unique per culprit and episode; a lease to ask GitHub (`calling`, one caller at a time, taken
   over only once it expires, doubling each try, three tries at most); then, carrying that try,
   the call to GitHub, or, for a try that died after GitHub answered, the revert PR GitHub already
   opened, found by the branch it named, and only from this repository, by the App, into the
   default branch (never a fork's look-alike). GitHub refusing (a conflict) is recorded once (`failed`), an incident is
   opened and the owner told; it is not tried again for the episode. A revert whose item ends
   without merging is closed (`abandoned`). Whether GitHub's PR is the exact inverse of the
   culprit's merge is checked in code from the PR's whole diff against its base on the default
   branch, and recorded (`exact_inverse`), never taken from input; the item says when it isn't.
   Text the App posts (the revert PR, the reland comment, posted once after the call commits) is
   made inert: no mention, link or closing keyword. A merged revert is never reverted by the
   babysitter, there is no "Reland: Revert …", and a chain relands at most once (a reland carries its
   original's root): after that the owner decides. An abandoned revert's PR is closed on GitHub.
5. **Who makes it, when.** The babysitter, from the minute cron, once the episode is 30 minutes old
   and no other repair is open; a person may ask at any time. One revert per culprit
   (`core_reverts`).
6. **Merging without a person** is the Publish stage's own switch, `revertWithoutPerson`, off by
   default; turning it on is a loosening a person saves. `revertVerdict()` holds the five
   conditions in code (the switch; the engine's unchanged revert of a suspect; 30 minutes; no
   other repair; its own CI green on every check red on main; no self-modify path). It approves
   nothing else, and `autoApprove` never approves a revert. The auto-approve actor that acts on
   the verdict comes with ADR 0515's build (PR #152); until then the gate is always a person's.
7. **Reland (decision 5).** Once the revert has merged, the reverted item stays Done, and a backlog
   item "Reland: <title>" is created as its child (not released), with a comment on the original
   PR saying what was reverted and why.

## Consequences
- **Acting without a person needs the owner.** AGENTS.md says merge always goes to a human. The PR
  that wires `revertWithoutPerson` to an actor needs the owner's explicit sign-off and amends
  AGENTS.md in the same PR; this one doesn't.
- `core_reverts` keeps one row per revert as the record of what was reverted; it isn't pruned:
  it grows by one row per culprit reverted.
- A revert of an auto-approved merge setting the project's `autoApproveHold` (ADR 0515 §7) comes
  with ADR 0515's build.
