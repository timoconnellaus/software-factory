# ADR 0003: Operations registry is the one API

Status: accepted, 2026-11-11 (from the product plan, `.kim/plans/2026-11-10-personal-software-factory-design.md`).

## Context
The dashboard, the phone, local Claude sessions over MCP and runners all act on the same work items.
If each surface has its own API they drift apart. Borrowed from Relationship OS ADRs 0003 and 0016.

## Decision
Every factory verb is an **operation** defined once in `packages/core` with:
- a name and a model-facing description
- zod input and output schemas
- a risk class ([ADR 0004](0004-invoke-pipeline-and-gate.md))
- the actors allowed to call it

Examples: `workItem.create`, `workItem.claim`, `spec.approve`, `run.start`, `pr.merge`. The
dashboard server functions, the MCP tools ([ADR 0022](0022-mcp-surface.md)) and the runner RPC are
generated from these definitions.

## Consequences
- A new feature starts as operations, so it is available to every surface at once.
- Nothing writes to D1 except through an operation.
- Descriptions are product copy for models and are reviewed as such.
