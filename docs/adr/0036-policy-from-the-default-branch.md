# ADR 0036: Policy is read from the default branch only

Status: accepted, 2026-11-11 (review decisions, [`docs/reviews/2026-11-11-review-decisions.md`](../reviews/2026-11-11-review-decisions.md), answering the [design review](../reviews/2026-11-11-design-review.md)).

## Context
[ADR 0009](0009-factory-config-in-git.md) keeps `.factory/` in git. If the control plane read it
from the work item's branch, an agent could loosen its own policy by editing a file in its diff.

## Decision
- The control plane reads `.factory/` (and the global autonomy policies and floor) **only from the
  default branch**, at a recorded commit SHA. Each run records the SHA its policy came from.
- The cache is keyed by that SHA and refreshed by the GitHub push webhook on the default branch.
- **A diff that touches `.factory/` is self-modify** ([ADR 0004](0004-invoke-pipeline-and-gate.md)):
  its merge always goes to a human, and the review packet shows the policy change as a risk flag with
  an impact summary.

## Consequences
- Resolves ADR 0009's open question (how the control plane learns `.factory/` changed).
- A policy change takes effect for new runs after it merges, never for the run that proposed it.
