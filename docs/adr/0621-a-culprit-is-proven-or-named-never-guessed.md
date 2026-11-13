# ADR 0621: A red main's culprit is proven in code or named by a person, never guessed

Status: accepted, 2026-11-13 (spec [53](../specs/53-the-babysitter-delivers-approved-work.md) part e,
decisions 7 and 2). Builds on [ADR 0581](0581-a-red-main-stops-the-line.md) and
[ADR 0584](0584-red-main-is-attributed-then-fixed-or-reverted.md).

## Decision
1. **Every factory landing records its merge commit** (`core_work_items.merge_sha`, from
   `pr.merge`). An episode's **suspects** are the factory's landings in the repository since main
   was last seen green (`core_main_health.green_at`), at most 20, fixed when the episode opens.
2. **The factory names a culprit itself only when it is proven**: exactly one suspect, its merge
   commit is the first red head, and that commit's first parent is the last green head. Then the
   failure can only come from that landing (or a flake). With several suspects, or anything else on
   main in between, there is no culprit until a person (or, later, the babysit job) names one of
   the suspects with `mainRed.attribute`. A revert (ADR 0584) is only ever of a named culprit.
3. **Held on GitHub too (decision 7).** While the line is stopped, `verify.refresh` turns a passing
   `factory/verify` on a non-repair factory item's head into pending, "held: main is red", so
   GitHub's required check refuses a person's merge. When an episode opens or closes,
   `main.observe` re-evaluates the open factory PRs at the merge gate or in delivery
   (`verify.recheck`), and the deliverer re-evaluates a head that still says held just before it
   merges, so a green main never meets a stale held check.

## Consequences
- A push to main that isn't a factory landing is never a suspect, and when one sits between the
  last green and the first red head, nothing is proven.
- Attached PRs are not held on GitHub: their Workflow merges through its own gate (spec 05), which
  a held check would strand. They are still not landed by the babysitter while main is red.
- An outside merge (#134) records no merge commit yet, so it isn't a suspect.
