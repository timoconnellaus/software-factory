# ADR 0047: A Jev prompt-injection check on intake (follow-up)

Status: accepted, 2026-11-11 (review decisions, [`docs/reviews/2026-11-11-review-decisions.md`](../reviews/2026-11-11-review-decisions.md), answering the [design review](../reviews/2026-11-11-design-review.md)).

## Context
Triage reads untrusted intake text (issues, Slack messages, emails) and decides whether the spec
gate is skipped ([ADR 0013](0013-triage-sizes-the-spec-gate.md)). Text written to steer the model
could talk it into a skip.

## Decision
- In R1, LLM triage decides spec skips, and **every skip is logged with its reason**.
- **Follow-up, not built in R1**: a Jev (TypeSafe AI) prompt-injection check on intake text before
  triage. Intake flagged by it never skips the spec gate. It waits for an API key.

## Consequences
- Until the check exists, a skip is visible in the audit journal and on the work item, so a wrong
  skip is caught at the merge gate, which always needs a person.
