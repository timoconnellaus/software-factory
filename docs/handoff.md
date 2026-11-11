# Handoff

Where the build stands, for a fresh session. Read this first, then
[`parallel-work.md`](parallel-work.md) if you are building alongside other sessions, then the spec
of whatever you pick up.

Last refreshed: 2026-11-11 (scaffold and docs).

## The product
A software factory on Cloudflare. Work comes in from anywhere, agents take it through triage, spec,
build and verify, and people step in only at gates. Runners are adapters; Orca is the first. Small
team, multi-org (Better Auth). Plan: [`.kim/plans/2026-11-10-personal-software-factory-design.md`](../.kim/plans/2026-11-10-personal-software-factory-design.md).
Architecture: [`architecture.md`](architecture.md). UI: [`ui-plan.md`](ui-plan.md).

## How we work
- Each stage goes interview → spec in `docs/stages/NN-*.md` → build → PR → merge.
- Builds are done by agents in worktrees, briefed from the stage spec plus this file. Keep a
  `WIP.md` at the repo root while working so a build can be resumed (it is gitignored).
- **Merge commits only, never rebase or force-push.** Resolve conflicts by keeping both sides.
- Parallel builds use **disjoint migration and ADR number ranges** ([`parallel-work.md`](parallel-work.md)).
- Use **Node 24** (`.nvmrc`). Plain `node` on this Mac may be another version: put
  `$HOME/.nvm/versions/node/v24.21.0/bin` first on `PATH`.

## Standing rules
See [`AGENTS.md`](../AGENTS.md). In short: operations first, no ambient authority, policy in code
and not AI-configurable, model roles not ids, runners are adapters, nothing reaches main except
through the factory gate. The repo is public: no secrets, no account IDs.

## Merged on main
| Stage | What |
| --- | --- |
| Design | Product plan, architecture diagram, UI plan, mockups, design system, research |
| 00 | Scaffold: pnpm + Turborepo + Biome, placeholder apps and packages; AGENTS/CONTEXT; ADRs 0001–0032; stage specs 00–04 and 10–14 |

## In flight
- Spikes under `spikes/` (runner contract + `runner-orca` via the `orca` CLI, a `runner-local`
  sketch, a Workflow `waitForEvent` gate driven from a minimal inbox page). Their write-ups feed
  stages 02 and 03.

## Next
1. Stage 01 (operations and store). Everything else builds on it.
2. Stages 02 and 03 in parallel once 01 lands and the spikes are written up; then 04.
3. R1 UI (stages 10–14). Stage 10 can start alongside 01.

## Open questions (from the ADRs)
Recorded under each ADR's Consequences: cascade/depth limits and kill-switch scope (0006), how
`.factory/` changes reach the control plane (0009), token usage reporting (0011), what "small"
means for skipping the spec (0013), job transport to runners (0016), where the model-role map
lives (0018), lease length and mid-run local takeover (0021), runner push credentials (0025),
preset tiers (0026), decision domains with no owner (0029), client as org vs
factory (0032).

## Needs the human
- A GitHub App per org, and branch protection requiring `factory/verify` (stage 4).
- The Mac mini set up as the first runner (Orca + Claude Code signed in).
- A Cloudflare account for the first deploy (nothing in the repo is account-specific).
