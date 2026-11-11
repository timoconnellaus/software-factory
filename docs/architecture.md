# Architecture

The full picture is the product plan
([`.kim/plans/2026-11-10-personal-software-factory-design.md`](../.kim/plans/2026-11-10-personal-software-factory-design.md))
and the diagram ([`.kim/designs/v1-architecture.d2`](../.kim/designs/v1-architecture.d2), rendered
as [`v1-architecture.svg`](../.kim/designs/v1-architecture.svg)). This page maps it onto the repo.
Decisions are in [`adr/`](adr/); words are in [`CONTEXT.md`](../CONTEXT.md).

## Shape
- **Cloud control plane** on Cloudflare (ADR 0002). `sf-app` serves the dashboard and the MCP
  surface, and calls operations on `sf-engine` over RPC (ADR 0051). `sf-engine` runs every operation,
  one Workflow per work item, outbox delivery, the minute cron and the signed runner channel
  (`sf-engine.zerobsai.com/runner/v1/*`). Both bind one D1 database, `software-factory`: work items,
  questions, gates, runs, leases, audit journal, outbox and Better Auth, all `core_*` tables
  (`packages/db/migrations`, ADR 0050).
- **Operations** (ADR 0003, 0004) are the only way to change state. Every call goes through
  `invoke()`: validate, gate check (actor × risk class under the project's autonomy policy + floor, read from
  the default branch), fencing token, permission, handler, then one D1 batch with the audit row and
  outbox rows (ADR 0035, 0036).
- **Workflows** own the gates, one per work item; the **foreman** picks a route within them, and
  its decisions are listed as binding or advisory (ADR 0005, 0006). Gates block in v1 and a waiting
  item holds no runner slot.
- **Questions** are the planning object; interview sessions are views over them (ADR 0042).
- **Connectors** are the only path to GitHub, Linear, Slack and other outside systems (ADR 0010).
  The GitHub connector mints a per-job, repo-scoped token for each run (ADR 0033). Its webhook
  (`software-factory.zerobsai.com/webhooks/github`, served by `sf-engine` through a Workers route)
  checks the signature, dedupes deliveries and maps them to operations: `verify.refresh` on PR and
  CI events, `push.observe` on pushes (branch confinement, the default-branch policy mirror),
  `github.installation` (ADR 0231).
- **Verify** reads CI from GitHub on the head SHA; the review packet passes only with green CI and
  a complete packet, and backs the `factory/verify` check run the App posts for that SHA (ADR 0037,
  0231). Sent-back PRs and exhausted retries open **factory incidents** with a root-cause class and
  a proposed `.factory/` fix plus a regression case in `evals/regressions/`; a check-only fix may
  auto-merge where policy opts in (ADR 0230).
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
| `apps/engine` | Worker `sf-engine`: the work-item Workflow, the runner channel, the GitHub App (tokens, check runs) and its webhook, outbox, cron, `EngineApi` RPC |
| `packages/core` | Operations registry and every V1 operation, `invoke()`, the gate, autonomy policy + floor, `.factory/policy.json` schema, model roles, Workflow event names, verify logic (`verify/`: CI, packet assembly, risk flags, the check-only rule, onboarding), incident classes (`incidents/`), a fake GitHub for tests (`/testing`) |
| `packages/db` | D1 migrations (`core_*`) and typed access (Kysely), batch guards |
| `packages/sdk` | Types for autonomy policies, project templates, stages and `.factory/` config |
| `packages/runner-contract` | The runner contract: adapter interface, capability manifest, wire schemas, signed channel, client, stage results |
| `packages/harness-claude` | Claude Code harness adapter |
| `packages/connector-webhook` | Inbound webhook connector, provider-neutral: signature check, delivery naming |
| `packages/connector-github` | The GitHub App connector: App webhooks → operations |
| `packages/config` | Shared tsconfig, Biome preset, Vitest preset |
| `local/runner-host` | The runner host daemon (Node, on a person's machine) |
| `presets/` | The shipped autonomy policies, project templates and the floor (directory name kept) |
| `evals/` | The `.factory/checks/` format, incident regression cases (`evals/regressions/`) and the suite CI runs over both; benchmarks later |
| `spikes/` | Throwaway spikes. Not in the workspace or Biome |

`packages/runner-orca` arrives when the runner spike is promoted (spec 03). Build specs are in
[`specs/`](specs/).
