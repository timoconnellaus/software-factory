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
- **openTerminal** (capability `terminal`, ADR 0440): the web terminal's bridge
  (`src/terminal.ts`), a tmux control-mode client on the job's session (`tmux -L software-factory
  -C attach -t =sf-<jobId>`, plain pipes, no PTY or native module). `%output` for the job's pane is
  decoded to bytes; input is `send-keys -H` (hex, so nothing typed is a tmux command); the size is
  `refresh-client -C <cols>x<rows>`, only when the runner's owner asks (a watch-only bridge leaves
  the pane's size alone); a redraw is `capture-pane -p -e` and the cursor, read in one command so it
  stays in order with the output. Closing it ends only the client, never the session.
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
- Not with container isolation yet: the runner host keeps a container runner in tmux.
- `fakeStreamClaude` (`@software-factory/runner-local/testing`) is a stand-in `claude` that speaks
  stream-json, for `test/stream.test.ts` and the runner host's tests.

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
  - Takes the credential from the job's Claude account (`credentialForAccount`, ADR 0410), which
    was taken when the workspace was prepared. A token account gives its token; a login account is
    refused while the workspace is prepared, before anything is made. The account's config dir is
    never mounted: Claude uses the container home's `.claude`, and `workspace.account` points there
    for the transcript.
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

## A sprite per job (`src/sprites/`, ADR 0480, spec 36)
`createSpritesRunner(config)` runs each job (but planning) in a fresh sprite on Sprites, made with the
owner's token (`sprites.tokenFile`), and keeps runner-local's tmux session on the host. Its pane
runs `sprite.sh`, the bridge (`tty-bridge.ts`) to the sprite's TTY exec, so the start check, the
prompt pointer, steering, `tmux attach` and the web terminal bridge work unchanged.
- **prepareWorkspace**: the job repo (as a container's, `container/job-repo.ts`) under
  `<spritesDir>/sf-<jobId>/`, the harness projected with `isolation: "container"`, the sprite's
  pinned Claude (`/opt/software-factory/claude-code-<v>/bin/claude`) and `platform: "linux"`;
  `sprite.json`, `sprite-entry.sh` (the sprite's side: the credential file, keep-awake, then the
  launch script, as the fixed `ENTRY` script with its paths as arguments) and `sprite-tty.json`.
  Refuses a login account and a missing token up front.
- **startSession**: records the create, creates the sprite with an explicit size, runs
  `sprite/provision.sh` (the Dockerfile's toolchain, Claude Code at its pin), sets and reads back the
  network policy (`egressRules`, ending in a deny-all; `checkEgress` fails closed on rules it doesn't
  recognise), streams the job dir, run dir and attachments in at the same paths (`UPLOAD`, checked
  by sha256), writes the credential into `/dev/shm` (`WRITE`), starts the mirror (`mirror.ts`: pid,
  status, transcripts; 8 files, 64 MiB each, 256 MiB in all) and runs runner-local's start, whose
  launch check adds `spriteChecks` (id, policy, settings hashes in the sprite) and whose `ps` runs in
  the sprite. The entry script's watchdog keeps the sprite awake only while Claude lives and stops it
  at the lifetime.
- **events**: on `session.ended`, pulls the stage result to a host file, runs `RESULT` (a snapshot
  commit of the working tree on the agent's HEAD, as a bundle streamed to a file), imports it with
  the host's safe git (`result.ts`), puts the result in place, checks the git dir, scans for the
  credential, then destroys the sprite.
- **collectArtifacts** adds `egress-policy`. **release** destroys the sprite (and fails, loudly, if it
  can't) and removes the dirs. **manifest**: runner-local's capabilities without `own-hardware`,
  plus `cloud-sandbox`; not `container-isolation` (weaker egress).
- `tty-bridge.ts` reattaches within a budget (60 reattaches, 9 min per outage) and then gives up.
- `api.ts` is the `SandboxApi` interface and `spritesApi` (HTTP + the exec WebSocket).
  `reapSprites` / `diagnoseSprites` (`reap.ts`) act on this runner's name prefix only.
  `checkRunningSprite(runDir, api)` is the check for `sf-runner doctor`.

For tests, `testing` has `fakeSpritesApi` (`src/sprites/fake.ts`): the endpoints and framing on
localhost, the fixed scripts run for real in a directory per sprite, `fakeClaude` for the sprite's
side (the real entry script runs first, a stub in place of the launch script) and `bridgeSpawn` for
`scriptedTmux`'s `spawn`, which runs the real bridge in the pane. `test/sprites-limits.test.ts`
covers the bridge's budget, exec framing and caps, the upload hash and the mirror's caps.
`test/sprites.test.ts` runs the adapter end to end on it; `test/sprites.integration.test.ts` does it
on the real tmux with the bridge as its own process and the web terminal on the pane (skipped
without tmux). Nothing in the tests talks to Sprites.

`src/testing.ts` (`@software-factory/runner-local/testing`) is a scripted tmux for tests. Git stays
real. `test/tmux.integration.test.ts` runs the adapter on the real tmux, on its own socket, with a
stand-in `claude`. It is skipped when tmux isn't installed.
