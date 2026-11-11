# V1: the dogfooding factory

**Goal:** the smallest factory that can **build itself**. Once V1 runs, every later feature (R1 milestones, connectors, spend guards, multi-user) is delivered *as work items through the factory*. Every time V1 fails, its own `.factory/` gets fixed. That is the dogfooding loop.

Decided 2026-11-11. This supersedes the R1 milestone order for what gets built first. Nothing is cut from the overall plan; it's sequenced behind V1.

## In V1
| Area | V1 |
|---|---|
| Users | You only. GitHub sign-in (Better Auth), one Personal org, `core_*` tables with `org_id`/actor columns kept for later |
| Projects | **One: `software-factory` itself.** It has its own `.factory/`, with a small autonomy policy and project template |
| Intake | **New work** in the web app (chat-style box). Nothing else |
| Pipeline | One Cloudflare Workflow per work item: triage → (spec) → build → verify → merge gate. Kill switch. Every write goes through the operations registry + invoke pipeline, and is recorded in the audit journal + outbox |
| Triage | LLM triage on a runner sizes the item. Small items skip the spec; the decision is logged with its reason |
| Planning | Planning tab: Question objects (default + recommendation, "accept remaining defaults") and a living spec in stage-spec format. Questions are answered in the app. On approval the spec is committed to the **work item's branch** under `docs/specs/` |
| Runner | `runner-orca` on the **M5** via a generic `runner-host` daemon. It has an outbound signed channel, one branch per run, and a lease with a fencing token. Harness: Claude Code, with a per-run `.claude/settings.json` projected into the worktree |
| Credentials | The cloud mints a **per-job GitHub App token** scoped to the repo and the work item's branch. The runner pushes with it. The harness runs without the owner's git/cloud credentials |
| Verify | Tests/lint/typecheck in the worktree. Read CI from GitHub. An independent reviewer run (role `review`). Acceptance criteria checked one by one. `factory/verify` check run from the App, bound to the head SHA |
| Review | **Review packet in the app is the merge gate**: verdict row, what changed, criteria + evidence, reviewer notes, risk flags, a link to the GitHub PR. Merge / send back from the app; the App performs the merge |
| Improvement loop | A **factory incident** is opened automatically when a PR is sent back or a run fails/stalls. It's a work item in the same project that proposes a fix to **`.factory/`** (check, skill/prompt, context, policy) plus a regression case in `evals/`. In V1 these go through the normal gate (you approve) |
| Visibility | Inbox (waiting on you), work item detail with timeline, runner health line. The audit journal records gate time, send-backs and cycle time; there's no dashboard yet |

## Not in V1 (sequenced after, built *by* the factory)
- **People:** multi-session, more orgs, members, clients as orgs, guests/clarification sessions, decision domains, shared runners, the team view
- **Intake:** GitHub issues/labels, Linear, Slack, Sentry, cron, phone, local-session handoff
- **Governed local sessions:** projection into AGENTS.md/CLAUDE.md, hooks, claim/lease from local Claude. The required `factory/verify` check already guards main
- **Spend:** review-packet spend section, static checks, spend domain, 24h post-deploy watch, the spend anomaly connector
- **Other:** web push and notifications, WIP backpressure, inbox grouping, the Metrics page, preview environments, holdout acceptance tests, other harnesses, dev boxes, other runners, auto-merge of check-only `.factory/` changes, the Jev injection check, passkeys, the native app

## Order after V1
Notifications + backpressure, then holdout tests + spend guards, then GitHub-issue intake, then multi-session + orgs, then decision domains + clarification, then the rest. You can reorder by filing work items.

## Build plan (M5 sessions)
1. **Core + engine:** D1 schema (`core_*`), operations registry + invoke pipeline + audit + outbox (promoted from the workflow spike), the work-item Workflow, the runner job queue + signed channel endpoints, and the GitHub App token minting service. *This one goes first; the others build on its contracts.*
2. **App (after 1):** TanStack Start + shadcn on `sf-app`, Better Auth GitHub sign-in, Inbox, New work, Work item detail with Planning tab, Review packet. Merge and send-back through operations.
3. **Runner (after 1):** promote `runner-orca` + `runner-host` + `harness-claude`, run on the M5, push with the job token, open a PR.
4. **Verify + GitHub connector + incidents (after 1):** App webhook connector, `factory/verify` check run, CI read, reviewer stage, review-packet assembly, the incident flow.
5. **Bootstrap:** `software-factory`'s own `.factory/`, then the first real work item run through the factory end to end.
