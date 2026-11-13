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
4. **Who makes it, when.** The babysitter, from the minute cron, once the episode is 30 minutes old
   and no other repair is open; a person may ask at any time. One revert per culprit
   (`core_reverts`).
5. **Merging without a person** is the Publish stage's own switch, `revertWithoutPerson`, off by
   default; turning it on is a loosening a person saves. `revertVerdict()` holds the five
   conditions in code (the switch; the engine's unchanged revert of a suspect; 30 minutes; no
   other repair; its own CI green on every check red on main; no self-modify path). It approves
   nothing else, and `autoApprove` never approves a revert. The auto-approve actor that acts on
   the verdict comes with ADR 0515's build (PR #152); until then the gate is always a person's.
6. **Reland (decision 5).** Once the revert has merged, the reverted item stays Done, and a backlog
   item "Reland: <title>" is created as its child (not released), with a comment on the original
   PR saying what was reverted and why.

## Consequences
- `core_reverts` keeps one row per revert as the record of what was reverted; it isn't pruned:
  it grows by one row per culprit reverted.
- A revert of an auto-approved merge setting the project's `autoApproveHold` (ADR 0515 §7) comes
  with ADR 0515's build.
