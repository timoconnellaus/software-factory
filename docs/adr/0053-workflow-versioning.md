# ADR 0053: Versioning the work-item Workflow across deploys

Status: accepted, 2026-11-11 (V1 core + engine). Answers the ADR 0006 amendment's "Workflow
versioning across deploys".

## Context
A work item can wait at a gate for days. A deploy in between replaces the Workflow's code; a running
instance then replays `run()` with the **new** code, matching completed steps by name. Renaming,
reordering or removing a step breaks the replay.

## Decision
- The first step of every instance is `meta: version`, which returns `WORKFLOW_VERSION` and is
  journaled, so a replay always sees the version the instance **started** on. `run()` dispatches on
  it (`runV1`, later `runV2`); an unknown version errors instead of running the wrong code.
- **Step names are an API.** Any change to v1's steps (name, order, loop structure) is a new version:
  copy the flow to `runV2`, bump `WORKFLOW_VERSION`, keep `runV1` until no instance runs it (check
  `core_work_items.workflow_version` for open items), then delete it in a later release.
- Changes that keep step names and order (prompt text, an operation's internals) need no new version.
- `apps/engine/test/workflow-versions.test.ts` locks v1's step names and tests the dispatcher.
- Steps carry ids and small results (JSON text), never artifacts; large things stay in D1 (or R2
  later) and are read by id.

## Consequences
- An instance started before a deploy finishes on the code path it started with.
- Old versions accumulate until drained; that's the price of never migrating a running instance.

> Amended 2026-11-11 (V1 step 4): v2 adds steps (`verify #b: open PR`, `verify #b: ci…`, `merge #b: auto-merge`) without renaming any. Both versions run the same flow with v2's steps switched off for v1, which is allowed because v1's step sequence is unchanged; `workflow-versions.test.ts` checks it.

> Amended 2026-11-11 (spec 05, [ADR 0290](0290-an-outside-pr-is-attached-and-verified.md)): a new
> **kind** of work item can get its own path (`runAttached` for `attached`), chosen after
> `meta: item` without a version bump. This is allowed only when no running instance can reach the
> new path and other kinds' step sequences are unchanged.

> Amended 2026-11-12 (spec 20, [ADR 0350](0350-how-the-planning-loop-is-wired.md)): v5's spec stage
> is a planning session (`planning: start`, `planning #k: await|ready|escalate|gate|note|end|criteria`)
> instead of the spec rounds. It is the same `runV1` flow with the rounds switched off for v5 and
> the planning steps switched off below it, so v1–v4 replay their step sequences unchanged;
> `workflow-versions.test.ts` locks v5's names.

> Amended 2026-11-12 (proposed, [ADR 0501](0501-a-reconciler-runs-the-stage-list.md), spec [52](../specs/52-workflows-from-stage-types.md)): under the proposed reconciler, step names stop being an API. A work item pins its workflow definition (an org config version) at its first stage, and a stage type versions only its persisted step state; v1–v6 drain under this ADR and are then deleted.
