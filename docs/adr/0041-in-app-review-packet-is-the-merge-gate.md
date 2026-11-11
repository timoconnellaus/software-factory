# ADR 0041: The in-app review packet is the merge gate

Status: accepted, 2026-11-11 (review decisions, [`docs/reviews/2026-11-11-review-decisions.md`](../reviews/2026-11-11-review-decisions.md), answering the [design review](../reviews/2026-11-11-design-review.md)).

## Context
Warp Factories and Symphony review in GitHub. Our pain is review overload; the packet
([ADR 0020](0020-verification-and-review-packet.md)) is designed to let a person decide without
reading the whole diff.

## Decision
- The merge decision is made **in the app, on the review packet**. `pr.merge` is called from the
  packet (or its inbox card) and the factory merges through the App.
- The packet always **links to the GitHub PR** for line comments.
- There is no standalone review-packet experiment; the packet improves through real use. Each PR
  records an **"opened full diff?"** signal (did the approver expand the diff or open the PR before
  deciding), next to the early metrics, to show where packets fall short.

## Consequences
- Merging from GitHub directly is blocked by branch protection unless `factory/verify` passed
  ([ADR 0037](0037-factory-verify-pinned-and-sha-bound.md)); a merge made in GitHub after the factory
  approved is recorded as such.
