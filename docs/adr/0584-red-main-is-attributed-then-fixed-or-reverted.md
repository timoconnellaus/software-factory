# ADR 0584: A red main is attributed, then fixed or reverted; never revert a guess

Status: accepted, 2026-11-13; proposed 2026-11-12 (spec [53](../specs/53-the-babysitter-delivers-approved-work.md),
question 2). Builds on [ADR 0581](0581-a-red-main-stops-the-line.md), [ADR 0583](0583-the-babysit-job-is-woken-for-judgement.md)
and ADR 0515 (dark factory mode).

## Context
A red `main` stops the line, so it must be repaired quickly. A revert is the fastest repair, but a
revert of the wrong change costs a working feature and proves nothing.

## Decision
1. A `babysit` job works each red episode: flake (rerun once) or regression; if a regression, it
   attributes the failure to one of the episode's suspects with its reasons (`mainRed.attribute`), or
   says it can't. An open repair, or anything merged since the failing head, means wait.
2. **A small, clear fix** becomes a `repair` item. **Otherwise**, once the episode is 30 minutes old
   with a culprit and no fix under way, a **revert**.
3. **The engine makes the revert**, through GitHub's revert of the culprit's PR: exactly the inverse
   change, no agent-written code, titled `Revert "<title>"`.
4. **It merges without a person only when** the workflow's Deliver stage has `revertWithoutPerson` on
   (off by default; turning it on is a loosening and a `self-modify` save) and `revertVerdict()`
   holds in code: it is the engine's unchanged revert of a suspect; the episode is 30 minutes old with
   no other repair; CI on the revert's head is green on every check red on `main`; and it touches
   none of the built-in self-modify paths (ADR 0036): a revert there is a self-change, which always
   needs a person. The switch is the revert's own: an item's `autoApprove` (ADR 0515's five
   conditions) never approves a revert, and `revertWithoutPerson` approves nothing else. The
   decision is made by ADR 0515's `auto-approve` actor. Otherwise a person decides it, told on the
   phone.
5. After a revert: a comment on the original PR, a linked backlog item "Reland: <title>", and, if the
   culprit was auto-approved, the project's `autoApproveHold` (ADR 0515 §7).

## Consequences
- The revert's own CI is the proof that the attribution was right; the agent's word never is.

> Amended 2026-11-13: the owner answered spec 53's eight questions and accepted every
> recommendation (spec 53, **Decisions**). This ADR is accepted as written. Decision 2: the revert merges without a person only with the Deliver stage's `revertWithoutPerson` on (off by default) and its own CI proving the repair; never on a self-modify path. Decision 5: the reverted item stays Done and a "Reland: <title>" backlog item is linked to it.
