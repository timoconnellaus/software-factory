# ADR 0017: Harness adapters

Status: accepted, 2026-11-11 (from the product plan, `.kim/plans/2026-11-10-personal-software-factory-design.md`).

## Context
A runner starts an agent CLI inside a workspace. Agent CLIs differ in hooks, output formats and features.

## Decision
- A **harness** adapter per agent CLI, with a capability manifest (`packages/harness-claude` first).
- v1 supports Claude Code only. Codex, pi and OpenCode come later.
- Billing is not the factory's concern: a runner uses whatever agents and credentials its owner has set up.

## Consequences
- The factory never stores model provider keys or subscriptions.
- Rules that need two harnesses (an independent reviewer, [ADR 0018](0018-model-roles.md)) only warn until a second harness exists.

> Amended 2026-11-11 (review decisions, [`docs/reviews/2026-11-11-review-decisions.md`](../reviews/2026-11-11-review-decisions.md)): the harness runs **without the owner's git or cloud credentials**; only the model
> subscription stays the owner's ([ADR 0033](0033-per-job-github-app-tokens.md)). For unattended
> Claude permissions, `harness-claude` projects a **per-run `.claude/settings.json`** (allowed tools,
> denied commands, hooks) into the workspace now; it moves to Orca launch args once Orca supports them.

> Amended 2026-11-11 ([ADR 0270](0270-the-factory-launches-the-harness-and-verifies-it.md), incident
> 2026-11-11 bootstrap #6): the harness owns its launch command and verifies the live process
> after launch. Claude starts with `--permission-mode <stage mode> --setting-sources project,local
> --settings <run settings>` from a launch script the runner runs as is, never through a launcher
> that adds its own agent flags (`orca agent launch` added the owner's `--permission-mode auto`).
> Every stage runs in Claude Code's sandbox. Orca launch arguments, once they exist, change only how
> the script is started; the check stays.
