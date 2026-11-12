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
  (`packages/db/migrations`, ADR 0050). `sf-engine` also binds one private R2 bucket,
  `sf-attachments` (`ATTACHMENTS`), for work item attachments' bytes.
- **Operations** (ADR 0003, 0004) are the only way to change state. Every call goes through
  `invoke()`: validate, gate check (actor × risk class under the project's autonomy policy + floor, from
  its current config version, and no looser than the version a work item started under), fencing
  token, permission, handler, then one D1 batch with the audit row and outbox rows (ADR 0035, 0370).
- **Workflows** own the gates, one per work item; the **foreman** picks a route within them, and
  its decisions are listed as binding or advisory (ADR 0005, 0006). Gates block in v1 and a waiting
  item holds no runner slot.
- **Questions** are the planning object; interview sessions are views over them (ADR 0042).
- **Planning** is a live agent session on a runner (ADR 0300): the planning agent works through
  operations over the runner channel (a projected planning MCP server), and kim-style hooks
  (`PostToolUse`, `UserPromptSubmit`, `Stop`) bring answers and chat back from the planning log. It
  holds a light slot (ADR 0301). Mockups render on a sandboxed origin; kept artifacts land in `.kim/`
  with the spec (ADR 0305). Specs 20–25. Wiring (ADR 0350): the planning agent's calls go through one
  channel path, `/runner/v1/jobs/:id/planning`, scoped by the job and fenced by its lease; the
  runner host relays them for the harness, so the runner key never leaves it. Every change is a row
  in the **planning log** (`core_planning_events`, its id the agent's cursor) and a
  `planning.changed` outbox message, which `sf-engine`'s **PlanningHub** Durable Object (one per work
  item) turns into a Server-Sent Event for open Planning tabs (`EngineApi.planningStream`) and a
  wake-up for the agent's held `planning.wait`. The scheduler places jobs by pool: light (triage,
  spec, planning), heavy (build, verify); a resume is pinned to the session's runner.
- **Connectors** are the only path to GitHub, Linear, Slack and other outside systems (ADR 0010).
  The GitHub connector mints a per-job, repo-scoped token for each run (ADR 0033). Its webhook
  (`software-factory.zerobsai.com/webhooks/github`, served by `sf-engine` through a Workers route)
  checks the signature, dedupes deliveries and maps them to operations: `verify.refresh` on PR and
  CI events (and on a PR closing, for attached PRs), `push.observe` on pushes (branch confinement; config is no longer read from git, ADR 0370),
  `github.installation` (ADR 0231), which keeps the org's **installation** records current (ADR
  0055), and `protection.observe` on `repository_ruleset` / `branch_protection_rule` (ADR 0280).
- **Onboarding** never asks for an id the factory can fetch (ADR 0055, 0056): Connect GitHub goes
  through GitHub's install flow back to sf-app's `/integrations/github/setup`
  (`github.connectInstallation` verifies the single-use state and the installation as the App), a
  project is picked from the repos an installation reaches (`github.repos`, `project.create`), its
  first config version is imported from the repo's `.factory/policy.json` or created from the
  template, and a runner connects by device login
  (`/runner/v1/device/*`, approved at `/runners/connect`). `setup.status` is the Setup checklist.
- **Config** (ADR 0370, spec 09): a project's config is a sequence of versions in D1
  (`core_project_policies`, keyed `v<N>`), edited on `/projects/<id>/settings` through
  `config.get` / `config.preview` / `config.save` / `config.rollback` / `config.export`.
  `policyImpact` classifies each change. A loosening save is `self-modify` and is applied when an
  approver approves it. Workflows (ADR 0371) fill the skeleton's three slots, and Workflow v6 runs
  their steps (`workflow.gate`, `workflow.record`). Agents (ADR 0372) carry a role and tier that
  the runner's claim resolves to a model.
- **Protect `main`** (ADR 0280): the App has `administration: read` only, so the factory never changes
  protection. It generates the **default-branch ruleset** as a file (sf-app serves it with
  `Content-Disposition`), a person imports it on GitHub, and `protection.check` / `protection.observe`
  compare GitHub's rulesets and the rules in force on the branch with it. Verdicts live in
  `core_project_protection`; drift (a red after an ok, from a webhook or the daily cron re-check)
  notifies the org's admins and shows in the inbox. A policy may hold builds while it's red.
- **Verify** reads CI from GitHub on the head SHA; the review packet passes only with green CI and
  a complete packet, and backs the `factory/verify` check run the App posts for that SHA (ADR 0037,
  0231). A PR GitHub can't merge into the default branch (so no CI runs on it) goes back to build
  to merge it, and CI that never reports asks a person rather than retrying the build (Workflow v3,
  ADR 0320). An approved merge lands through the project's **merge queue**, one at a time: the
  head is updated with the default branch (GitHub's update-branch), CI runs once on that head,
  and the approval and review packet carry over the clean update (Workflow v4, ADR 0330). Sent-back PRs and exhausted retries open **factory incidents** with a root-cause class and
  a proposed `.factory/` fix plus a regression case in `evals/regressions/`; a check-only fix may
  auto-merge where policy opts in (ADR 0230).
- **Attached PRs** (ADR 0290, spec 05): a PR opened outside the factory fails `factory/verify` with
  a link to sf-app's `/attach`. `workItem.attachPr` gives it a work item of kind `attached`, whose
  Workflow takes its own path (`runAttached`, chosen by kind): triage, spec and build skipped, the
  factory never pushes to the PR's branch, then verify on the PR's head and the merge gate. A push
  (`verify.refresh`) records the new head, withdraws a pending merge gate and wakes the Workflow
  (`pr-head-<item>`). Closing the PR without merging cancels the item.
- **Runners** execute jobs through the runner contract over a signed, outbound-only channel
  (ADR 0014–0016). A **runner host** on each machine loads **runner adapters** (`runner-local`:
  a git worktree and a tmux session per job, ADR 0380), which drive **harnesses** (Claude Code
  first). Agent status comes from the harness's own status hook, and a person takes a run over with
  `tmux -L software-factory attach -t sf-<jobId>`. The work item page's **Live** tab shows a run as
  it goes (spec 31, ADR 0400): `run.live` reads its events (what the agent says, from the
  transcript; its tool calls and status; the terminal), polled every 2 s. The runner's owner can
  **steer** it: `run.steer` queues the message, and the runner host, which keeps a held `steer`
  call open on the channel per running job (woken through the work item's hub), types it into the
  session. Runners are owner-only unless shared through an
  allowlist (ADR 0038), each run pushes its own branch under a fencing token (ADR 0035), and the
  harness runs without the owner's git or cloud credentials (ADR 0033): the runner host, not the
  harness, pushes the run branch with the job token (ADR 0250).
  A runner set to `"isolation": "container"` runs each job's Claude in its own Docker container
  instead (ADR 0430): a self-contained job repo with only the job's history, no home or host
  credentials, egress only through the job's allowlist proxy, every stage `bypassPermissions`, and
  the launch check inside the container. The host still pushes, from the job repo.
  A runner host keeps its own code on the commit `sf-engine` was deployed from (`DEPLOYED_SHA`,
  sent in each heartbeat): it updates itself when idle and rolls back an update that doesn't start
  (ADR 0360).
  A host holds one or more **Claude accounts** (ADR 0410): a login in its own config dir or a token
  in a 0600 file, never sent to the factory. The heartbeat reports their names and the active one;
  the owner picks the active one with `sf-runner account use` or on Setup (`runner.account.use`,
  delivered as `account.use` on the heartbeat response). A job launches with the account that was
  active when its workspace was prepared, and a usage limit it hits is reported against that
  account. Nothing switches accounts on its own.
- **The `sf` CLI** (`local/cli`, ADR 0340) is a surface for people and their agent sessions: it
  calls operations through `sf-engine`'s `/cli/v1` as the person behind a device-login token,
  `read` or `write` scoped. Gate decisions are `browserOnly` operations, which `invoke()` refuses
  off the app, so no token (the CLI's, MCP's) can approve anything.
- **The desktop app** (`apps/desktop`, ADRs 0390–0392, spec 40) is the daily UI on macOS (Electrobun): it
  supervises this Mac's `sf-runner` and calls operations through the same door (`/client/v1`) with a
  desktop token bound to a Secure Enclave device key. It may decide spec, merge and question gates
  only with a per-call presence proof (Touch ID) the door verifies; nothing else on the Mac can make
  one. The website (`sf-app`) shrinks to sign-in, device approval, Connect GitHub and the `/open/*`
  trampoline. A `ClientHub` Durable Object per person holds the app's live socket
  (`/client/v1/live`); the outbox's `notify` messages are pushed through it.
- **Local sessions** join the factory through MCP and leases, and nothing they do reaches main
  without the `factory/verify` check, pinned to the App and bound to the head SHA (ADR 0021, 0022,
  0037). A session's PR that never joined is attached afterwards (ADR 0290).
- **Attachments** (ADR 0310): files on a work item. `sf-app` takes uploads at
  `/api/work/<id>/attachments` and serves files at `/api/attachments/<id>`, both through the
  `workItem.attachment.*` operations as the signed-in person, with server-chosen, sandboxing headers;
  the operations hold the limits, content sniffing and authorization (not-found to anyone outside the
  org). A run lists and fetches its own work item's files over the job channel when its adapter
  declares `work-item-attachments`, and the agent gets them outside the git tree, described as
  labelled untrusted data.
- **Merge** is decided in the app, on the review packet, which links to the GitHub PR (ADR 0041).
- **Notifications** go from the outbox to web push with deep links; a WIP limit applies
  backpressure to the scheduler (ADR 0040).

## Repository layout
| Path | What |
| --- | --- |
| `apps/app` | Worker `sf-app`: dashboard (TanStack Start + shadcn/ui): GitHub sign-in (Better Auth), Inbox, New work, work item detail with Planning (layout A: questions | spec | chat with the gate bar, full screen, phone tabs; live from `/api/work/<id>/planning/live`, spec 20) and Live (the run as it goes, and steering, spec 31), review packet, Setup (a live checklist), the GitHub App's Setup URL `/integrations/github/setup`, `/runners/connect`. Calls operations on `sf-engine` (ADR 0240, 0055). Pinned next to D1; loaders fetch a page's reads in one batched request (ADR 0241). MCP later |
| `packages/ui` | shadcn/ui components and the factory theme (zinc, Geist, status dots) |
| `packages/timeline` | A work item's event log in words: `describeEntry` turns an audit entry into a label, detail, note, actor and dot. Pure, no dependencies; the dashboard's timeline and `sf timeline` both use it (spec wi-4) |
| `apps/engine` | Worker `sf-engine`: the work-item Workflow, the runner channel, the GitHub App (tokens, check runs) and its webhook, outbox, cron, `EngineApi` RPC |
| `packages/core` | Operations registry and every V1 operation, `invoke()`, the gate, autonomy policy + floor, the config schema and versions (`config.*`, `policyImpact`), model roles, Workflow event names, verify logic (`verify/`: CI, packet assembly, risk flags, the check-only rule, onboarding), incident classes (`incidents/`), a fake GitHub for tests (`/testing`) |
| `packages/db` | D1 migrations (`core_*`) and typed access (Kysely), batch guards |
| `packages/sdk` | Types for autonomy policies, project templates, stages and `.factory/` config |
| `packages/runner-contract` | The runner contract: adapter interface, capability manifest, wire schemas, signed channel, client, stage results |
| `packages/harness-claude` | The Claude Code harness: the per-run settings (permission mode and allowlist per stage, the OS sandbox, deny rules, a credential-free environment), the exact launch command and the post-launch check (ADR 0270), the run's Claude account in the launch (ADR 0410), the run's git config, transcript and stream-json parsing |
| `packages/runner-local` | The local runner adapter (ADR 0380): a git worktree of the machine's checkout on the run branch, the harness's launch script in a tmux session on the factory's own socket (verified before the prompt, ADR 0270), status from the harness's hook file (`status.jsonl`), what the agent says from its transcript, steers typed with `send-keys` (ADR 0400), takeover by `tmux attach`, orphan reaping. `src/container/`: a container per job (ADR 0430): the job repo, the Docker runtime, the agent image and egress proxy (`container/`), the container check |
| `packages/connector-webhook` | Inbound webhook connector, provider-neutral: signature check, delivery naming |
| `packages/connector-github` | The GitHub App connector: App webhooks → operations |
| `packages/config` | Shared tsconfig, Biome preset, Vitest preset |
| `local/runner-host` | The runner host daemon `sf-runner` (Node, on a person's machine): heartbeat, claim, the job lifecycle, fetching into the machine's existing checkout (found under `runner.json` `checkouts`; its own clone only as a fallback, ADR 0260), the run-branch push with the job token (ADR 0250), the service (launchd on macOS, a systemd user service on Linux, ADR 0420), `doctor` (tmux, git, claude, checkouts, orphans; on Linux bubblewrap, socat, user systemd, linger; Docker, the image and the credential on a container runner), the host's Claude accounts (`sf-runner account`, ADR 0410) |
| `presets/` | The shipped autonomy policies, project templates and the floor (directory name kept) |
| `evals/` | The `.factory/checks/` format, incident regression cases (`evals/regressions/`) and the suite CI runs over both; benchmarks later |
| `spikes/` | Throwaway spikes. Not in the workspace or Biome |

The first adapter, `runner-orca` (Orca's worktrees and terminals), was replaced by `runner-local`
and deleted (ADR 0380); `spikes/runner-orca` keeps the original spike. Build specs are in
[`specs/`](specs/).
