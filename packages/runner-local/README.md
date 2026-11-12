# @software-factory/runner-local

The local runner adapter ([ADR 0380](../../docs/adr/0380-runner-local-tmux-and-hook-status.md),
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
    screen (`screen: true`) at most every 10 s.
  - What the agent says streams as `message` events (ADR 0400): the transcript the hook reports is
    tailed from a byte offset, and each assistant text (clipped to 8,000 characters) goes out in
    time order with the hook's events. Earlier turns of a resumed conversation are skipped.
- **collectArtifacts**: the final `capture-pane` screen, plus the check output and final message from
  Claude's transcript. There is no `browser` capability, so screenshot evidence is skipped.
- **steer** (capability `steer`, ADR 0400): the message as one sanitised line (`steerText`), typed with
  `send-keys -l` in pieces of 200 characters (a long paste arrives truncated), then `Enter`. Claude
  Code queues a message typed while it works.
- **release** (safe to call twice): kills the session, runs `git worktree remove --force` (only ever
  under the worktrees dir), deletes the local run branch (run branches only), and removes the run and
  attachments dirs. It never touches the checkout otherwise.
- **capacity**: the live `sf-*` sessions on the factory's socket.
- `reapOrphans` / `diagnose` (`src/reap.ts`), for the host's start and `sf-runner doctor`: `sf-*`
  sessions and worktrees without a live job, and two checkouts of one remote.
- `checkRunningHarness(runDir)`: the launch check for a running job, for `sf-runner doctor`.

## Stream-json sessions (`session: "stream-json"`, ADR 0450)
A second session mode beside tmux, in `src/stream.ts` (spec 37). The manifest adds `chat`.
- **prepareWorkspace**: the same, with the harness projected for a stream session: the launch
  argv ends in `-p --input-format stream-json --output-format stream-json --verbose
  --permission-prompts none`, and a non-planning run gets its own `--session-id <uuid>`.
- **startSession**: spawns `/bin/sh <runDir>/launch.sh` with piped stdio in its own process group
  (environment: the host's, credentials dropped). Once the pid file is written and the process is
  no longer the shell, `verifyLaunch` as in tmux (a mismatch kills it). Then `.factory-prompt.md`
  and `PROMPT_POINTER` as the first JSON user message.
- **events**: each stdout line through harness-claude's `streamLineEvents`: `message`, `tool` (with
  `id`), `tool.result`, `turn`, status. A permission request (none should come) is denied. A
  non-planning job ends at the `result` that answers its last user message (a 15 s grace if Claude
  folded queued messages into one turn); a planning one goes `idle` and stays open. The process
  exiting ends it (`completed` with the result file, else `failed`).
- **steer**: one JSON user message on stdin.
- **takeover** (`run.takeover`): an `interrupt` control request, then stdin closed, the process
  waited for and killed if it lingers. `events()` yields `takeover` with `resumeCommand` (`cd
  <worktree> && env -u … claude … --resume <id>`), then follows the resumed session through the
  status hook and the transcript, and ends at its `SessionEnd` (`completed`), or fails if nobody
  resumes within the waiting-input timeout.
- **release** kills the process group; **capacity** counts live stream processes too.

`src/testing.ts` (`@software-factory/runner-local/testing`) is a scripted tmux for tests, and
`fakeStreamClaude`, a stand-in `claude` that speaks stream-json (`test/stream.test.ts`). Git stays
real. `test/tmux.integration.test.ts` runs the adapter on the real tmux, on its own socket, with a
stand-in `claude`. It is skipped when tmux isn't installed.
