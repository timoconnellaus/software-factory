# @software-factory/runner-local

The local runner adapter ([ADR 0380](../../docs/adr/0380-runner-local-tmux-and-hook-status.md),
spec [30](../../docs/specs/30-runner-local-without-orca.md)). It implements `RunnerAdapter` from
`@software-factory/runner-contract` with plain git and tmux on the runner host. No desktop app is
involved. The runner host (`local/runner-host`) wires it; nothing in the core imports it.

- **resolveCheckout** / **prepareWorkspace** (ADR 0260, amended): finds the git repo directly under
  one of the configured `checkouts` dirs whose `origin` is the job's `github.com/<owner>/<name>`
  (`src/checkouts.ts`), else uses the host's own clone. It removes a stale local copy of the job's
  branch (only one no worktree has checked out), then runs
  `git worktree add --no-track -b <branch> <worktreesDir>/sf-<jobId> <start point>` in that
  checkout with hooks off. It keeps the harness's private files out of git (`info/exclude`), gives the
  sandbox the checkout's git dir for the run's own git, and projects `harness-claude`'s settings and
  launch script with the checkout in `protectPaths` and the factory's status hook on. A job without
  a repository gets a fresh empty directory, `<worktreesDir>/sf-<jobId>`, instead.
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
    screen (`screen: true`) at most every 10 s.
  - What the agent says streams as `message` events (ADR 0400): the transcript the hook reports is
    tailed from a byte offset, and each assistant text (clipped to 8,000 characters) goes out in
    time order with the hook's events.
- **collectArtifacts**: the final `capture-pane` screen, plus the final message and token usage from
  Claude's transcript.
- **release** (safe to call twice): kills the session, runs `git worktree remove --force` (only ever
  under the worktrees dir), deletes the local branch it created (ADR 0551), and removes the run dir.
  It never touches the checkout otherwise.
- **capacity**: the live `sf-*` sessions on the factory's socket.
- `reapOrphans` / `diagnose` (`src/reap.ts`), for the host's start and `sf-runner doctor`: `sf-*`
  sessions and worktrees without a live job, and two checkouts of one remote.
- `checkRunningHarness(runDir)`: the launch check for a running job, for `sf-runner doctor`.

## Stream-json sessions (`session: "stream-json"`, ADR 0450)
A second session mode beside tmux, in `src/stream.ts` (spec 37). The manifest adds `chat`. Its
events carry tool results and per-turn token counts, which the run view shows.
- **prepareWorkspace**: the same, with the harness projected for a stream session: the launch
  argv ends in `-p --input-format stream-json --output-format stream-json --verbose
  --permission-prompts none`, and the run gets its own `--session-id <uuid>`.
- **startSession**: spawns `/bin/sh <runDir>/launch.sh` with piped stdio in its own process group
  (environment: the host's, credentials dropped). Once the pid file is written and the process is
  no longer the shell, `verifyLaunch` as in tmux (a mismatch kills it). Then `.factory-prompt.md`
  and `PROMPT_POINTER` as the first JSON user message.
- **events**: each stdout line through harness-claude's `streamLineEvents`: `message`, `tool` (with
  `id`), `tool.result`, `turn`, status. A permission request (none should come) is denied. The job
  ends at the `result` that answers its message. The process exiting ends it (`completed` with the
  result file, else `failed`).
- **release** kills the process group; **capacity** counts live stream processes too.
- `fakeStreamClaude` (`@software-factory/runner-local/testing`) is a stand-in `claude` that speaks
  stream-json, for `test/stream.test.ts` and the runner host's tests.
