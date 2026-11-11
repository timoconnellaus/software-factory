# Architecture

The full picture is the product plan
([`.kim/plans/2026-11-10-personal-software-factory-design.md`](../.kim/plans/2026-11-10-personal-software-factory-design.md))
and the diagram ([`.kim/designs/v1-architecture.d2`](../.kim/designs/v1-architecture.d2), rendered
as [`v1-architecture.svg`](../.kim/designs/v1-architecture.svg)). This page maps it onto the repo.
Decisions are in [`adr/`](adr/); words are in [`CONTEXT.md`](../CONTEXT.md).

## Shape
- **Cloud control plane** on Cloudflare (ADR 0002). `sf-app` serves the dashboard, the MCP surface
  and the operations API. `sf-engine` runs one Workflow per work item, queues and cron. Both share
  one D1 database: work items, audit journal, outbox, leases, Better Auth.
- **Operations** (ADR 0003, 0004) are the only way to change state. Every call goes through
  `invoke()`: validate, gate (actor × risk class under presets + floor), permission, handler, then
  one D1 batch with the audit row and outbox rows.
- **Workflows** own the gates; the **foreman** picks a route within them (ADR 0005, 0006).
- **Gatekeepers** are the only path to GitHub, Linear, Slack and other outside systems (ADR 0010).
- **Runners** execute jobs through the runner contract over a signed, outbound-only channel
  (ADR 0014–0016). A **runner host** on each machine loads **runner adapters** (`runner-orca` first),
  which drive **harnesses** (Claude Code first).
- **Local sessions** join the factory through MCP and leases, and nothing they do reaches main
  without the `factory/verify` check (ADR 0021, 0022).

## Repository layout
| Path | What |
| --- | --- |
| `apps/app` | Worker `sf-app`: dashboard (TanStack Start + shadcn/ui), MCP, operations API |
| `apps/engine` | Worker `sf-engine`: Workflows, queues, cron |
| `packages/core` | Operations registry, `invoke()`, policy, work-item model |
| `packages/db` | D1 migrations and typed access |
| `packages/sdk` | Types for presets, stages and `.factory/` config |
| `packages/runner-contract` | The runner contract and capability manifest |
| `packages/harness-claude` | Claude Code harness adapter |
| `packages/gatekeeper-webhook` | Inbound webhook verification and dedupe |
| `packages/config` | Shared tsconfig, Biome preset, Vitest preset |
| `local/runner-host` | The runner host daemon (Node, on a person's machine) |
| `presets/` | Global presets and the floor |
| `evals/` | Eval suites for benchmarking factory configs |
| `spikes/` | Throwaway spikes. Not in the workspace or Biome |

`packages/runner-orca` arrives when the runner spike is promoted (stage 3).
