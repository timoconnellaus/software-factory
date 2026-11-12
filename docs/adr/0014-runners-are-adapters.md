# ADR 0014: Runners are adapters

Status: accepted, 2026-11-11 (from the product plan, `.kim/plans/2026-11-10-personal-software-factory-design.md`).

## Context
Orca is the first place work runs, but not the last: dev boxes, Cloudflare Sandbox, GitHub Actions
and a colleague's Codex Cloud should all be able to run jobs. The core must not grow Orca-shaped.

## Decision
- The core knows only the **runner contract** (`packages/runner-contract`): claim a job, prepare a
  workspace (repo + branch), start a harness session, stream events, collect artifacts, hand back,
  and report capacity and capabilities.
- A **runner adapter** implements the contract for one execution backend. The v1 adapter is
  `runner-orca` (Orca worktrees, terminals and embedded browser).
- Backend-specific features (UI takeover, embedded browser, auto-registering sessions) are optional
  **capabilities** the adapter declares.
- Later adapters: `runner-local` (git worktree + headless `claude -p`), dev boxes such as Sprites,
  CF Sandbox, GitHub Actions, and `runner-codex-cloud` (experimental, thin capabilities).

## Consequences
- The core never imports Orca. A plain `runner-local` sketch is the check that the contract stays Orca-free.
- Adapters on a machine are loaded by the **runner host** (`local/runner-host`) ([ADR 0016](0016-signed-runner-channel.md)).

> Amended 2026-11-11 (review decisions, [`docs/reviews/2026-11-11-review-decisions.md`](../reviews/2026-11-11-review-decisions.md)): two capabilities join the list: **`hooks`** (the harness runs session hooks, so the
> live work item can be injected and writes blocked until it is claimed) and **`headless`** (the
> runner can run a session with no terminal or UI attached, like `claude -p`). Spike ADR 0100
> (`spikes/runner-orca`) has the contract's types.

> Amended 2026-11-12 ([ADR 0370](0370-runner-local-tmux-and-hook-status.md), spec
> [30](../specs/30-runner-local-without-orca.md)): `runner-local` is now the adapter and
> `runner-orca` is deleted. runner-local is a git worktree plus Claude Code's TUI in a tmux session
> on the factory's own socket (`tmux -L software-factory`), not the headless `claude -p` sketched
> above. Its manifest is `hooks`, `ui-takeover` (takeover is `tmux attach` on the host),
> `own-hardware` and `work-item-attachments`: no `browser` and no `auto-register` until later pieces.
> The core still knows only the contract; the wire shapes didn't change.
