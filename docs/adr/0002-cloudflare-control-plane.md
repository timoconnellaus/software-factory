# ADR 0002: Cloudflare control plane

Status: accepted, 2026-11-11 (from the product plan, `.kim/plans/2026-11-10-personal-software-factory-design.md`).

## Context
Intake, state and gates must be available when no laptop is awake. Relationship OS already runs this
pattern on Cloudflare (Workers, D1, Workflows, queues), and we know it well.

## Decision
- The control plane runs on Cloudflare, following the Relationship OS pattern (Relationship OS ADR 0004).
- It owns always-on intake, storage, work-item state, the dashboard, the MCP surface and the outbox.
- Two Workers: `sf-app` (`apps/app`: dashboard, MCP, operations API) and `sf-engine` (`apps/engine`:
  Workflows, queues, cron). One D1 database holds the work-item store and the audit journal.
- Execution does not happen here. Runners do the work ([ADR 0014](0014-runners-are-adapters.md)).

## Consequences
- Configs are account-agnostic: no account or resource ids are committed.
- Long-running agent work never runs inside a Worker request; the control plane only schedules and records it.
