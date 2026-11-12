# ADR 0370: Runners run agents in tmux, without Orca; status comes from hooks

Status: accepted, 2026-11-12. Plan:
[`.kim/plans/2026-11-11-run-agents-on-hosts-without-orca.md`](../../.kim/plans/2026-11-11-run-agents-on-hosts-without-orca.md).
Spec [30](../specs/30-runner-local-without-orca.md). Amends [0014](0014-runners-are-adapters.md),
[0260](0260-runners-attach-to-the-existing-checkout.md) and
[0270](0270-the-factory-launches-the-harness-and-verifies-it.md).

## Context
`runner-orca` was the only adapter. It ties every run to a desktop app: Orca's worktree list, its
terminals and its screen-derived agent state. The factory uses a thin slice of that, and the owner
wants more control over how runs execute, are watched and are isolated. The factory should run
agents on hosts: the owner's Macs now, then Linux servers and Sprites sandboxes.

## Decision
1. **`runner-local` replaces `runner-orca`, which is deleted.** A job is a plain `git worktree` plus a
   **tmux** session on a dedicated socket (`tmux -L software-factory`) running harness-claude's launch
   script. tmux maps one for one onto what runner-orca used: `new-session` for terminal create,
   `send-keys` for send, `capture-pane` for read, `attach` for takeover. It works the same on macOS,
   Linux and over ssh.
2. **Agent status comes from Claude Code hooks, not the screen.** The factory projects its own status
   hook, which appends events to `<runDir>/status.jsonl` and never answers a permission decision.
3. **Checkouts are found by configured directories and canonical remote identity** (ADR 0260's rule,
   minus Orca's repo list), with the host's own clone as the fallback.
4. **Sessions are pluggable behind the adapter.** tmux comes first. A stream-json session mode for a
   dashboard chat UI comes later as a second mode, not a replacement (plan piece 8).

## Consequences
- No `browser` capability until a later piece adds headless screenshots. `auto-register` goes with
  Orca.
- Takeover is `tmux attach` on the host. Watching and steering from the dashboard, and a web
  terminal relayed through sf-engine, are later pieces.
- Isolation is unchanged (worktree + Claude Code's OS sandbox, ADR 0270). A container per job is
  plan piece 4.
- Claude accounts: Orca's per-profile config dirs stay readable until plan piece 3 adds accounts on
  the host, with manual switching.
