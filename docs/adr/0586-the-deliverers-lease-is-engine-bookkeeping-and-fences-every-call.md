# ADR 0586: The deliverer's lease is engine bookkeeping, and it fences every call

Status: proposed, 2026-11-12 (spec [53](../specs/53-the-babysitter-delivers-approved-work.md), review of
PR #103). Refines [ADR 0585](0585-one-babysitter-per-repository.md) §1; an exception to
[ADR 0003](0003-operations-registry.md)'s "nothing writes to D1 directly", of the same kind as the
outbox ([ADR 0012](0012-outbox-and-notifications.md)).

## Context
The deliverer's first build claimed `core_delivery_state` by compare-and-set and checked `rev` only
when it released the row. A pass that ran past its 60-second lease kept calling operations after
another pass had taken the queue over, and one could record "left, failed" for an item the other was
merging, sending a merged item back to build. A null repository also named "the whole project", so
`<project>:` and `<project>:<repository>` were two leases over one queue head.

## Decision
1. **One lease per repository.** The key is `<project>:<repository>`. An item with no repository
   is never the babysitter's (`mergeQueue.enter` refuses it, and it could not merge anyway: `pr.merge`
   needs a repository), so there is no project-wide key over the same head.
2. **`rev` is a fencing token.** Every operation the pass calls carries `{ key, rev }` as the
   `lease` invoke option. `invoke()` refuses the call as `fenced` when `rev` is no longer current
   before the handler runs (so nothing is asked of GitHub), and guards it again in the call's own
   batch. A fenced pass stops at once and writes nothing more. The pass renews `running_until`
   (only while its `rev` holds) before each queue head. Idempotency keys carry the `rev`, so a
   refusal recorded for a stale pass never replays to the next one.
3. **The engine writes `core_delivery_state` directly.** It is the deliverer's own scheduling
   state (who holds the queue, when to look again, whether to go round again), not factory state: no
   person or agent reads or decides from it, and no operation's outcome depends on it except through
   the fence above. Like outbox rows, it is written by engine code with plain statements; every
   change to factory state (the queue entry, the merge, the item) still goes through operations as
   the `BABYSITTER` actor.

## Consequences
- The residual window is the one every GitHub side effect has: between a handler's reads and
  GitHub's answer. The fence is read just before the handler, as ADR 0035's fencing is.
- A new engine pass that needs a lease uses the same `lease` option rather than a new mechanism.
