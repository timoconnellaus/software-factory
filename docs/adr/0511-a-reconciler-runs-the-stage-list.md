# ADR 0511: A reconciler runs the stage list

Status: accepted, 2026-11-12 (the owner, spec 52 question 14; proposed earlier the same day, spec [52](../specs/52-workflows-from-stage-types.md)). Was awaiting
the owner. Would amend [ADR 0006](0006-work-item-workflows.md), [ADR 0053](0053-workflow-versioning.md)
and [ADR 0110](0110-work-item-workflow-and-gate.md).

## Context
Each work item is one Cloudflare Workflow instance that replays `run()` and matches steps by name
(ADR 0006, 0053). Six versions now share one function in `work-item.ts`. With stage lists as data
(ADR 0510), step names would depend on the data and on every stage type's code. Incident #7, an
item waiting for CI that never reported, was a lost event between D1 and the instance's journal.
The factory review (PR #61, item 4) suggested a reconciler, as Optio uses.

## Decision
1. **The item's state of record is D1 only**: the item, one row per stage entry
   (`core_item_stages`) and one per step attempt (`core_item_steps`).
2. **`reconcile(snapshot)` is pure.** It finds the item's stage and calls the stage type's `next()`,
   which returns one action: a job, an operation, a gate, a wait, done, a send-back, fail or reject.
3. **An executor** carries the action out through `invoke()` with an idempotency key
   (`<item>:<stage>:<round>:<step>:<attempt>`), records it, and reconciles again until it waits.
4. **Triggers**: the outbox, for every operation that touches the item; and the minute cron, for
   items whose `next_check_at` has passed, which re-reads the outside world and so heals lost events.
5. **One pass per item at a time**, by a compare-and-set on `reconcile_rev`.
6. **Versioning**: no step-name API. A stage type versions only its persisted step state; each
   stage entry records the type version it started on, and old versions stay until drained.
7. **Rollout**: shadow first, next to Workflow v6, recording divergence; new non-software
   workflows next; Software items only once shadow agrees; v1–v6 drain and are deleted.

## Consequences
- Stage types are tested as tables of snapshots.
- We take on idempotent actions, the tick, the compare-and-set and retries, which Workflows gave
  us for free.
- A type's code change reaches in-flight items at once, so type tests run on recorded snapshots.
- Not measured: how often events are lost, the tick's D1 load, which operations are already
  idempotent, and replay cost on long items. Shadow mode is where these get measured.
- If the owner keeps the replayed Workflow instead, spec 52's alternative A applies: a
  `runStages` version that walks the list, with step names from stage id, round and step id.

> Amended 2026-11-12: **accepted** (the owner's answer to spec 52's question 14). The reconciler runs in shadow beside today's Workflow until it agrees on **20 items in a row** (every transition of 20 consecutive finished items matches, with no divergence); any divergence resets the count. The switch-over of Software items is its own PR, approved by a person. Spec 52's build plan, PR (c).

> Amended 2026-11-12 (second review of spec 52 PR (c1)): what the reconciler does where the first
> version guessed. **Failed attempts are counted across the item, as today's Workflow counts them**:
> a failed job, the checks' send-back, an agent check's or a decision step's send-back; a person's
> send-back at the merge gate, a cancelled run and a moved head are free. The item fails once they
> pass its retry limit (tested against the real Workflow's counters). **A stage, or a send-back's
> target, that the definition no longer has flags the item for a person** (a new `flag` action); it
> never fails it and never restarts it at Triage. **A newer workflow version** applies only between
> stages: at release, the current version when the shaping stages are unchanged, else a person
> chooses (Q4); after that, a tightening or neutral version reaches the item (Q3), a loosening never
> does (a new `repin` action). **The merge approval is tied to the head it was given on**: a push
> after it sends the item back to its checks, free, and the gate opens again. A gate action carries
> its gate spec's `alwaysReview`.
