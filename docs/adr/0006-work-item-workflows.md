# ADR 0006: One Workflow per work item

Status: accepted, 2026-11-11 (from the product plan, `.kim/plans/2026-11-10-personal-software-factory-design.md`).

## Context
Work items wait hours or days at gates and must survive restarts and deploys. Borrowed from
Relationship OS ADRs 0028 and 0130.

## Decision
- Each work item is one Cloudflare Workflow instance in `sf-engine`.
- The Workflow id is derived from the intake event, so a duplicate event never starts a second run.
- Gates are `waitForEvent('approval-<id>')`.
- A **kill switch** pauses every Workflow. Agents that spawn work items are bound by cascade and
  depth limits.

## Consequences
- Gate waits cost nothing while idle.
- Open question: the exact cascade and depth limits, and whether the kill switch is per org or global.
