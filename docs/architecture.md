# Architecture

The full picture is the product plan
([`.kim/plans/2026-11-10-personal-software-factory-design.md`](../.kim/plans/2026-11-10-personal-software-factory-design.md))
and the diagram ([`.kim/designs/v1-architecture.d2`](../.kim/designs/v1-architecture.d2), rendered
as [`v1-architecture.svg`](../.kim/designs/v1-architecture.svg)). This page maps it onto the repo.
Decisions are in [`adr/`](adr/); words are in [`CONTEXT.md`](../CONTEXT.md).

## Shape
- **Cloud control plane** on Cloudflare (ADR 0002). `sf-app` serves the dashboard, the MCP surface
  and the operations API. `sf-engine` runs one Workflow per work item, queues and cron. Both share
  one D1 database: work items, questions, audit journal, outbox, leases, Better Auth (CRM-style
  `core_*` tables).
- **Operations** (ADR 0003, 0004) are the only way to change state. Every call goes through
  `invoke()`: validate, gate check (actor × risk class under the project's autonomy policy + floor, read from
  the default branch), fencing token, permission, handler, then one D1 batch with the audit row and
  outbox rows (ADR 0035, 0036).
- **Workflows** own the gates, one per work item; the **foreman** picks a route within them, and
  its decisions are listed as binding or advisory (ADR 0005, 0006). Gates block in v1 and a waiting
  item holds no runner slot.
- **Questions** are the planning object; interview sessions are views over them (ADR 0042).
- **Connectors** are the only path to GitHub, Linear, Slack and other outside systems (ADR 0010).
  The GitHub connector mints a per-job, repo-scoped token for each run (ADR 0033).
- **Runners** execute jobs through the runner contract over a signed, outbound-only channel
  (ADR 0014–0016). A **runner host** on each machine loads **runner adapters** (`runner-orca` first),
  which drive **harnesses** (Claude Code first). Runners are owner-only unless shared through an
  allowlist (ADR 0038), each run pushes its own branch under a fencing token (ADR 0035), and the
  harness runs without the owner's git or cloud credentials (ADR 0033).
- **Local sessions** join the factory through MCP and leases, and nothing they do reaches main
  without the `factory/verify` check, pinned to the App and bound to the head SHA (ADR 0021, 0022,
  0037).
- **Merge** is decided in the app, on the review packet, which links to the GitHub PR (ADR 0041).
- **Notifications** go from the outbox to web push with deep links; a WIP limit applies
  backpressure to the scheduler (ADR 0040).

## Repository layout
| Path | What |
| --- | --- |
| `apps/app` | Worker `sf-app`: dashboard (TanStack Start + shadcn/ui), MCP, operations API |
| `apps/engine` | Worker `sf-engine`: Workflows, queues, cron |
| `packages/core` | Operations registry, `invoke()`, policy, work-item model |
| `packages/db` | D1 migrations and typed access |
| `packages/sdk` | Types for autonomy policies, project templates, stages and `.factory/` config |
| `packages/runner-contract` | The runner contract and capability manifest |
| `packages/harness-claude` | Claude Code harness adapter |
| `packages/connector-webhook` | Inbound webhook connector: verification and dedupe |
| `packages/config` | Shared tsconfig, Biome preset, Vitest preset |
| `local/runner-host` | The runner host daemon (Node, on a person's machine) |
| `presets/` | The shipped autonomy policies, project templates and the floor (directory name kept) |
| `evals/` | Eval suites for benchmarking factory configs |
| `spikes/` | Throwaway spikes. Not in the workspace or Biome |

`packages/runner-orca` arrives when the runner spike is promoted (spec 03). Build specs are in
[`specs/`](specs/).
