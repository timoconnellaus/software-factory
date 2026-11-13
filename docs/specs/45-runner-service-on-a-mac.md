# Spec 45: The runner as a background service on a Mac

**Read first:** ADRs [0640](../adr/0640-the-mac-runner-is-a-signed-bundle-run-by-a-launchagent.md),
[0641](../adr/0641-the-app-controls-the-runner-over-a-unix-socket.md) and
[0642](../adr/0642-the-runner-service-updates-itself-from-the-signed-channel.md); spec
[40](40-desktop-app.md) (M2 the runner child, M4 signing and updates, M4b the key helper) and its
ADRs [0390](../adr/0390-the-desktop-app-is-the-daily-ui.md) and
[0394](../adr/0394-the-key-helper-is-its-own-signed-bundle.md); ADRs
[0360](../adr/0360-runners-update-themselves-to-the-deployed-commit.md),
[0520](../adr/0520-runners-keep-claiming-while-an-update-waits.md) (spec
[38](38-runner-updates-without-draining.md)) and [0420](../adr/0420-linux-hosts-run-the-runner-as-a-systemd-user-service.md);
spec [39](39-runner-host-readopts-live-jobs.md) (re-adoption, not built) and spec
[44](44-durable-objects-never-held-awake.md) Part B (the job line). Code: `apps/desktop/src/bun`
(`runner.ts`, `runner-jobs.ts`, `restart-update.ts`, `update-verify.ts`), `local/runner-host/src`
(`launchd.ts`, `service.ts`, `self-update.ts`, `host-lock.ts`, `live-jobs.ts`, `check-mode.ts`,
`cli.ts`), `local/runner-host/bin/sf-runner-service`.

## Goal
The desktop app can quit, restart or update at any time without touching a running job. This
Mac's runner runs as a **per-user background service** (a launchd LaunchAgent), which the app
controls with a button: Start, Stop, Restart, and its state (running, version, jobs in flight,
last error). Nothing starts at login unless the person turned the runner on. The service updates
itself from the app's signed channel, never mid-job.

## Where things are today
- The app runs `sf-runner run` as a child on its bundled Node (`Contents/Resources/app/runner/node`
  and `sf-runner.mjs`, spec 40 M2), with HOME, PATH and `SF_RUNNER_DESKTOP=1` only. Quitting the
  app sends SIGTERM, and `sf-runner` **cancels and releases every running job** on SIGTERM. So an
  app quit or update interrupts jobs; *Restart to update* waits for the runner to be idle to avoid
  it (`restart-update.ts`).
- The bundled runner is not a git checkout, so it has **no self-update** and reports no version.
  It moves only with the app. After a `RUNNER_COMPAT` bump (ADR 0520) it claims nothing until the
  app updates.
- Separately, `sf-runner install` (a checkout) writes a LaunchAgent `com.software-factory.runner`
  that runs `bin/sf-runner-service` from the checkout and self-updates with git (ADR 0360). The
  app shows that as `launchd` and offers to take it over. That flavor stays, for development and for
  Linux (systemd, ADR 0420).
- The runner's identity is `~/.config/software-factory/runner.json` (0600: runner id and key,
  ADR 0016). Its state is `~/.local/state/software-factory/runner/`. Both are denied to the
  harness. Neither depends on the app.

## Decisions (each with its reason in the ADR named)
1. **The runner ships as its own signed bundle, `SF Runner.app`,** and the service runs a copy
   of it from a versioned directory under Application Support, not from inside the app (ADR 0640).
2. **launchd runs it as a LaunchAgent** with the existing label `com.software-factory.runner`,
   written by the app through the bundled `sf-runner service …` commands (ADR 0640).
3. **The app talks to the service over a Unix socket** in a 0700 directory in the runner's state
   dir. No TCP port. The directory's mode is the access check (ADR 0641).
4. **The service updates itself** from the same R2 channel the app updates from, verified the same
   way (Developer ID, this Team ID, Gatekeeper, the sealed version file), after a self-test of the
   new copy. It swaps only when no job is running, and rolls back by itself (ADR 0642).
5. **Credentials don't move.** The service reads the same `runner.json` the in-app runner read, with
   the same environment allow-list. It gets no app token, no device key and no new authority
   (section 3 below).

## 1. Code, install and launchd
### The bundle
- `SF Runner.app` (`CFBundleIdentifier` `com.software-factory.runner`, `LSBackgroundOnly`), built
  by `apps/desktop/scripts/bundle-runner.mjs`:
  - `Contents/MacOS/sf-runner`: the pinned Node 24 (`vendor-node.mjs`, checked against its committed
    sha256), renamed so Login Items, Activity Monitor and TCC name it.
  - `Contents/Resources/service.mjs`: **the guard**, a small file using only `node:` built-ins
    (start counting, crash-loop stop, rollback, then `import("./sf-runner.mjs")`).
  - `Contents/Resources/sf-runner.mjs` and the files it loads at run time (`check-sandbox-child.mjs`).
  - `Contents/Resources/version.json`: `{ version, channel, sha, runnerSha, compat, contract }`.
    `version` is the app release's version, `sha` the commit built, `runnerSha` the deploy's
    `runnerSha(sha)` (ADR 0520), `compat` the code's `RUNNER_COMPAT`.
- Signed with the app's Developer ID, hardened runtime, entitlements `allow-jit` and
  `allow-unsigned-executable-memory` (V8) and nothing else. Notarized and stapled. It sits in the
  app at `Contents/Helpers/SF Runner.app`, put there by the `postPackage` hook as the key helper is
  (ADR 0394), and is also published on its own (ADR 0642). The app's `runner/` copy goes.
- A bundle, not loose files, because one `codesign --verify --deep --strict` then covers the Node
  binary **and** the JavaScript, wherever the copy lives.

### Where the service runs it from
`~/Library/Application Support/Software Factory/Runner/` (the **runner root**, 0700):

| Path | What |
| --- | --- |
| `versions/<version>/SF Runner.app` | each installed version, verified before it was moved here |
| `current` → `versions/<version>` | a symlink, swapped with an atomic rename |
| `previous` → `versions/<version>` | the rollback target |
| `staging/` | downloads and unpacking; emptied at every start |
| `channel` | `canary` or `stable`, written by the app from its own `version.json` |

- Not from inside the app: an app update replaces the bundle under a running service. The runner
  lazily reads `check-sandbox-child.mjs` and spawns Node again for checks, so a running v1 would
  start v2 code mid-job. A translocated app has a random path, and a deleted app would leave launchd
  restarting a missing program every 30 s.
- **Who verifies the copy:** whoever moves a version into `versions/` (the app installing from its
  own bundle, the service installing a download). It runs the same requirement as the app's updater
  (`update-verify.ts`, moved to a module both use): `codesign --verify --deep --strict -R '=anchor
  apple generic and identifier "com.software-factory.runner" and certificate leaf[subject.OU] =
  "<Team ID>"'` with the Team ID read from the **verifier's own** signature, then `spctl --assess
  --type execute`, then the sealed `version.json` against what was expected. Nothing unverified is
  ever pointed at by `current`.
- **What that does not stop:** a process running as the same user can rewrite these files (or
  `runner.json`, or the plist). The signature check protects against a bad download or a corrupted
  copy, not against the owner's own account. That was equally true of the app bundle. Agents run
  inside Claude Code's sandbox, which can write only the job's worktree.
- **Old versions:** after a new version confirms (its first successful heartbeat), every version
  other than `current` and `previous` is deleted. `staging/` is emptied at each start.
- **Unsigned (dev) builds** install the service from their ad-hoc bundle with self-update off, and
  `doctor` says so. Developers can keep using `sf-runner install` from a checkout.

### The plist
`~/Library/LaunchAgents/com.software-factory.runner.plist`, written by `sf-runner service install`
(`launchd.ts`, a second flavor beside the checkout's). The app runs that command from its bundled
`SF Runner.app`, so the logic lives in `local/runner-host` and is tested there.

| Key | Value | Why |
| --- | --- | --- |
| `Label` | `com.software-factory.runner` | The same as `sf-runner install`: one runner per Mac, and the host lock already enforces it |
| `ProgramArguments` | `<root>/current/SF Runner.app/Contents/MacOS/sf-runner`, `<root>/current/SF Runner.app/Contents/Resources/service.mjs` | The signed bundle's own executable is what launchd starts, so Login Items and TCC attribute it to SF Runner (stable across versions: same identifier and Team ID) |
| `EnvironmentVariables` | `PATH` (the login shell's, captured on each Start), `HOME`, `SF_RUNNER_SERVICE=1`, `SF_RUNNER_ROOT` | The same allow-list as the in-app child; nothing else from the shell |
| `RunAtLoad` | true | Starts when loaded; it is loaded only while the runner is on |
| `KeepAlive` | `{ SuccessfulExit: false }` | Restart after a crash, an update (75) or a requested restart (76); exit 0 means "stopped on purpose" |
| `ThrottleInterval` | 30 | No restart sooner than 30 s; the guard adds backoff on top |
| `ExitTimeOut` | 120 | launchd's default is 20 s, and the runner takes up to 90 s to cancel and release on SIGTERM |
| `ProcessType` | `Standard` | `Background` (today's checkout plist) throttles CPU and I/O, and builds and checks inherit it |
| `AbandonProcessGroup` | true | A runner restart doesn't take the factory's tmux server or containers with it (needed by spec 39) |
| `LimitLoadToSessionType` | `Aqua` | Only in a logged-in GUI session, where the login keychain (Claude's login) is unlocked |
| `AssociatedBundleIdentifiers` | `com.software-factory.desktop` | System Settings > Login Items lists it under Software Factory |
| `StandardOutPath`, `StandardErrorPath` | `~/Library/Logs/software-factory/runner.log` | As today |

- **On, off and login.** `service install` writes the plist, `launchctl enable` and `bootstrap`
  (retried, as `launchd.ts` does). **Stop** leaves the plist and runs `launchctl disable
  gui/<uid>/com.software-factory.runner`, which launchd remembers across logins, so a stopped
  runner doesn't start at the next login. **Start** runs `enable` and `kickstart`. Removing it is
  `service uninstall` (section 5).
- **Logs** are not rotated by launchd. The runner copy-truncates `runner.log` when it passes 20 MB
  (checked hourly and at start), keeping `runner.log.1`–`.3`. Truncating works because launchd
  opened the file with `O_APPEND`. At most about 80 MB.
- **The checkout flavor** keeps its wrapper and git self-update, and gains `ExitTimeOut`,
  `ProcessType Standard` and `AbandonProcessGroup` too.

## 2. The app and the service
### The socket
`<stateDir>/control/sf.sock`: `~/.local/state/software-factory/runner/control/`, 0700, created
by the service.
- At start the service checks the directory is a real directory (`lstat`, not a symlink), owned by
  its uid, mode 0700, and refuses to listen otherwise. It removes a stale socket, binds, and chmods
  the socket 0600. A path over 100 bytes (macOS allows 104) refuses with the reason, which doctor
  shows.
- **No peer-credential call.** Node has no `getpeereid`, and on this socket it would add nothing:
  the kernel already refuses a `connect` from anyone without search permission on a 0700 directory,
  that is anyone but this uid and root. The app checks the same owner and mode before it connects.
- **The harness can't reach it.** The state dir is already in the harness's read-deny list, the
  sandbox writes only the worktree, and the run settings list no `allowUnixSockets`. A test asserts
  both for the control path.

### The protocol
One JSON request line per connection, one JSON answer line (or a stream of lines for `logs` with
`follow`), then close. Requests over 4 KiB are refused. Schemas with zod in
`local/runner-host/src/control-protocol.ts`, imported by the app.

| Request | Answer |
| --- | --- |
| `{v:1, op:"hello"}` | `protocol`, `version`, the ops it knows |
| `status` | below |
| `drain` / `resume` | stop claiming / claim again (a person's drain; an update's caps aren't undone) |
| `stop {when: "idle" \| "now"}` | `idle`: claim nothing, exit 0 once no job runs. `now`: cancel and release every job, then exit 0. Either way `launchctl disable` first |
| `restart {when: "idle" \| "now"}` | as `stop`, but exit 76, so launchd starts it again |
| `cancelRequest` | drop a pending `when: "idle"` stop or restart |
| `logs {lines ≤ 1000, follow?}` | the tail of `runner.log` |
| `doctor` | the doctor checks, run inside the service (section 6) |
| `update.check` | look for a new version now (it still applies only when idle) |

`status` answers `{ version, sha, runnerSha, channel, flavor: "bundle" | "checkout", pid,
startedAt, runnerId, name, state: "running" | "draining" | "stopping" | "restarting" | "updating",
claims: "all" | "light" | "none", request: {op, when, since} | null, jobs: [{ id, stage,
workItemId, heavy, since }], update: { state, target, reason, at }, lastError: { at, line } | null,
checkMode }`. An unknown `op` answers `unknown_op`, so an older service and a newer app (or the
reverse) degrade to what both know.

- No request takes or returns a secret: not the runner key, a job token, a model credential, or
  `runner.json` beyond its redacted form.
- When the service isn't running there is no socket. `sf-runner service status --json` then answers
  from `launchctl print`, `<stateDir>/service/status.json` (the last status, written on every
  change) and `<stateDir>/service/crash.json`, as one of: `off` (no plist, or disabled),
  `not-paired`, `starting`, `crashed` (with the log tail), `checkout` (the plist runs a checkout),
  `other-host` (the host lock is held by another process).

### What another process running as the same user can do
Everything the app can: read the status and logs, drain, stop or restart the runner, cancel its jobs
with `stop now`. It could already do all of that with `kill`, `launchctl` or by editing
`runner.json`, which it can also read. It can't get a secret over the socket, and nothing on the
socket can claim a job, change config, approve a gate or pair. Agents inside the harness sandbox can
do none of it (above).

### The app's control surface
- **Settings > This Mac > Runner**, a card from `packages/ui` (shadcn `Card`, `Badge`, `Button`,
  `AlertDialog`, `DropdownMenu`): state, version and channel, jobs in flight (stage and work item,
  linked), what it claims, a pending update, the last error with *Show log* (the tail in a
  `ScrollArea`), and *Start*, *Stop*, *Restart*:
  - with jobs running, *Stop* and *Restart* offer *when the jobs finish* (the default) and *now
    (cancels N jobs; their unpushed work is lost)*, as *Restart to update* does today; a pending
    request shows with *Cancel*;
  - `crashed` shows the log tail and *Start*; `checkout` shows *Use the app's runner instead*;
    `not-paired` shows *Pair this Mac*.
- **The menu bar** keeps its runner line from the same status, polled over the socket every 5 s
  while the window is open and every 30 s otherwise. No polling of the engine is added.
- **Quitting or updating the app** no longer touches the runner. *Restart to update* stops waiting
  for it: `restart-update.ts`'s drain goes, and so does the app's `Runner` child supervision.
  Pairing stays in the app (`sf-runner login` from the bundled `SF Runner.app`), then
  `service start`.

## 3. Credentials
| | In-app runner (today) | Service |
| --- | --- | --- |
| Runner identity | `runner.json` (0600), read by the child | the same file, read by the service |
| Environment | HOME, PATH, `SF_RUNNER_DESKTOP` | HOME, PATH, `SF_RUNNER_SERVICE`, `SF_RUNNER_ROOT`, plus launchd's own (`USER`, `LOGNAME`, `SHELL`, `TMPDIR`) |
| Model credentials | Claude's login in the keychain, accounts (spec 32), container env files | unchanged; `Aqua` sessions only, so the login keychain is there |
| Repo access | per-job token from the channel, never written | unchanged |
| App token, desktop device key, Touch ID | never given to the child | never given to the service |

- Without the app the service does exactly what the in-app runner did: heartbeat, claim, run and
  hand back jobs, and update itself. It can't decide a gate, sign a presence proof, pair, approve a
  device, or change policy. The Secure Enclave key stays with `SF Keys.app`.
- What it gains is only time: it runs while the app is closed, and at login if the person turned it
  on. That is the request.
- The service never writes `runner.json` (pairing does), and never runs `sudo`.
- **One identity per Mac.** The service records this Mac's hardware UUID (`IOPlatformUUID`) beside
  the runner id in its state on first start. If `runner.json` and the state arrive on another Mac (a
  restored home folder, Migration Assistant), it refuses to start, and the app shows *Pair this
  Mac*. Two hosts with one identity would fight over leases.

## 4. Self-update
Details in ADR 0642.
- **Source:** the app's R2 bucket and channel. Each desktop release also publishes
  `runner/<version>/SF-Runner-<version>.zip` (the notarized, stapled bundle, zipped with `ditto`)
  and adds an entry to `<channel>-macos-arm64-runner.json`: `{ version, sha, runnerSha, compat,
  sha256, size }`, the most recent 20, written after the zip (manifests last, as the app's).
- **Which version** (`selectRunnerVersion`, a pure function) from the installed `version.json`, the
  index, the heartbeat's `desiredVersion` and `minRunnerCompat`, and the rolled-back list:
  - `desiredVersion` unset: stay, unless the code's `compat` is below `minRunnerCompat`: then the
    highest entry whose `compat` is high enough.
  - Installed `runnerSha` equals the desired one: **current**.
  - Entries with that `runnerSha` exist and the installed version is above the lowest of them:
    **current** (ahead; ADR 0520's rule without git).
  - Otherwise the highest such entry above the installed version, not rolled back, `compat` high
    enough: **ready**.
  - No entry for the desired commit yet (the release is still notarizing, or it is a stable Mac and
    the change is only on canary): **blocked, transient**. It keeps claiming as now, and the caps'
    timer doesn't start.
- **Verified before use:** the zip's sha256 and size against the entry (transport only); `ditto -x
  -k` into `staging/`; the signature requirement and `spctl` as in section 1; the sealed
  `version.json` must name the entry's `version`, `runnerSha` and the service's channel, and
  `version` must be higher than the installed one. Then a **self-test**: the new bundle's Node runs
  its `service.mjs --selftest` with the service's environment. It loads every module, parses
  `runner.json` and exits 0 within 30 s.
- **When:** ADR 0520 unchanged. It keeps claiming while the update waits, light only after 30
  minutes, nothing after 60, and applies at the first heartbeat with no job running. Download,
  verification and self-test happen while it waits, so the idle moment needs only the swap.
  No job is ever cancelled for an update. Re-adoption (spec 39), once built, removes the idle
  requirement for tmux jobs.
- **The swap:** write the update record (`<stateDir>/update/`, today's format, `mode: bundle`,
  `from`/`to` are versions), point `previous` at the running version and `current` at the new one,
  write `last-exit = 75`, exit 75. launchd starts the new version.
- **Confirm or roll back:** the guard in the new version counts starts while the record is
  `pending`. The first successful heartbeat confirms it and prunes old versions. A third start
  without a confirmation makes the guard point `current` back at `previous`, mark the record
  `rolled_back` with the reason, add the version to `update-rolled-back` (never tried again) and
  exit 75. A version that fails even to import is caught by the guard, whose `import()` throws.
- **A job in flight at each step:** while waiting, jobs run and new ones are claimed (ADR 0520).
  Download, verification and self-test touch no job. The swap happens only with no job running and
  no claim in flight. A crash of the new version, or a rollback, happens with no jobs (or, after
  spec 39, with tmux jobs it re-adopts).
- **The job line (spec 44 Part B):** lines belong to the host process and close when it exits.
  Since the swap happens idle, no line is open. After spec 39, the new process reconnects each
  re-adopted job's line, and spec 44's dropped-line rule (one call with `waitMs: 0` on reconnect)
  covers the gap.
- **The heartbeat** reports `version: { sha, … }` with the bundle's `sha`, the update state from
  `selectRunnerVersion` and `claims`, as the checkout updater does, plus `compat`. The engine
  needs no change.
- **The app's own updates** don't change the service's version. The app's bundled `SF Runner.app`
  is used only to install the service the first time, or to repair a runner root with no
  verifiable `current`.
- **Deploy order:** a `RUNNER_COMPAT` bump makes Mac services claim nothing until a release with the
  new compat is published on their channel. `docs/deploying.md` gains: a compat bump needs a
  canary release to follow it, and a stable one for stable Macs.

## 5. Failure and lifecycle
- **Crash loop** (the guard, `<stateDir>/service/starts.json`). A start is healthy once the runner
  has heartbeated, or has run 120 s while not paired. An exit the runner announced in
  `service/last-exit` (0, 75, 76) is not a crash. After an unhealthy start the guard waits 30 s,
  60 s, then 120 s before importing the runner, on top of launchd's 30 s throttle. **The fifth
  unhealthy start in a row within 15 minutes** writes `crash.json` (when, how many, the last 50 log
  lines), runs `launchctl disable`, and exits 0, so launchd leaves it stopped. The app shows
  *Crashed* with the log and *Start* (which clears `crash.json`). Rollback (three starts) runs
  before the crash stop (five).
- **Sleep and wake:** launchd doesn't stop the service on sleep. On wake the next heartbeat runs at
  once. A lease that expired while asleep (10 minutes) comes back as `cancel`, and the job is
  released as today. While any job runs, the service holds a `caffeinate -i -w <pid>` assertion
  (idle sleep only; closing the lid still sleeps the Mac). Owner decision D3.
- **Logout:** the Aqua session ends, launchd sends SIGTERM, and the runner cancels and releases
  its jobs within `ExitTimeOut` (as the app's quit did). After spec 39, SIGTERM leaves sessions
  running, but tmux dies with the session at logout, so the lease expires and the Workflow retries.
  The service starts again at the next login only if it is on. It never runs without a login
  session (that would need a system daemon, out of scope).
- **Two Macs:** each has its own `runner.json` from its own pairing, its own service and its own
  channel. Nothing is shared. A copied identity refuses to start (section 3).
- **Uninstall:** Settings > This Mac > Runner > *Remove the runner from this Mac* (also `sf-runner
  service uninstall`). It stops the runner (when idle, or now with the job count), `bootout`,
  removes the plist, the runner root, `<stateDir>/control` and `<stateDir>/service`, and the logs.
  It keeps `runner.json` unless the person also ticks *Forget this runner's identity*. Revoking the
  runner on the engine stays where it is (Factory > Runners). Dragging the app to the Trash runs no
  code: see owner decision D4.
- **Migration from the in-app runner,** on the first launch of the app version that has the
  service:
  - The previous app's runner child stopped when that app quit. *Restart to update* had waited
    for it to be idle, or the person cancelled its jobs. So there are no in-app jobs in flight to
    hand over.
  - Paired, no plist: install and start the service (owner decision D1), and tell the person once,
    in a notification and on the card.
  - A checkout plist (`sf-runner install`, or one set aside as `….taken-over-by-desktop`): leave
    it. The card shows `checkout` and *Use the app's runner instead*. That drains the checkout
    runner (SIGUSR2, as today), waits for its live jobs to reach none, replaces the plist (same
    label) and starts the service.
  - The host lock held by a live process that isn't the service (an orphan): ask it to drain
    (SIGUSR2), wait for its jobs to end, SIGTERM it, then start. The card says what it is waiting
    for.
  - `migrationDecision()` is pure and tested over those inputs.

## 6. Checks on a Mac, and doctor
What a LaunchAgent's environment changes, and what `sf-runner doctor` reports. When a service is
running, `doctor` asks it (the `doctor` op) to run the environment checks **in the service's own
process**, and labels each line with where it ran. Run from a shell, the shell's environment
would hide exactly these problems.
- **PATH:** only the captured login-shell PATH. Doctor resolves `git`, `tmux`, `claude`, `docker`
  (or `container.docker`) and `node` from the service's PATH, and compares with the login shell's
  current PATH. A tool found only in the shell is **!** with *Restart the runner to pick up your
  PATH* (Start re-captures it).
- **Docker / OrbStack socket:** launchd passes no `DOCKER_HOST` or `DOCKER_CONTEXT`. The `docker`
  CLI then uses its current context from `~/.docker/config.json`, which is how OrbStack and Docker
  Desktop work by default. Doctor runs `checkModeReport` in the service and prints the mode and why
  (`container`, `weaker-sandbox`, `none`). If the login shell sets `DOCKER_HOST` or
  `DOCKER_CONTEXT` and the service can't reach a runtime, it says to set the context instead.
  OrbStack starting after the runner at login is already handled: the check mode is re-asked per
  check (60 s cache).
- **No TTY:** nothing needs one. Sessions are detached tmux sessions with their own pty, and
  `login` runs from the app. Doctor checks `stdin` isn't a TTY under the service only to label the
  report.
- **tmux server ownership:** the factory's server (`-L software-factory`) is started by whichever
  host first needs it, and keeps that host's environment for new sessions. Doctor reports the
  server's pid, uid and start time, and whether its PATH matches the service's. With
  `AbandonProcessGroup` its parent is launchd, so a runner restart leaves it up. A server from the
  old in-app runner with a different PATH is **!**, and `doctor --fix` restarts it only when it has
  no sessions.
- **The service itself:** flavor and plist path; `ProcessType`, `ExitTimeOut` and
  `AbandonProcessGroup` as expected; `current`'s signature passes the requirement; the versions on
  disk; the channel; the control directory's owner and mode, and the socket path's length;
  `crash.json`; the log's size; and whether launchd has it disabled (`launchctl print-disabled`),
  which is how a switch-off in System Settings > Login Items shows, named as such.
- **TCC:** a checkout under `~/Documents`, `~/Desktop` or iCloud Drive makes macOS ask SF Runner
  for access the first time. Doctor lists checkouts in those folders, and whether the service could
  read them.

## Owner decisions (recommendations in bold)
- **D1, migration:** a paired Mac whose app ran the in-app runner. **Install and start the service
  on the first launch of the new app, and say so once**, treating "paired and running" as "turned
  on". The alternative is a one-time card, keeping the in-app runner until the person accepts.
- **D2, Stop:** **Stop keeps the runner off across logins until Start.** The alternative is off only
  until the next login.
- **D3, sleep:** **hold an idle-sleep assertion only while a job runs.** The alternative is never.
- **D4, the app deleted without *Remove*:** **the service keeps running, and is visible and
  switchable in Login Items under Software Factory.** The alternative is that the service notices
  (no app with the bundle identifier for a day) and removes itself, which risks firing on a moved
  or reinstalled app.

## Out of scope
- Linux and systemd (ADR 0420, unchanged), a system-wide daemon, running without a login session,
  several users on one Mac each with a service.
- Re-adopting live jobs (spec 39), and the stream-json supervisor.
- SMAppService registration (ADR 0640 says why), Intel Macs (the channel is `macos-arm64`), and
  delta updates of the runner bundle.
- Any change to the engine, the runner contract or the heartbeat's wire.

## Acceptance criteria
Unit tests run in `local/runner-host` and `apps/desktop` (Node, fake `launchctl`, `codesign`,
`spctl` and a temp HOME; no LaunchAgent is loaded on the machine running the tests). The **manual
checks** are steps in `local/runner-host/scripts/mac-service-check.md`, run on a test macOS user
account or a spare Mac, never on the owner's own account.

1. **Plist:** `serviceDefinition` for the bundle flavor gives exactly the keys and values in
   section 1. Environment values are escaped. The environment holds only the allowed keys, whatever
   the caller's environment holds. The checkout flavor gains `ExitTimeOut`, `ProcessType Standard`
   and `AbandonProcessGroup`. *Test.*
2. **Install, start, stop, uninstall** against a fake `launchctl` in a temp HOME: the exact
   commands in order (`enable`, `bootstrap` with retries; `disable` on stop; `bootout` and file
   removal on uninstall). Nothing outside the temp HOME is touched. *Test.*
3. **Verification:** a version is installed only if the requirement, `spctl` and the sealed
   `version.json` pass. A wrong Team ID, a changed file, a lower version, the wrong channel or a
   `runnerSha` mismatch is refused, and `current` is unchanged. *Test* with fake tools, plus a real
   ad-hoc signed bundle on macOS for the seal (as `test/updates.test.ts` does).
4. **Version selection:** `selectRunnerVersion` over a table: current, ahead, ready, blocked
   (transient: no build yet), the compat floor with and without a desired version, rolled-back
   versions skipped, never a downgrade. *Test.*
5. **Drain state machine:** `runnerControl` (pure) over the inputs {person's request and `when`,
   ADR 0520's decision, jobs running, claim in flight}: the claims it allows and the action (none,
   swap and exit 75, exit 0, exit 76). Precedence is stop, then restart, then update. *Test.*
6. **Socket:** the server refuses a control dir that is a symlink, not 0700, or not ours, and a
   path over 100 bytes. Each op round-trips its zod schema. An unknown op answers `unknown_op`. A
   5 KiB request is refused. No answer contains `key`, a token or a credential (a test walks every
   answer). *Test* on a real socket in a temp dir.
7. **The harness:** the run settings deny the control directory and list no unix socket. *Test.*
8. **Guard:** with a fake clock and file system: backoff delays, the crash stop after the fifth
   unhealthy start in 15 minutes (`crash.json`, `disable`, exit 0), the rollback after the third
   unconfirmed start of a pending update (symlinks, record, rolled-back list, exit 75), an
   `import()` that throws counts as a failed start, announced exits don't count. *Test.*
9. **Self-test and swap:** a staged version whose self-test fails is never swapped in. A good one is
   swapped only when idle, and `previous` and `current` are right. After confirmation only those
   two remain. *Test.*
10. **Migration:** `migrationDecision` over {paired, plist flavor, host lock holder, live jobs}.
    *Test.*
11. **Doctor:** the service-run checks report a PATH missing a tool, an unreachable container
    runtime with `DOCKER_HOST` only in the shell, a tmux server with a different PATH, a bad
    control directory and a bad signature, each with its fix. *Test* with fakes.
12. **App surface:** the runner card renders each state (`running` with jobs, `draining`, a
    pending *when idle* request, `crashed`, `checkout`, `not-paired`, `off`) with `packages/ui`
    components. *Stop* with jobs asks *when they finish* or *now (cancels N jobs)*. *Test*
    (`apps/desktop` view tests) plus screenshots in `docs/screenshots/runner-service/`.
13. **The app no longer touches jobs:** quitting the app, or *Restart to update*, sends nothing to
    the service. *Test* (the quit path and `restartToUpdate` call no runner method). **Manual
    check A:** with a build running, quit the app, relaunch it, and update it from canary; the job
    finishes and hands back.
14. **Login:** **manual check B:** on, log out and in, and it starts. Stop, log out and in, and it
    stays stopped. It shows under Software Factory in Login Items.
15. **Crash and update on a real Mac:** **manual check C:** `kill -9` the runner and launchd
    restarts it. A runner made to crash at start stops after five tries, and the app shows
    *Crashed*. A canary runner release is picked up while idle with no action from the person. A
    release made to fail its heartbeat is rolled back after three starts.
16. **Uninstall:** **manual check D:** *Remove the runner from this Mac* leaves no plist, no runner
    root, no control directory and no logs, keeps `runner.json` unless asked, and `launchctl print
    gui/$(id -u)/com.software-factory.runner` fails.
17. `pnpm lint`, `pnpm typecheck` and the touched packages' tests pass.

## PR breakdown
Each PR is from `main` and not stacked on unmerged work.
1. This spec and ADRs 0640–0642.
2. **runner-host, the service:** `service.mjs` (the guard), the bundle flavor of `launchd.ts` and
   `sf-runner service install|start|stop|restart|status|uninstall` with a fake `launchctl`, log
   rotation, `last-exit`, the hardware binding, and the checkout plist's new keys. Criteria 1, 2,
   8.
3. **runner-host, control:** the socket and protocol, `runnerControl`, status snapshots, the
   harness assertion. Criteria 5, 6, 7.
4. **The bundle and the channel:** `SF Runner.app` built, signed and notarized in
   `desktop-release.yml`, nested in the app, published with its index, plus the shared verifier.
   Criterion 3.
5. **The app:** the card, the menu bar, pairing then start, migration, removing the child
   supervision and the update's drain. Criteria 10, 12, 13.
6. **Self-update:** selection, download, verification, self-test, swap, rollback, pruning.
   Criteria 4, 9.
7. **Uninstall and doctor.** Criteria 11, 16, plus `mac-service-check.md` (criteria 13–16's manual
   checks).
