# ADR 0491: Work starts in a backlog and is released to the factory

Status: accepted, 2026-11-12. Spec [50](../specs/50-projects-backlog-and-release.md) part B. Amends
[ADR 0006](0006-work-item-workflows.md) (a Workflow per work item, now from its pull, not its
creation) and [ADR 0040](0040-web-push-and-wip-backpressure.md) (adds a limit on active items).

## Context
Creating a work item starts its Workflow at once. People want to write work down before committing
the factory to it, shape it, order it and say what it depends on ("the launch post waits for the
feature"), then hand it over deliberately. Nothing limits how many items are in the pipeline: the
WIP limit only holds builds while items wait at gates.

## Decision
1. **Three states before the pipeline**: `backlog` (captured), `ready` (shaped) and `queued`
   (released, waiting for a slot). No Workflow instance exists in them. Creating an item leaves it in
   the backlog unless the caller asks for more.
2. **Release is an explicit operation**, `workItem.release` (`backlog`/`ready` → `queued`). A person
   may always release. An agent, an intake or a chat may release only when the project's config sets
   `release.agents: true`; it defaults to false and turning it on is a loosening, so only a person
   can (ADR 0370, 0373). The check is in the operation's handler, not a prompt.
3. **One-step create and release** keeps today's paths: `workItem.create { state: "queued" }` runs the
   same rules and the pull in one call (New work, `sf new`). An attached PR and a factory incident
   are created queued and pulled at once: the PR is already built and the incident is the factory's
   own fix, and neither was ever held before.
4. **The factory pulls.** A project's active items (`running`, `waiting`, `paused`) are capped by the
   config's `activeLimit` (default 10). Below it, the next queued item whose "waits for" items are
   all `done` starts, by priority, then manual rank, then release time. The pull pins the config
   version and the workflow then, not at capture. It runs on release, after an item finishes or is
   cancelled, and on the minute cron (a dependency may finish in another project). A kill switch
   holds it.
5. **"Waits for" links** join two items in the same org, any project. No cycles, and only `done`
   satisfies one: a cancelled dependency keeps the item queued and visible as blocked until a person
   removes the link.
6. **`wipLimit` keeps its meaning.** Builds still wait while that many items wait at human gates.

## Consequences
- Every caller that relied on creation starting work passes `state: "queued"` (the app, the CLI, the
  e2e driver, tests).
- Status enums in reads gain three values; old items are untouched.
- A queued item can wait indefinitely on a dependency; the board read shows `blockedBy`.

> Amended 2026-11-12 (review of #69): the pull never runs inside another call's batch. Release,
> finish and cancel ask for it through the outbox (`queue.pull`), and it runs as the new `scheduler`
> actor (read and write only in every policy), so it can't abort a finish and doesn't open an
> approval a minute under `cautious`. Each start is one conditional UPDATE that re-checks the
> active count, the repository and the waits-for links, so concurrent pulls can't pass the limit.
> A trial's items take the candidate version's workflow. Ranks are renumbered when a gap runs out.
