# ADR 0020: Verification defaults and the review packet

Status: accepted, 2026-11-11 (from the product plan, `.kim/plans/2026-11-10-personal-software-factory-design.md`).

## Context
Review overload is a core pain. An approver should be able to decide on a PR from one page.

## Decision
- Verification defaults: tests, lint and typecheck; CI green; an independent reviewer on a different
  model; visual evidence (screenshots from a runner with the `browser` capability, Orca in v1); and
  each acceptance criterion checked one by one.
- Every PR gets a **review packet**. Its sections are configured per project in `.factory/`
  (`reviewPacket.sections`): verdict row, what changed, criteria + evidence, reviewer notes,
  screenshots, risk flags, inline diff (collapsed), deploy preview link.
- A required `factory/verify` check and branch protection apply to every PR, whatever its source.

## Consequences
- Projects can override the defaults but not drop below the floor ([ADR 0008](0008-autonomy-presets-and-floor.md)).
