# ADR 0044: Kill switch per org and per project

Status: accepted, 2026-11-11 (review decisions, [`docs/reviews/2026-11-11-review-decisions.md`](../reviews/2026-11-11-review-decisions.md), answering the [design review](../reviews/2026-11-11-design-review.md)).

## Context
[ADR 0006](0006-work-item-workflows.md) left the kill switch's scope open; spike ADR 0110 built one
factory-wide switch.

## Decision
- There is a **kill switch per org and per project**. The org switch covers every project in the org.
- Turning one on pauses the affected work items at their next step, stops their runs and releases
  their runner slots; non-human writes to them are refused. Humans can still decide gates.
- Only humans with the org's admin role (org switch) or the project's approver role (project switch)
  can turn a switch on or off, and both actions are audited.

## Consequences
- Resolves the kill-switch part of ADR 0006's open question. Cascade and depth limits are still open.
- The spike's `kill_epoch` becomes per scope.
