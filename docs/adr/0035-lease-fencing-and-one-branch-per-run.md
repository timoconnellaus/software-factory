# ADR 0035: Lease fencing tokens and one branch per run

Status: accepted, 2026-11-11 (review decisions, [`docs/reviews/2026-11-11-review-decisions.md`](../reviews/2026-11-11-review-decisions.md), answering the [design review](../reviews/2026-11-11-design-review.md)).

## Context
A work item can be held by a cloud run, a local session that takes it over, or a retried run after
a runner went quiet. Leases alone ([ADR 0021](0021-governed-local-sessions.md)) do not stop a holder
whose lease expired from still writing: two runs can race on one branch.

## Decision
- Every successful `lease.claim` returns a **fencing token**: a number that only increases per work
  item. Every write a lease holder makes (events, artifacts, hand-back, the job token's pushes)
  carries it, and `invoke()` refuses a write whose token is not the current one.
- **One branch per run.** A run pushes only to its own branch, `factory/<id>-<slug>-run-<n>`, started
  from the work item branch's head. The work item's PR branch, `factory/<id>-<slug>`, is moved only by
  the control plane, through the App, and only as a fast-forward to the head of a run that handed
  back with the current fencing token. (Not `factory/<id>-<slug>/run-<n>`: git cannot hold a branch
  and a branch "inside" it.)
- Mid-run takeover: a local session's claim bumps the token. The cloud run's next write is refused,
  the runner host stops it, and its slot is released.
- A work item that is paused (at a gate, by takeover or by the kill switch) holds no runner slot.

## Consequences
- Resolves the "mid-run local takeover" part of ADR 0021's open question. Lease length is still open.
- Abandoned run branches are deleted when the work item closes.
- Spec 01's lease criteria and spec 03's branch naming follow this ADR.
