# ADR 0585: One babysitter per repository; it fails safe

Status: proposed, 2026-11-12 (spec [53](../specs/53-the-babysitter-delivers-approved-work.md)).
Applies [ADR 0035](0035-lease-fencing-and-one-branch-per-run.md) and [ADR 0511](0511-a-reconciler-runs-the-stage-list.md)
per repository.

## Context
patientos needs a lease so that two routine sessions don't both repair `main`. Two mergers are
harmless (a pinned head refuses the second); two repairs are not.

## Decision
1. **`core_delivery_state`, one row per repository**: `rev` for the deliverer's compare-and-set (one
   pass at a time), and the open `babysit` job with a **delivery fence** that increases with each job.
   Every `babysit` write carries the fence; a stale one is refused.
2. **A job that dies** fails like any job; its reasons are still open, so the next pass starts a new
   job with a higher fence and a note of what the last one recorded. A pushed but unadvanced
   resolution is offered to it, never advanced blindly.
3. **A merge GitHub refuses means the snapshot is stale**: re-snapshot and decide again, never retry
   the same call. Three refusals of an unchanged head with an unchanged snapshot go to a person and
   let the next delivery go.
4. Every deliverer action has an idempotency key (`<repo>:<delivery>:<action>:<head>`); a pass that
   throws changes nothing and the cron's next pass starts over.

## Consequences
- No lease to renew by hand and nothing that must be released: the row is the lease, and the job's
  own runner lease covers the job.
