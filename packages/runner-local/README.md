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

## A container per job (`src/container/`, ADR 0430, spec 33)
`createContainerRunner(config)` is a second `RunnerAdapter` over the same tmux session, status hook,
events and steering. A planning job goes to runner-local unchanged. For every other stage it changes:
- **prepareWorkspace**:
  - Builds the agent image if it's missing (`image.ts`: `container/Dockerfile` and
    `egress-proxy.mjs`, tagged by their content hash).
  - Makes the job repo (`job-repo.ts`): `git init --separate-git-dir`, then a fetch from the
    checkout of only the start point (through `refs/software-factory/jobs/<jobId>`, deleted after)
    and the host's item and default branches.
  - Projects the harness with `isolation: "container"`, the image's Node for the status hook and
    `claude` inside.
  - Writes `container.json` (both container specs, the allowlist, the repo's `.git` and config hash)
    and `container.sh` (`exec docker run -it … /bin/sh <runDir>/launch.sh`).
- **startSession**:
  - Creates the job's `--internal` network and starts the egress proxy on it (alias `egress`) and
    on the bridge.
  - Writes the credential's 0600 env file and seeds the home's `.claude.json` (onboarding done, the
    tree trusted).
  - Runs runner-local's start with `container.sh` as the launch script. The launch check reads the
    process with `docker exec … ps` and compares `docker inspect` with the spec (`spec.ts`
    `containerProblems`).
  - Deletes the env file.
- **events**: on `session.ended`, keeps the proxy's log, removes both containers and the network,
  then `checkJobGitDir` (repairs and reports redirects, alternates, hooks, config changes, symlinks)
  and `scanForSecrets` (new objects, changes, untracked files). Any finding turns the end into
  `failed`, so the host doesn't push.
- **collectArtifacts** adds `egress-log`. **release** removes the containers, network, job dir, run
  dir and attachments with file operations only. **manifest** adds `container-isolation`.
- `reapContainers` / `diagnoseContainers` (`reap.ts`) find leftovers by the `software-factory.job`
  label and the `sf-*` dirs. `checkRunningContainer(runDir)` is the check for `sf-runner doctor`.
- `runtime.ts` is the `ContainerRuntime` interface and `dockerRuntime` over the CLI.

For tests, `@software-factory/runner-local/testing` also has a scripted `docker`
(`scriptedDocker`), which starts the agent container when the tmux pane runs `container.sh`.
`test/container.integration.test.ts` builds the real image and runs a stand-in
`claude` in a real container under tmux. It probes the home, the egress, the writes and a commit
that the host then pushes. It is skipped without Docker or tmux.

`src/testing.ts` (`@software-factory/runner-local/testing`) is a scripted tmux for tests. Git stays
real. `test/tmux.integration.test.ts` runs the adapter on the real tmux, on its own socket, with a
stand-in `claude`. It is skipped when tmux isn't installed.
