# ADR 0504: Autopilots file work; they never ship it

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
