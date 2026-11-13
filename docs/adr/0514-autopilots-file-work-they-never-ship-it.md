# ADR 0514: Autopilots file work; they never ship it

Status: accepted, 2026-11-12 (the owner's addition to the workflow design; design
`docs/design/factory-ui/FactoryAutopilots.html` on PR #61). Not built: spec
[52](../specs/52-workflows-from-stage-types.md) § Autopilots. Amends
[ADR 0006](0006-work-item-workflows.md) (cascade limits) and [ADR 0008](0008-autonomy-presets-and-floor.md).

## Context
Some work should start without a person: triage new backlog items overnight, file a P1 when CI goes
red on main, walk the app weekly, write a digest. Multica's "autopilots run on a schedule" is the
reference. The risk is an agent that creates and ships its own work.

## Decision
1. **An autopilot** is a trigger (a schedule, or an event: CI failing on the default branch, an
   incident opened, an item captured or done), an org agent, its skills, an instruction, a scope of
   projects and an output target (backlog items, labels on backlog items, an inbox digest, or
   proposals). It lives in the org config version.
2. **A run is a hidden work item of kind `autopilot`** with one fixed stage on the light pool, under
   a time limit, an output cap and a daily run cap (and the budget once there is one). Each firing has
   a dedupe key, so one occurrence fires once; an event never fires on an autopilot's own output.
3. **A new actor, `autopilot`**: `merge`, `deploy`, `check-merge` and `self-modify` are **deny** for
   it in every autonomy policy and the floor. It never merges, deploys or changes config.
4. **What it files goes through the same backlog and workflow.** Releasing (`state: "queued"`)
   follows spec 50's rules: only where the project's `release.agents` is true, otherwise the item is
   left `ready`. Labels touch only backlog and ready items. Proposals wait for a person.
5. Creating or enabling an autopilot is a person's config change; one that releases work or widens
   its scope is a loosening.

## Consequences
- Autopilot runs reuse runs, transcripts, watch and steer, usage and the kill switch.
- `core_work_items.kind` gains `autopilot`; boards and `activeLimit` ignore that kind.

> Amended 2026-11-12 (spec 52's answers, questions 18 and 19): a run is a work item of kind `autopilot`, **hidden only from the Work lists**. Each run is a full work item, shown as run history on the autopilot's own page, and anything a run produces for a person (an item it filed, a proposal, a digest) appears in Work or the Inbox linked back to the run. (The owner asked "why hidden?", was given this answer, and didn't object.) Until a budget exists, each **autopilot** has its own limits: a time limit per run, a cap on how much one run can file, and a daily run cap. Items an autopilot files may be merged under `autoApprove` like any other ([ADR 0515](0515-merges-may-be-approved-automatically-dark-factory-mode.md)); the autopilot itself still never merges.

> Amended 2026-11-13 (build step (g1)): the actor, config and operations are built; runs and firing
> are next. The actor's deny is enforced in code before the floor (`AUTOPILOT_NEVER`), so no
> project override can turn it into review or allow. Classification is stricter than §5 says:
> besides releasing work and widening the scope, raising a limit, changing the output kind or the
> backlog project, and widening an event trigger's projects loosen; it is judged whether or not the
> autopilot is on, so widening one while it is off and then turning it on can't slip through.

> Amended 2026-11-13 (review of #197): a change is judged by **reach**, not shape. One that is off
> reaches nothing: changing it is practice, and turning it on loosens, so the person approving sees
> all it would reach; a new one that is on is judged against nothing (it loosens). For one that is
> on, anything that widens what it may do loosens: releasing work or filing closer to running,
> more projects or more projects' events (a schedule fires on no project's events, so schedule →
> event widens), another event kind, a more frequent schedule, another output or project, higher
> limits, another agent, more capabilities or skills, and a rewritten instruction. A property test
> holds that no run of practice or tightening saves ends where one direct change would loosen.
> Turning one off is one tap on the desktop; saving and turning one on take a desktop presence
> proof; the phone stays refused.
>
> Amended 2026-11-13 (second review of #197): a schedule is judged by its **actual fire times**,
> enumerated over 400 days from a fixed epoch in the autopilot's time zone by the one cron evaluator
> (`autopilots/cron.ts`), which the firing code uses too: a change is practice only when the new
> times are a subset of the old; any time it didn't fire before loosens. **Decided:** a time-zone
> change shifts when it fires, so it loosens like any other new time. Any change of trigger kind
> loosens, both ways. Crons the evaluator doesn't fully run (macros, names, `L`/`W`/`#`, reversed
> ranges, anything but ASCII spaces) are refused at save. The agent an enabled autopilot hands to,
> the skills attached to that agent, and the skills it follows are part of its reach: changing them
> loosens, as for an agent that judges work.
>
> Amended 2026-11-13 (third review of #197): schedules are compared in **local calendar space**,
> not by enumerating instants: every (month, day, weekday, hour) a cron could fire at, about 61,000
> checks with no clock, so the answer holds for every year (29 February included) and costs a few
> milliseconds. Same time zone: practice only if every local time the new one fires at, the old one
> did; a time-zone change loosens. Time zones are named IANA zones only (no offsets such as
> +00:07), and a cron that never fires (31 February) is refused at save. The clock is used only for
> the next fire time, which walks local days for up to 9 years and converts only the matches.
> **Daylight saving, decided:** a local time that doesn't exist fires at the first minute after the
> gap; one that happens twice fires once, the first time; the firing's dedupe key is its local wall
> time. A waiting autopilot change carries what it would run with as it is now (its agent and the
> skills it follows), and the desktop's pending screen shows it.
>
> Amended 2026-11-14 (build step (g2a)): **a run's kind has one source of truth, without a table
> rebuild.** `core_work_items.kind`'s CHECK can't be altered, and rebuilding the table for one more
> kind risks dropping columns other branches add, so migration 0284 adds `autopilot_run_id` and a
> virtual generated column `item_kind` (`autopilot` for a run, else the stored kind). Every read that
> branches or filters on an item's kind uses `item_kind`: the stored `kind` is typed so TypeScript
> refuses comparing it, and a test fails on a raw SQL read of it. A run is left out of the Work
> lists, the board and the active limit, and shown in its autopilot's history
> (`core_autopilot_runs`, kept 90 days). Until runners support autopilots (g2b) a run ends at once,
> saying so; `autopilot.fire` exists for the cron and events (g2c) but nothing calls it yet.

