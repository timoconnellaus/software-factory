# ADR 0621: A red main's culprit is proven in code or named by a person, never guessed

Status: accepted, 2026-11-13 (spec [53](../specs/53-the-babysitter-delivers-approved-work.md) part e,
decisions 7 and 2). Builds on [ADR 0581](0581-a-red-main-stops-the-line.md) and
[ADR 0584](0584-red-main-is-attributed-then-fixed-or-reverted.md).

## Decision
1. **Every factory landing records its merge commit** (`core_work_items.merge_sha`, from
   `pr.merge`). An episode's **suspects** are the factory's landings in the repository since main
   was last seen green (`core_main_health.green_at`), at most 20, fixed when the episode opens.
2. **The factory names a culprit itself only when it is proven**: exactly one suspect, its merge
   commit is the first red head, that commit's first parent is the last green head, **and the red
   reproduces**: the failing checks are rerun once on that head (core_ci_reruns, once per check per
   SHA) and fail again. Until then it is only a candidate; a green rerun closes the episode and
   records the flake. Who named the culprit is kept (`attributed_by`: proven, person or agent), and
   a weaker attribution never overwrites a stronger one. An agent is only ever the repository's
   babysit job, through the babysitter with its current delivery fence. With several suspects, or anything else on
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
- Attached PRs are held too, reading "main is red: ask the owner" (decision 7 as written; one switch,
  `HOLD_ATTACHED`, while the owner is asked). An attached PR's gate approved while main is red is
  refused by GitHub's required check and waits for a push, as any refused attached merge does.
- Held checks are released by `main.observe` when the episode closes, by the deliverer before it
  merges, and by a minute cron sweep (`releaseHeldChecks`, through the partial index on
  `core_verify_checks.held_at`) for a lost event, a cancelled item or a closed PR: an ended item's
  held check becomes a failure that says it ended.
- An outside merge (#134) records no merge commit yet, so it isn't a suspect.
