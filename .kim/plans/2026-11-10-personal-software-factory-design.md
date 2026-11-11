# Personal software factory: plan

## Goal
A Warp-Factories-style software factory for one person. It has a **cloud control plane on Cloudflare**, **pluggable runners** (Orca is the first runner adapter), and **local Claude sessions that join the factory** rather than bypassing it. Work comes in from anywhere, agents take it through triage, spec, build and verify, and you only step in at the gates (dashboard, phone, and whichever runner UI you use, e.g. Orca).

## Decisions
| Area | Decision | Why / what it implies |
|---|---|---|
| Reference | Warp Factories: coordinating agent + Triage/Spec/Implement/Review, human gates, factory-as-code, dashboard, local takeover | You have the same pains Warp targets |
| Pains | Babysitting, review overload, context switching, away-time, coding before a spec exists, no visibility, per-repo setup | An async coordinating agent, a spec gate, an always-on host, one inbox, presets |
| Build vs buy | **Build your own**. Orca is an integration, not the core | |
| Runners | **Runner = adapter.** The core only knows a runner contract: claim a job, prepare a workspace (repo + branch), start a harness session, stream events, collect artifacts, hand back, report capacity/capabilities. **v1 adapter: `runner-orca`** (Orca worktrees + terminals + browser). Later: plain git-worktree/shell, dev boxes (e.g. Sprites) directly, CF Sandbox, GitHub Actions | The core never imports Orca. Orca-specific features (UI takeover, embedded browser, auto-registering sessions) are optional capabilities the adapter declares |
| Scope | Side projects, client repos, greenfield, maintenance, **content** | Configurable pipelines. Each client is isolated in its own factory/project |
| Autonomy | **Policy per repo/task** using presets + a global floor | Merge, deploy and self-modify always go to you |
| Intake | GitHub, Linear, Slack, chat/CLI, phone, cron, Sentry/logs, **live local sessions** (e.g. Claude in Orca) | Gatekeepers normalise each source into work items |
| Control plane | **Cloudflare**, same pattern as the CRM (Relationship OS) | Always-on intake, storage, state, dashboard and push |
| Coordinating agent | **Hybrid**: a state machine (Cloudflare Workflows) owns the gates; an LLM picks the route within them | Policy is enforced in code, never by a prompt |
| Spec gate | Triage sizes the task. Small/clear tasks skip the spec; bigger ones need your approval | |
| Execution | **The factory schedules and runners execute.** Runtime pool = registered runners, each with capacity and capabilities (v1: an Orca runner on the Mac mini, cap 4) | `.factory/` limits which runners/capabilities a job may use (e.g. client repo: own hardware only). The scheduler fills fixed runners first, then overflows to elastic ones |
| Harnesses | Adapter per agent with a capability manifest. **v1 = Claude Code only** | Codex, pi and OpenCode later |
| Billing | Not the factory's concern; the runner uses whatever agents and credentials it has set up | |
| Verification defaults | Tests/lint/typecheck, CI green, independent reviewer (different model), visual evidence (screenshots via a runner with the `browser` capability, Orca in v1), acceptance criteria checked one by one | Each PR gets a **review packet**. Projects can override |
| Config | Global factory repo (presets) + committed `.factory/` per project | Self-improvement arrives as PRs to these |
| Interaction | Web dashboard + phone push, plus runner UIs (Orca) for local takeover | |
| Metrics | Throughput, cycle time per stage, your gate time, autonomy rate, rework, agent time/tokens, stuck runs | All computed from the audit journal |
| CRM/CF-OS ideas in v1 | Operations registry, invoke pipeline + gate, presets + floor, Workflows, gatekeepers, audit = metrics, outbox → push, signed runner channel, MCP surface, model roles | **Deferred:** simulation, the auto-approver (v1 logs your gate decisions now so it can be calibrated later), per-item grants, extensions |
| Repo practice | AGENTS.md, CONTEXT.md, ADRs, stage specs with acceptance criteria, parallel-work.md, handoff.md, evals/. Used in the factory repo **and** installed into every project via presets (`minimal` → `product`) | The agents depend on these files |
| Repo shape | pnpm + Turborepo: `apps/{app, engine}` (engine = the cloud Worker for Workflows, queues and cron; renamed from the CRM's "runner" so it isn't confused with execution runners), `packages/{core, db, gatekeeper-*, harness-claude, runner-contract, runner-orca, sdk}`, `local/runner-host` (the generic daemon that loads runner adapters), `presets/`, `evals/` | Same as the CRM |

## People and routing (added after the interview)
- **Runners are owned by users.** Examples: your Mac mini Orca, a colleague's laptop Orca, a colleague's Codex Cloud (`runner-codex-cloud`, which wraps `codex cloud exec/status/apply`; it's experimental and has thin capabilities).
- **Work items record a requester.** A placement rule such as `route: requester-first` sends the job to one of the requester's runners that has the needed capabilities, with a fallback to the shared pool or a queue.
- **Credentials and subscriptions stay with the runner's owner.** The factory never holds them; each runner uses whatever its owner is logged into.
- This makes the factory **multi-user** (a small team) rather than strictly personal. It needs identity, a requester/approver role per project, and runner ownership. Open decisions are in the UI interview.

## Auth, orgs and multiple accounts (added)
- **Better Auth** (same as the CRM, `better-auth` 1.7.x) on D1, with the **organization** plugin (orgs, members, roles, invitations) and the **multi-session** plugin (several signed-in accounts in one browser, e.g. personal and work).
- **Hierarchy:** user → org (members + roles) → factories → projects (repos with `.factory/`). Every user gets a Personal org.
- **Cross-account view:** the server enumerates the device sessions, lists orgs and work **per session**, and merges them into an "All factories" view. Each item is tagged with its account and org, and actions run under that item's own session, so permissions never mix.
- **Runners:** owned by users and shared into orgs/factories.
- **Repo access:** via a GitHub App per org (gatekeeper), never via user login tokens.

## Planning and decision domains (added)
- **Planning is built into the product**, using the interviewer patterns: questions with defaults and recommendations, a living spec, mockups and system designs. It's used at triage, spec, agent questions, design review and greenfield kickoff.
- **Decision domains:** `.factory/` maps domains (product, architecture, security…) to owners. Questions and approvals are routed by domain, so a domain expert who isn't an engineer (e.g. a doctor on patientos) decides behaviour and UX, while engineers decide architecture.

## Governed local sessions (beyond what Warp does)
**Principle:** local sessions can do anything locally, but nothing reaches main except through the factory's gate.
1. **Projection.** A committed baseline (generated AGENTS.md/CLAUDE.md section, skills, commands) plus **runtime injection** of the live work item (spec, acceptance criteria, stage) through a SessionStart hook.
2. **Participation.** Every session must be attached to a work item. **Exploring and reading are free.** Once it's clear what the work is, the session itself creates or claims the work item through MCP, which takes a lease so cloud runs back off. It reports its stage and hands back with a handoff summary.
3. **Runner auto-registration (optional capability).** Runners that launch sessions, like Orca, attach them to the work item automatically.
4. **Hooks** (Claude Code): writes, commits and pushes are blocked until a work item is claimed. There are also nudges such as "hand back before stopping", plus a heartbeat that keeps the lease alive.
5. **Remote enforcement.** A required `factory/verify` check (the same review packet) and branch protection apply to every PR, whatever its source.

## MVP (first slice)
CLI/chat intake → triage → implement (Claude Code via the `runner-orca` adapter on the Mac mini) → verify (review packet) → PR in one repo, with gates in a simple web inbox. This proves the core: operations, gate, Workflow, signed runner channel, the runner contract + `runner-orca`, harness-claude, audit and inbox.

## Next steps
1. Set up the repo using the CRM's practice: AGENTS.md, CONTEXT.md glossary (work item, stage, gate, runner, lease, preset, review packet…), and ADR 0001–000N for the decisions above.
2. Write stage specs for the MVP (`docs/stages/01-…`) with acceptance criteria.
3. Define the **runner contract** (operations + capability manifest), then spike `runner-orca` against it using the `orca` CLI (create worktree → start Claude → send prompt → wait → collect output). Check the contract stays Orca-free by sketching a second, plain `runner-local` (git worktree + headless `claude -p`).
4. Spike: a Cloudflare Workflow with a `waitForEvent` gate, driven from a minimal inbox page.
