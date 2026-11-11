# ADR 0034: Holdout acceptance tests

Status: accepted, 2026-11-11 (review decisions, [`docs/reviews/2026-11-11-review-decisions.md`](../reviews/2026-11-11-review-decisions.md), answering the [design review](../reviews/2026-11-11-design-review.md)).

## Context
Verification is a closed loop: the same system writes the spec, the code, the tests and the
evidence. A reviewer on a different model is only weakly independent when the harness and the
inputs are the same.

## Decision
- When a spec is approved, the verify side writes **holdout acceptance tests** from the acceptance
  criteria, with model role `review`. They are stored with the work item (not on the run branch) and
  never shown to the implementing run.
- The verify stage runs the holdout tests against the built branch. Their results are a section of
  the review packet ([ADR 0020](0020-verification-and-review-packet.md)), next to the implementer's
  own tests.
- A failing holdout test sends the work item back to build with the failure's name and message, not
  the test source.
- Gate time is never reported alone: it is paired with **rework** (send-backs per item) and
  **escaped defects** (work items opened against a merged item within 30 days)
  ([ADR 0011](0011-audit-journal-is-the-metrics.md)).

## Consequences
- Holdout tests are evidence, not proof. Criteria a test cannot check (visual, copy) still rely on
  the reviewer and screenshots.
- A project can turn holdout tests off in its autonomy policy, but not below the floor.
- Open: whether accepted holdout tests are committed to the repo after merge.
