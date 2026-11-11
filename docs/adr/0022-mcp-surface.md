# ADR 0022: MCP surface

Status: accepted, 2026-11-11 (from the product plan, `.kim/plans/2026-11-10-personal-software-factory-design.md`).

## Context
Local Claude sessions need to create, claim and hand back work items. Borrowed from Relationship OS
ADRs 0021, 0032 and 0042.

## Decision
- `sf-app` serves MCP over OAuth.
- About 10 curated tools (create, claim, report stage, hand back, ask, ...) plus
  `describe_operations` / `call_operation` for the rest of the registry ([ADR 0003](0003-operations-registry.md)).
- The connected session is the actor, with the signed-in user's permissions.

## Consequences
- "Factory, take this session over" and "hand it back" are MCP operations.
