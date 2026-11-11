# ADR 0016: Signed runner channel

Status: accepted, 2026-11-11 (from the product plan, `.kim/plans/2026-11-10-personal-software-factory-design.md`).

## Context
Runner hosts sit on home networks and laptops. They must not expose a port, and the control plane
must trust what they report. Borrowed from Relationship OS ADR 0250.

## Decision
- The runner host only connects outbound to the control plane.
- Every call in either direction is signed with HMAC over the method, path, body hash and timestamp,
  valid for 5 minutes, and idempotent.
- Each runner has its own key, issued when it registers.

## Consequences
- A runner can be revoked by rotating its key.
- Open question: transport for job assignment (long poll, WebSocket to a Durable Object, or queue pull).

> Amended 2026-11-11 (review decisions, [`docs/reviews/2026-11-11-review-decisions.md`](../reviews/2026-11-11-review-decisions.md)): a replayed request id is **answered from the idempotency store**, not refused: the host
> gets the first response again (spike ADR 0100). A bad signature or a stale timestamp is still
> refused. Each job assignment carries its per-job repo token
> ([ADR 0033](0033-per-job-github-app-tokens.md)) and the current fencing token
> ([ADR 0035](0035-lease-fencing-and-one-branch-per-run.md)).

> Amended 2026-11-11 (V1 core + engine): built in `sf-engine` at `https://sf-engine.zerobsai.com/runner/v1/*`
> ([ADR 0100](0100-runner-contract.md) as promoted). Transport for job assignment (open question):
> **pull**, heartbeat then claim. Keys are derived from `RUNNER_CHANNEL_SECRET` and a per-runner
> version, shown once by `runner.register`; `runner.rotateKey` revokes the old one. The job token
> call is the one call whose answer is never stored ([ADR 0052](0052-job-tokens-and-branch-confinement.md)).
