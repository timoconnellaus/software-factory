# Spec 30: runner-local, the factory runs agents without Orca

Read first: the plan ([`.kim/plans/2026-11-11-run-agents-on-hosts-without-orca.md`](../../.kim/plans/2026-11-11-run-agents-on-hosts-without-orca.md)),
ADRs [0350](../adr/0350-runner-local-tmux-and-hook-status.md), [0014](../adr/0014-runners-are-adapters.md),
[0250](../adr/0250-runner-host-pushes-and-harness-projection.md),
[0260](../adr/0260-runners-attach-to-the-existing-checkout.md) and
[0270](../adr/0270-the-factory-launches-the-harness-and-verifies-it.md); `packages/runner-orca` (what
it replaces) and `local/runner-host`.

This is piece 1 of 8 in the plan. Later pieces (watching and steering from the dashboard, Claude accounts on
a host, a container per job, Linux hosts, web terminal, Sprites sandboxes, chat UI) get their own
specs.

## Goal
`sf-runner` runs every job on a Mac with Orca quit or not installed. Each job gets a git worktree and
a tmux session running Claude Code. A person can `tmux attach` to take it over, and nothing in the
path imports or calls Orca.

## Scope
- **`packages/runner-local`**, a `RunnerAdapter` (runner kind `local`):
  - `prepareWorkspace`: `git worktree add -b <job.branch> <runner worktrees dir>/<sf-jobId> <start point>`
    inside the resolved checkout, then the same steps runner-orca does today: the stale run-branch
    cleanup, the private-files exclude, the git common-dir/git-dir for the sandbox, and
    `projectHarness` with `protectPaths` including the checkout.
  - `startSession`: `tmux new-session -d -s sf-<jobId> -c <worktree> "exec /bin/sh <launch.sh>"` on a
    **dedicated tmux socket** (`tmux -L software-factory`), so the owner's own tmux server and config
    are never touched. It then:
    - answers the folder-trust dialog once (`capture-pane` / `send-keys`);
    - waits for the pid file and the hook's `SessionStart`;
    - runs `verifyLaunch` (a mismatch kills the session and fails with `harness-config-mismatch`);
    - writes `.factory-prompt.md` and sends the one-line `PROMPT_POINTER` with `send-keys` (as #34).
  - **Status from hooks, not the screen:** the projected settings carry a factory status hook on
    `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification`, `Stop`,
    `StopFailure` and `SessionEnd`. It appends one JSON line per event (event, time, tool name and
    a clipped input) to `<runDir>/status.jsonl`, never answers a permission decision, and always
    exits 0 with `{}`. `events()` tails that file:
    - `PreToolUse` → `tool`;
    - `Stop` after the prompt → `session.ended completed` (summary from the transcript);
    - `Notification` of a permission or idle prompt → `waiting_input`, with the same timeout as
      today;
    - tmux session gone → `session.ended` (`completed` if the result file exists, else `failed`).

    Terminal output still streams as `log` events from `capture-pane` deltas.
  - `steer`: `send-keys -l <text>` then `Enter`.
  - `takeover`: `{ label: "Attach in a terminal", hint: "tmux -L software-factory attach -t sf-<jobId>" }`.
  - `collectArtifacts`: the final `capture-pane` screen, plus check output and the final message from
    the transcript (unchanged).
  - `release` (safe twice): kills the tmux session, `git worktree remove --force`, deletes the local
    run branch (run branches only), and removes the run and attachments dirs.
  - `capacity` counts live `sf-*` tmux sessions on the factory socket.
  - Reaping orphans after a crash kills `sf-*` sessions and worktrees whose job the host no longer
    runs.
  - **Manifest:** `hooks`, `ui-takeover`, `own-hardware`, `work-item-attachments`. No `browser` and
    no `auto-register`.
- **`local/runner-host`**:
  - **Checkout resolution (ADR 0260 amended):** `runner.json` gains `checkouts: string[]`, directories
    whose immediate git repos are matched by canonical remote identity. `sf-runner doctor --fix`
    and `login` default it to the parent directories of Orca's repos when Orca is present (a
    one-time migration), else empty. No match → the host's own clone, as today.
  - The host wires `runner-local`; `orcaBin` is ignored. `doctor` checks `tmux` (≥ 3.2), git,
    claude, the channel and the checkouts (one per remote, no orphaned `sf-*` worktrees or
    sessions) instead of Orca. `status` lists live jobs from tmux.
  - The launchd PATH includes tmux.
- **`packages/harness-claude`:** the launch script keeps unsetting `CLAUDE_CODE_PLUGIN_DIRS` (harmless)
  but drops the Orca comments. `transcript.ts` keeps reading Orca's profile homes until piece 3 replaces
  them with the host's accounts. The deny list keeps `orca` and adds `tmux`, so the agent can't drive
  its own or other sessions.
- **Delete `packages/runner-orca`**, its `.factory/checks/` entries (or port them to runner-local), and
  references in `docs/architecture.md`, `CONTEXT.md`, the runner-host README and `docs/handoff.md`.
  ADR 0014 and 0260 get dated amendments, and 0270 a note that the terminal is tmux.

## Out of scope
- Dashboard live view or steering UI (piece 2), multiple Claude accounts (piece 3), containers (piece 4),
  Linux/systemd (piece 5), web terminal (piece 6), Sprites (piece 7), stream-json chat mode (piece 8).
- The `browser` capability (screenshots). Jobs whose evidence needs screenshots report them as
  skipped, as any runner without `browser` does.
- Any change to the runner contract's wire shapes or the engine.

## Acceptance criteria
1. With Orca quit, a build job on the M5 runs end to end: worktree, tmux session, launch verified,
   prompt sent as a file, run branch pushed by the host, and hand-back with artifacts. The PR goes
   green through `factory/verify`.
2. A triage job and a planning session (spec 20, hooks included) also run end to end with Orca quit.
3. `tmux -L software-factory attach -t sf-<jobId>` (the takeover hint shown on the run) attaches to the
   live Claude session. Typing there reaches Claude, and the job still ends and hands back normally.
4. Status comes from the hook file. A test feeds a scripted `status.jsonl` and gets `tool`,
   `agent.status` and `session.ended` events in order. A `Stop` written before the prompt was sent
   doesn't end the job.
5. A live process that doesn't match its launch record is killed before the prompt and the job fails
   with `harness-config-mismatch` (the ADR 0270 check, ported).
6. The owner's default tmux server is untouched: `tmux ls` on the default socket is the same before
   and after a run.
7. `release` called twice leaves no worktree, no `sf-<jobId>` session, no local run branch and no run
   dir. After a killed host, `sf-runner doctor --fix` reaps orphans.
8. A job for a repo under a `checkouts` directory runs as a worktree of that checkout without changing
   its config, remotes, branches or working tree. A repo found nowhere uses the host's own clone.
9. `grep -ri orca packages local --include=*.ts` finds nothing outside comments that explain history,
   `packages/runner-orca` is gone, and `pnpm lint`, `pnpm typecheck` and `pnpm test` pass.
