# ADR 0046: Content is cut from v1

Status: accepted, 2026-11-11 (review decisions, [`docs/reviews/2026-11-11-review-decisions.md`](../reviews/2026-11-11-review-decisions.md), answering the [design review](../reviews/2026-11-11-design-review.md)).

## Context
The product plan included content work (non-code pipelines), and spec 04 carried a content
placeholder. The review found the scope had grown well past the MVP.

## Decision
- **Content work is cut from v1.** Pipelines are code pipelines only; no stage produces a draft
  artifact instead of a PR.
- The pipeline still reads its stage list from config, so content can return later without
  changing the gate mechanics.

## Consequences
- Amends ADR 0032 (scope) and spec 04 (the content placeholder is removed).
