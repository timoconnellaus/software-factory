# Ideas to borrow from Relationship OS + Cloudflare OS

Sources: `~/orca/projects/crm` (ADRs, AGENTS.md, CONTEXT.md, packages) and `github.com/cloudflare/cloudflare-os` (README, AGENTS.md, gatekeeper-kit).

## Architecture patterns

1. **Every factory verb is a registered operation.** CRM: `defineOperation` (ADR 0003/0016). Each operation (`workItem.create`, `spec.approve`, `run.start`, `pr.merge`) is defined once, with zod schemas, a description and a risk class. The dashboard API, the MCP tools and the runner RPC are all generated from that definition, so the UI, phone, Claude Code and the runner can never drift apart.
2. **One `invoke()` pipeline + gate.** CRM: ADR 0018. Each call is validated, then checked by the gate (actor × risk class), then by permissions, then handled. The write, its audit row and an outbox row commit in one batch. Actors: `human`, `agent`, `runner`, `intake`, `self-improve`. Risk classes: `read`, `write`, `spend`, `outbound` (push/comment/PR), `merge`, `deploy`, `self-modify`.
3. **Presets + floor = per-project autonomy.** CRM: Cautious, Balanced and Autonomous presets. `.factory/` picks a preset, the global config acts as a floor that can only tighten it, a malformed policy fails closed, and `alwaysReview` operations (merge, deploy, self-modify) are reviewed no matter what.
4. **Human gates are pending actions, so agents don't block.** CRM ADR 0022/0032 + Cloudflare OS "simulate now, approve later". When a spec is proposed, the agent gets back `pending_approval`, and work can continue speculatively. Approving re-runs the action as the original actor and fails cleanly if the base branch moved. Rejecting cascades to the actions that depended on it. Approvals can be done in bulk from the inbox.
5. **Each work item is a Cloudflare Workflow.** CRM ADR 0028/0130. The Workflow id is derived from the intake event (idempotent), gates are `waitForEvent('approval-<id>')`, and there is a **kill switch** that pauses everything, plus cascade and depth limits for agents that spawn agents.
6. **Autonomy policy as an adjudicator, in shadow mode first.** CRM ADR 0031/0204 + `evals/adjudicator`. Each project has a written, versioned policy, e.g. "auto-approve dependency bumps with green CI". The adjudicator can approve but **never reject**: a "no" goes to you. It never approves merge, deploy or self-modify. It judges the diff, not the agent's explanation. Shadow mode measures how often it agrees with you, and it only switches to active once it reaches ≥0.95 precision. **This is how review overload safely shrinks over time.**
7. **Gatekeepers for intake + outbound.** CRM `gatekeeper-webhook` + the Cloudflare OS gatekeeper concept. Webhooks from GitHub, Linear, Slack, Sentry and phone are signature-verified and deduplicated into typed events, which become work items. Outbound GitHub comments and PRs are journaled actions keyed by `actionKind`, and some kinds can be marked `autoApprovable` (e.g. labelling an issue). **Agents never hold raw tokens.**
8. **Capability introduction, not ambient access.** Cloudflare OS. An agent run only gets the repos and services its work item is granted. It can *request* more, and you grant it. This matters for keeping client repos isolated.
9. **Audit journal = the metrics.** CRM ADR 0017. Every operation writes an append-only row with the actor, origin, gate decision and diff. Cycle time, your gate time, autonomy rate, rework and spend are SQL views over that journal. There's no separate analytics system.
10. **Outbox → notifications.** CRM ADR 0171/0206. The notification event is written in the same batch as the state change, so a push is never lost. Unread approvals escalate, there's a daily digest, you approve with a tap (two-step for high-risk items), and duplicate approvals are idempotent.
11. **Signed runner channel.** CRM ADR 0250. Calls between Cloudflare and the Mac mini runner (and later dev boxes) are signed with HMAC over the method, path, body hash and timestamp, valid for 5 minutes, and idempotent. The runner only connects outbound.
12. **MCP surface for local Claude Code.** CRM ADR 0021/0032/0042. Claude Code connects with OAuth and gets about 10 curated tools plus `describe_operations` / `call_operation`. The connected session is the actor. **This is how "factory, take this session over" and "hand it back" work.**
13. **Model roles, not model ids.** CRM ADR 0009. Config names roles like `triage`, `implement`, `review` and `summarise`. "The reviewer must be a different model/harness" becomes a setting that warns you when it's violated.
14. **Stages, agent profiles and skills as extensions.** CRM `defineExtension`, ADR 0041. They're defined with `defineStage` / `defineAgentProfile`, declared permissions and a contract version. Self-improvement goes working copy → check → propose, and arrives as a **PR with an impact summary** (e.g. "widens permissions: merge"). Anything that widens permissions always waits for you. A stage that fails 3 times is **quarantined** and rolled back to last-known-good. Global presets are the "shipped extensions", and a project can extend or eject them.

## Repo practice (copy wholesale, and have the factory set it up in every project)

15. **AGENTS.md non-negotiables** (operations first, no ambient authority, policy is not AI-configurable, roles not model ids), with `CLAUDE.md` = `@AGENTS.md`.
16. **CONTEXT.md glossary** with *Avoid:* synonyms. Agents reuse the exact terms.
17. **ADRs** that are only amended with dated notes and never deleted. **Stage specs** (`docs/stages/NN-*.md`) with Read first, Goal, Scope, Out of scope and **Acceptance criteria = definition of done**. The factory's spec agent writes in this exact format, and the verifier checks those criteria.
18. **parallel-work.md**: claim number blocks for migrations and ADRs, a reserved-areas table, and a list of files known to conflict. This lets the factory run parallel agents on the same repo without collisions.
19. **handoff.md + WIP.md**: what's merged, what's in flight, what's next, and "needs the human". This is the format for the hand-off between factory and local.
20. **evals/** with recordings, replay and dated reports, used to benchmark factory configs (Warp's "benchmarks").
21. **Mechanical guards** in scripts: import-boundary checks, upstream-sync checks, golden tests. These are cheap verification layers to put in every project.

## Probably overkill for a personal factory
- Multi-tenant control (`apps/control`, Workers for Platforms, billing, fleet rollouts).
- The Dynamic Worker extension runtime and schema reconciler. Factory extensions are config, prompts and skills that run on Orca, and git, PRs and CI already give you a workspace and a check step.
- Provisional-ID simulation overlays. A git branch already is a simulation.
- Full Cloudflare OS OAuth connect flows and resource pickers. Thin signed webhooks plus Worker secrets are enough for one user.
- Identity adapters, teams and the GDPR/erasure machinery.
- Signed release bundles and the installer CLI. Deploying with wrangler from source is enough until the factory updates itself.
