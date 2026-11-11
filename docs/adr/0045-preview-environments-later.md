# ADR 0045: Preview environments later, never against prod data

Status: accepted, 2026-11-11 (review decisions, [`docs/reviews/2026-11-11-review-decisions.md`](../reviews/2026-11-11-review-decisions.md), answering the [design review](../reviews/2026-11-11-design-review.md)).

## Context
The review packet has a "deploy preview link" section ([ADR 0020](0020-verification-and-review-packet.md)).
A preview that talks to production D1, KV or R2 would let unreviewed code touch real data.

## Decision
- Preview deploys are **not in R1**.
- When they arrive, each preview uses **separate preview D1, KV and R2** resources, seeded with test
  data. A preview never binds production data.

## Consequences
- The "deploy preview link" packet section stays hidden until previews exist.
