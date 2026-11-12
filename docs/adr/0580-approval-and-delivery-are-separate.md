# ADR 0580: Approval and delivery are separate; the babysitter delivers

Status: proposed, 2026-11-12 (spec [53](../specs/53-the-babysitter-delivers-approved-work.md));
the owner asked for it, the open points are spec 53's questions. Amends
[ADR 0330](0330-the-factory-runs-its-own-merge-queue.md) and [ADR 0006](0006-work-item-workflows.md);
fits ADR 0515 (dark factory mode, PR #98) and [ADR 0511](0511-a-reconciler-runs-the-stage-list.md).

## Context
In Workflow v4–v7 approving the merge gate makes the item's own Workflow queue, update, wait for CI
and merge (ADR 0330). Each item lands itself, nothing watches `main` afterwards, and a conflict or
a red check after approval always goes back to build. The owner wants a babysitter, modelled on the
patientos one, that merges once a merge is approved, without a cloud routine or any schedule outside
the factory.

## Decision
1. **An approval only says "this head may merge".** Whoever gave it, a person or the workflow's
   `autoApprove` (ADR 0515), the **babysitter** owns everything after: the merge, `main` staying green
   and, once there is a deploy stage, the deploy.
2. **The babysitter has two halves.**
   - **The deliverer** is engine code, no model: a pure reconcile pass per repository over a snapshot
     of `main` and every approved PR, woken by the events the engine already receives (outbox) and the
     minute cron (which heals lost webhooks). It orders, updates, merges with the head pinned, holds
     on a red `main`, and finishes items.
   - **The `babysit` job** (ADR 0583) is a factory job the deliverer starts only for judgement.
3. **Workflow v11.** After approval the item's Workflow enters delivery and waits for one
   `delivered-<item>` event (`merged`, `conflict`, `failed`, `withdrawn`), then ends or goes back as
   today. It never updates or merges. Old versions keep landing themselves until they drain.
4. **Merge commits, one at a time, the engine's own order.** GitHub's merge queue stays out: it is
   for organisation-owned repositories only, needs `merge_group` CI and `factory/verify` on temporary
   SHAs (ADR 0037), and rejects a conflict rather than letting the factory resolve it. With one runner
   the simplest thing that keeps `main` green is ADR 0330's: update the head, CI once, merge, next.
5. **The deliverer acts as `{ type: "agent", id: "babysitter" }`**, the item Workflow's actor type,
   so the gate's approval rules (operation, actor type, work item, once) hold unchanged.

## Consequences
- The merge queue becomes the delivery table; `mergeQueue.*` keep working as aliases.
- One place sees every approved PR of a repository, which is what lets it hold them on a red `main`
  (ADR 0581) and attribute a red `main` to a landing (ADR 0584).
- Throughput stays one merge per CI run per repository; batching is a later choice.
- Under spec 52 this is the built-in `deliver` stage type, the last delivery stage of any workflow
  that merges into a repository; tighten-only.
