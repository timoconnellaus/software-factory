# ADR 0001: Build our own factory

Status: accepted, 2026-11-11 (from the product plan, `.kim/plans/2026-11-10-personal-software-factory-design.md`).

## Context
Warp Factories shows the shape we want: a coordinating agent, Triage, Spec, Implement and Review
stages, human gates, factory-as-code, a dashboard and local takeover. The pains it targets are ours:
babysitting agents, review overload, context switching, work stalling while we are away, coding
before a spec exists, no visibility, and per-repo setup. Orca already runs agents well on one machine,
so it is tempting to build the factory inside Orca.

## Decision
- We build our own factory. Warp Factories is the reference, not a dependency.
- Orca is an integration, reached through a runner adapter ([ADR 0014](0014-runners-are-adapters.md)). It is not the core.
- The core answers the pains directly: an async coordinator ([ADR 0005](0005-hybrid-coordinator.md)),
  a spec gate ([ADR 0013](0013-triage-sizes-the-spec-gate.md)), an always-on control plane
  ([ADR 0002](0002-cloudflare-control-plane.md)), one inbox ([ADR 0031](0031-dashboard-stack-and-inbox-first.md))
  and presets ([ADR 0008](0008-autonomy-presets-and-floor.md)).

## Consequences
- We own the whole stack and its upkeep, and can shape it to how we actually work.
- Nothing in the core may assume Orca is present.
