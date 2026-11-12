# ADR 0493: Shaping stages run before release

Status: accepted, 2026-11-12 (the owner's decision on how workflows work). Spec
[50](../specs/50-projects-backlog-and-release.md) part C. Builds on [ADR 0491](0491-work-starts-in-a-backlog-and-is-released.md);
amends [ADR 0006](0006-work-item-workflows.md) (when the Workflow starts) and [ADR 0300](0300-planning-is-a-live-session-on-a-runner.md)
(when planning runs).

## Context
With ADR 0491, an item's Workflow starts when the factory pulls it, so triage and interview planning
(the live session with questions and the spec gate, spec 20) run after the release and inside the
active limit. The owner wants work shaped before anyone commits the factory to building it: the
plan is approved first, and releasing it is a separate, later decision.

The owner's model: a **workflow is an ordered list of stages**; each stage is an instance of a
**stage type** (code with a fixed contract) with its own settings, and steps happen inside a stage.
A workflow has two **phases** with **release** between them: **shaping** stages (they need a person,
hold no build slot and don't count as active) and **delivery** stages. Only the backlog, the release
(ready → queued) and done are the same for every item. Interview planning is one stage type, not a
universal state. The full stage-type model is its own design (another spec); this ADR fits today's
fixed engine to it.

## Decision
1. **Each stage has a phase.** With today's fixed engine (ADR 0371) the shaping stages are triage and
   interview planning (the spec stage and its gate); everything from build on is delivery
   (`STAGE_PHASE` in core). The board read returns each item's phase.
2. **A person can shape an item before releasing it**: `workItem.shape` starts its Workflow while the
   item is in the backlog or ready. The item's status is `shaping`; it holds no build slot and
   doesn't count against `activeLimit`; its jobs run on the light pool as triage and planning always
   have. Shaping has release's preconditions (a valid config, a chosen workflow, a repository when
   the workflow needs one); only a person may shape for now.
3. **Workflow v7** runs the shaping stages exactly as v6, then a new `release: check` step. An item
   already pulled (released straight from the backlog) goes on at once, as v6 did. A shaped item
   becomes ready (`workItem.shaped`, which notifies its requester) and waits for `release-<item>`
   (`release: wait #k`, re-reading whether it was released on each 12-hour timeout, so an event that
   came early is never lost).
4. **The pull wakes, it doesn't create.** Releasing a shaped item queues it as any other; when the
   pull starts it, it pins delivery's config version and workflow and sends `release-<item>` instead
   of creating a Workflow. The active limit and the waits-for links apply at that moment.
5. **Small items need no shaping**: released from the backlog, they shape inside delivery as before.
6. **A shaped item is released or cancelled**, not moved back to the backlog; its repository is fixed
   once shaping starts (the Workflow already made its branch). Cancelling it stops its Workflow,
   runs and gates like any running item's. A spec rejected while shaping ends the item as rejected.

## Consequences
- The status during shaping is `shaping`, one of the fixed work-management states, not `planning`:
  what runs in it is the workflow's shaping stages, whatever they are.
- v1–v6 instances replay unchanged; v7's step names are frozen in `workflow-versions.test.ts`.
- Known limits of the fixed engine: the shaping stages are exactly triage and interview planning,
  and whether planning runs is still decided by triage's size against `spec.requiredFrom`. Choosing
  stages and their phases per workflow is the stage-type design's.
