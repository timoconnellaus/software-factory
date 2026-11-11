# ADR 0051: Operations run in sf-engine; sf-app calls them over RPC

Status: accepted, 2026-11-11 (V1 core + engine).

## Context
Operations ([ADR 0003](0003-operations-registry.md)) write state and emit outbox rows that must be
delivered to Workflows (start an instance, send a gate event, pause, resume). The Workflow binding
lives on `sf-engine`. `sf-app` (dashboard, MCP) authenticates people.

## Decision
- `invoke()` is a library in `packages/core` and can run anywhere with the D1 binding, but **in V1
  every operation runs in `sf-engine`**: `sf-app` calls the engine's `EngineApi` RPC entrypoint
  through a service binding (`invoke(name, input, { actor, origin, idempotencyKey })` and
  `describeOperations()`), so outbox rows are delivered right after commit by the Worker that holds
  the Workflow binding. The cron retries anything that failed.
- The caller sets the actor; RPC is trusted because it is only reachable through a service binding.
  `sf-app` sets `{ type: "human", id: <user id> }` from the signed-in session. The runner channel sets
  `{ type: "runner", id }` from the verified signature; the Workflow sets the foreman
  (`{ type: "agent", id: "foreman" }`); the cron uses the foreman too.
- RPC refusals come back as values (`{ ok: false, error: { code, message, details } }`), because
  error types don't survive RPC.
- Reads (risk `read`) are operations too (`workItem.get`, `inbox.list`, …) so permissions apply in one
  place; they are not audited.

## Consequences
- `sf-app` needs no Workflow binding and no outbox code.
- `sf-app` binds the same D1 database (`software-factory`) for Better Auth; it doesn't write factory
  tables directly.
- A later MCP surface calls the same RPC.
