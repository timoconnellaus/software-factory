# Handoff

Where the build stands, for a fresh session. Read this first, then
[`parallel-work.md`](parallel-work.md) if you are building alongside other sessions, then the spec
of whatever you pick up.

Last refreshed: 2026-11-11 (review decisions applied to the docs).

## The product
A software factory on Cloudflare. Work comes in from anywhere, agents take it through triage, spec,
build and verify, and people step in only at gates. Runners are adapters; Orca is the first. Small
team, multi-org (Better Auth). Plan: [`.kim/plans/2026-11-10-personal-software-factory-design.md`](../.kim/plans/2026-11-10-personal-software-factory-design.md).
Architecture: [`architecture.md`](architecture.md). UI: [`ui-plan.md`](ui-plan.md).

## How we work
- Each slice goes interview → spec in `docs/specs/NN-*.md` → build → PR → merge.
- Builds are done by agents in worktrees, briefed from the spec plus this file. Keep a
  `WIP.md` at the repo root while working so a build can be resumed (it is gitignored).
- **Merge commits only, never rebase or force-push.** Resolve conflicts by keeping both sides.
- Parallel builds use **disjoint migration and ADR number ranges** ([`parallel-work.md`](parallel-work.md)).
- Use **Node 24** (`.nvmrc`). Plain `node` on this Mac may be another version: put
  `$HOME/.nvm/versions/node/v24.21.0/bin` first on `PATH`.

## Standing rules
See [`AGENTS.md`](../AGENTS.md). In short: operations first, no ambient authority, policy in code
and not AI-configurable, model roles not ids, runners are adapters, nothing reaches main except
through `factory/verify` and the merge gate. The repo is public: no secrets, no account IDs.

## Merged on main
| PR | What |
| --- | --- |
| Design | Product plan, architecture diagram, UI plan, mockups, design system, research |
| #2 | Spec 00, scaffold: pnpm + Turborepo + Biome, placeholder apps and packages; AGENTS/CONTEXT; ADRs 0001–0032; specs 00–04 and 10–14 |
| #3 | Spike: auth, orgs and multi-session (`spikes/auth-multisession`, proposed ADR 0120) |
| #4 | CI and deploy workflows, provisioning script ([`deploying.md`](deploying.md)) |
| #5 | Spike: Workflow per work item and the gate (`spikes/workflow-gate`, proposed ADR 0110) |
| #6 | Spike: runner contract, `runner-orca` over the `orca` CLI, `runner-local` sketch (`spikes/runner-orca`, ADR 0100) |
| #7 | [Design review](reviews/2026-11-11-design-review.md) |
| #8 | Custom domain and Worker secrets; `sf-app` and `sf-engine` deployed as placeholders (`/api/health` only) |
| #9 | [Review decisions](reviews/2026-11-11-review-decisions.md) |
| #10 | Review decisions applied to the docs: ADRs 0033–0047, amendments to 0001–0032, vocabulary (connector, autonomy policy, project template, Question, `docs/specs/`), R1 specs split into milestones, spec 15 |

## In flight
- Nothing recorded. The spikes are merged; their proposed ADRs (0100, 0110, 0120) move into
  `docs/adr/` when specs 03, 02 and 10 promote them.

## Next
R1 is built in three internal milestones ([`specs/README.md`](specs/README.md)):
1. **(a) Core loop**, one user and one repo: spec 01 first (everything builds on it), then 02 and 03
   in parallel, then 04; 15 and the (a) parts of 10–14 alongside. The security changes (job tokens,
   fencing, `factory/verify` pinning) are part of 03 and 04, not a separate track.
2. **(b) Orgs and multi-session**: the (b) parts of 10–14.
3. **(c) Decision domains, clarification and shared runners**: the (c) parts of 10–14.

First projects to run through the factory: crm (Relationship OS), software-factory (itself),
channel-manager.

## Open questions
Resolved by the review decisions (2026-11-11):
- Kill-switch scope (0006): per org and per project ([ADR 0044](adr/0044-kill-switch-scope.md)).
- How `.factory/` changes reach the control plane (0009): read from the default branch only, cached
  by SHA, refreshed by the push webhook ([ADR 0036](adr/0036-policy-from-the-default-branch.md)).
- What "small" means for skipping the spec (0013): the LLM triage judgement, logged with its reason.
- Mid-run local takeover (0021): the fencing token is bumped and the cloud run stops
  ([ADR 0035](adr/0035-lease-fencing-and-one-branch-per-run.md)).
- Runner push credentials (0025): per-job, repo-scoped App tokens ([ADR 0033](adr/0033-per-job-github-app-tokens.md)).
- Decision domains with no owner (0029): the project approver, as backup owner ([ADR 0042](adr/0042-one-question-object.md)).
- Client as org vs factory (0032): its own org ([ADR 0043](adr/0043-a-client-is-its-own-org.md)).
- Planning scope in v1 (0028): settled by the UI interview and ADR 0042.

Still open:
- How review should work on the first projects (crm, software-factory, channel-manager).
- Cascade and depth limits (0006).
- Token usage reporting (0011).
- Job transport to runners (0016); the runner spike polls on heartbeat.
- Where the model-role map lives (0018).
- Lease length (0021).
- Project template tiers between `minimal` and `product` (0026).
- Whether holdout tests are committed after merge (0034).
- Whether harness subscription terms allow unattended or team use of a runner (0033).
- Whether `presets/` should be renamed now that "preset" is retired as a word.
- Speculative continuation past a gate: designed for (0007), not built in R1.

## Needs the human
- A GitHub App per org, and branch protection requiring `factory/verify` from the App with
  `enforce_admins` on (spec 04).
- The Mac mini set up as the first runner (Orca + Claude Code signed in), with no `gh`, SSH agent or
  cloud credentials visible to the harness (ADR 0033).
- VAPID keys for web push as Worker secrets (spec 15).
