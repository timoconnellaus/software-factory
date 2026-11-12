# @software-factory/runner-local

The local runner adapter ([ADR 0370](../../docs/adr/0370-runner-local-tmux-and-hook-status.md),
spec [30](../../docs/specs/30-runner-local-without-orca.md)). It implements `RunnerAdapter` from
`@software-factory/runner-contract` with plain git and tmux on the runner host. No desktop app is
involved. The runner host (`local/runner-host`) wires it; nothing in the core imports it.

- **resolveCheckout** / **prepareWorkspace** (ADR 0260, amended): finds the git repo directly under
  one of the configured `checkouts` dirs whose `origin` is the job's `github.com/<owner>/<name>`
  (`src/checkouts.ts`), else uses the host's own clone. It removes a stale local copy of the run
  branch (only a `factory/…-run-<k>` branch no worktree has checked out), then runs
  `git worktree add --no-track -b <run branch> <worktreesDir>/sf-<jobId> <start point>` in that
  checkout with hooks off. It keeps the harness's private files out of git (`info/exclude`), gives the
  sandbox the checkout's git dir for the run's own git, and projects `harness-claude`'s settings and
  launch script with the checkout in `protectPaths` and the factory's status hook on.
- **attachFiles** (`work-item-attachments`, ADR 0310): writes the attachments outside the worktree,
  readable and not editable by the harness. `release` removes them.
- **startSession** (ADR 0270):
  - `tmux -L software-factory -f /dev/null new-session -d -s sf-<jobId> -c <worktree>
    "exec /bin/sh <runDir>/launch.sh"`. That is the factory's own tmux server, without your
    `~/.tmux.conf`. The pane stays after Claude exits (`remain-on-exit`), so its last screen can be
    read.
  - Answers Claude's folder trust dialog once (`capture-pane`, `send-keys Down Enter`).
  - Waits for the launch script's pid file and the hook's `SessionStart`.
  - Checks the live process against the launch record (`verifyLaunch`). On a mismatch it kills the
    session and fails with `harness-config-mismatch`.
  - Writes `.factory-prompt.md`, then types the one-line `PROMPT_POINTER` and presses Enter. It waits
    for the hook's `UserPromptSubmit`, pressing Enter again every 5 s, for up to 30 s.
  - Takeover hint: `tmux -L software-factory attach -t sf-<jobId>`.
- **events**: tails `<runDir>/status.jsonl`, which the harness's status hook writes:
  - `PreToolUse` gives a `tool` event.
  - `UserPromptSubmit`, `PreToolUse` and `PostToolUse` set `working`.
  - A permission, idle or elicitation `Notification` sets `waiting_input`. The run fails after
    15 minutes of it.
  - `StopFailure` sets `error`.
  - `Stop` after the prompt was submitted ends the session as `completed`, with the transcript's last
    message as the summary. A `Stop` from before then is ignored.
  - `SessionEnd`, or the tmux session gone or dead, ends it: `completed` if `.factory-result.json`
    exists, else `failed`.
  - Terminal output streams as `log` events: lines that scrolled into tmux history, and the visible
    screen at most every 10 s.
- **collectArtifacts**: the final `capture-pane` screen, plus the check output and final message from
  Claude's transcript. There is no `browser` capability, so screenshot evidence is skipped.
- **steer**: `send-keys -l <text>`, then `Enter`.
- **release** (safe to call twice): kills the session, runs `git worktree remove --force` (only ever
  under the worktrees dir), deletes the local run branch (run branches only), and removes the run and
  attachments dirs. It never touches the checkout otherwise.
- **capacity**: the live `sf-*` sessions on the factory's socket.
- `reapOrphans` / `diagnose` (`src/reap.ts`), for the host's start and `sf-runner doctor`: `sf-*`
  sessions and worktrees without a live job, and two checkouts of one remote.
- `checkRunningHarness(runDir)`: the launch check for a running job, for `sf-runner doctor`.

`src/testing.ts` (`@software-factory/runner-local/testing`) is a scripted tmux for tests. Git stays
real. `test/tmux.integration.test.ts` runs the adapter on the real tmux, on its own socket, with a
stand-in `claude`. It is skipped when tmux isn't installed.
