# ADR 0581: A red main stops the line

Status: accepted, 2026-11-13; proposed 2026-11-12 (spec [53](../specs/53-the-babysitter-delivers-approved-work.md)).
Builds on [ADR 0580](0580-approval-and-delivery-are-separate.md) and [ADR 0280](0280-protect-main-with-a-generated-ruleset.md).

## Context
Nothing in the factory records whether a repository's default branch is green. `main`'s CI already
reaches the engine as a `check_suite` webhook and is dropped by `verify.refresh`. Merging more work on
top of a red `main` makes the failure harder to attribute and the repair harder to verify.

## Decision
1. **Main health is recorded per repository** (`core_main_health`): the head SHA, `green`, `red` or
   `pending` from the required checks (the ruleset's, else `ci`), the last green SHA and the open
   **red episode**. `cancelled` and `timed_out` are red; a run superseded before it started doesn't
   count. `main.observe` records it from the webhook and from the deliverer's own reads.
2. **While `main` is red only repairs merge** (a fix or a revert made for the episode, ADR 0584).
   Every other approved delivery is **held**, visibly. Work, verify and approvals continue; only
   landing stops. Green releases the holds in approval order.
3. **Who is told**: one Inbox card per episode for the project's approvers (failing checks, suspects,
   what the babysitter is doing, what is held), the held badge on the board, the Overview's
   Babysitter line, and, once the phone can push, the start of an episode, a revert waiting for a
   person, and green again. Nothing per held item.
4. **Holding is code, not a setting.** The Deliver stage's `holdOnRedMain` can't be turned off.

## Consequences
- A person can still press merge on GitHub during an episode, so `factory/verify` on each waiting
  non-repair head reads "held: main is red" (pending) and GitHub refuses that too (spec 53,
  decision 7, 2026-11-13).
- Every landing between the last green SHA and the first red one is a **suspect** of the episode.

> Amended 2026-11-13: the owner answered spec 53's eight questions and accepted every
> recommendation (spec 53, **Decisions**). This ADR is accepted as written. Question 7 is decided: while `main` is red, `factory/verify` on each waiting non-repair PR reads "held: main is red" (pending), so GitHub refuses those merges too.
