# ADR 0008: Autonomy presets and the floor

Status: accepted, 2026-11-11 (from the product plan, `.kim/plans/2026-11-10-personal-software-factory-design.md`).

## Context
Different projects deserve different autonomy: a side project can auto-merge dependency bumps, a
client repo cannot. Borrowed from Relationship OS's Cautious, Balanced and Autonomous presets.

## Decision
- Each project picks a **preset** in its `.factory/` config and may override it.
- The global factory config sets a **floor** that can only tighten what a project allows.
- Merge, deploy and self-modify are `alwaysReview`: they always go to an approver, whatever the preset.
- A malformed or missing policy fails closed.
- Loosening policy is a human-only operation. Agents cannot configure policy.

## Consequences
- Policy is evaluated in the gate ([ADR 0004](0004-invoke-pipeline-and-gate.md)).
- Projects show each resolved value with its source: preset, `.factory/` or floor.
