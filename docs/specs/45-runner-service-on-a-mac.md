# Spec 45: The runner as a background service on a Mac

**Read first:** ADRs [0640](../adr/0640-the-mac-runner-is-a-signed-bundle-run-by-a-launchagent.md),
[0641](../adr/0641-the-app-controls-the-runner-over-a-unix-socket.md),
[0642](../adr/0642-the-runner-service-updates-itself-from-the-signed-channel.md) and
[0643](../adr/0643-the-runner-bundle-checks-its-own-seal-at-every-start.md); spec
[40](40-desktop-app.md) (M2 the runner child, M4 signing and updates, M4b the key helper) and its
ADRs [0390](../adr/0390-the-desktop-app-is-the-daily-ui.md) and
[0394](../adr/0394-the-key-helper-is-its-own-signed-bundle.md); ADRs
[0360](../adr/0360-runners-update-themselves-to-the-deployed-commit.md),
[0520](../adr/0520-runners-keep-claiming-while-an-update-waits.md) (spec
[38](38-runner-updates-without-draining.md)) and [0420](../adr/0420-linux-hosts-run-the-runner-as-a-systemd-user-service.md);
spec [39](39-runner-host-readopts-live-jobs.md) (re-adoption, not built) and spec
[44](44-durable-objects-never-held-awake.md) Part B (the job line). Code: `apps/desktop/src/bun`
(`runner.ts`, `runner-jobs.ts`, `restart-update.ts`, `update-verify.ts`), `apps/desktop/native`
(`sf-keys-app`, the precedent for a Swift helper), `local/runner-host/src` (`launchd.ts`,
`service.ts`, `self-update.ts`, `host-lock.ts`, `live-jobs.ts`, `check-mode.ts`, `check-sandbox.ts`,
`cli.ts`), `local/runner-host/bin/sf-runner-service`, `scripts/deploy` (`lib.ts`,
`desktop-floor.ts`), `packages/harness-claude/src/settings.ts` (`DENY_HOME`).

Revised 2026-11-13 after design review (PR #191): a native launcher that checks the bundle's seal
at every start (§1), a runner sequence so stable Macs aren't stranded (§5), a build order that
never ships a half-trusted or stranded service (Build order), a confirm deadline and an app repair
path for rollback (§5), and lifecycle commands that actually re-read the environment (§2).

## Goal
The desktop app can quit, restart or update at any time without touching a running job. This
Mac's runner runs as a **per-user background service** (a launchd LaunchAgent), which the app
controls with a button: Start, Stop, Restart, and its state (running, version, jobs in flight,
last error). Nothing starts at login unless the person turned the runner on. The service updates
itself from the app's signed channel, never mid-job, and an app update can always repair it.

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
  harness. Neither depends on the app. Its log, `~/Library/Logs/software-factory/`, is **not**
  denied today; this spec denies it (§3).

## Decisions (each with its reason in the ADR named)
1. **The runner ships as its own signed bundle, `SF Runner.app`, whose main executable is a small
   native launcher** that checks the whole bundle's signature (resources included) at every start
   and runs only the scripts sealed inside it (ADR 0643).
2. **The service runs a verified copy** from a versioned directory under Application Support, not
   from inside the app (ADR 0640, which says why a copy beats the app bundle).
3. **launchd runs it as a LaunchAgent** from a hand-written plist with the existing label
   `com.software-factory.runner`, not `SMAppService` (ADR 0640). The environment it runs with is
   read by the launcher at every start, so any restart picks up a new PATH.
4. **The app talks to the service over a Unix socket** in a 0700 directory in the runner's state
   dir. No TCP port. A sandboxed agent command is shown, by a test that tries, to be unable to
   connect to it (ADR 0641).
5. **The service updates itself** from the same R2 channel the app updates from, choosing by a
   monotonic **runner sequence**, verified the same way, self-tested, swapped only when idle,
   confirmed by a heartbeat within a deadline or rolled back (ADR 0642). **App updates repair it.**
6. **Credentials don't move.** The service reads the same `runner.json` the in-app runner read. It
   gets no app token, no device key and no new authority (§4).

## What the owner should know
Choices this spec makes that change how the factory behaves on a Mac. Each is easy to change.
- **Runner code updates with no click.** When runner code is merged and a release carrying it is
  on this Mac's channel, the service downloads, verifies and switches to it at its next idle
  moment (ADR 0520's caps: still claiming for 30 minutes, light work only until 60, then nothing
  until idle). It never cancels a job to update. The card and the menu bar say when one is waiting
  and when it happened.
- **App updates repair the runner.** Every app launch compares the app's bundled `SF Runner.app`
  with the installed one. A newer bundled copy is offered to the service and applied when idle; a
  missing, unverifiable, crash-stopped or stuck copy is replaced by the app directly (§5, *The app
  repairs*). So installing the latest app always brings the runner back to a working state.
- **Builds run at normal priority, but niced.** The launchd job is `ProcessType Standard`:
  `Background` throttles CPU and disk I/O hard and coalesces timers, which makes builds and checks
  several times slower and makes heartbeats late. On a working laptop full-priority builds compete
  with the person's own work, so the runner starts the factory's tmux server and every check at
  `nice 10`: they get every idle core, and lose to interactive work under contention. Disk I/O is not
  lowered (that is what `Background` does, and is what hurts builds most). Containers run in
  OrbStack's or Docker's VM, which `nice` doesn't reach.
- **The runner key stays a plain 0600 file** (`runner.json`, ADR 0016), shared with the checkout
  and Linux flavors, denied to the harness and to checks. A same-user process can read it. Moving
  it into the keychain under SF Runner's designated requirement is the one change that would stop
  that, and it needs the launcher to read the key and hand it to Node over a pipe (Node can't call
  the keychain itself, and `security` would be the caller the ACL sees). It is a follow-up, not
  this spec: everything else a same-user process can do (§1, *What remains*) is unchanged by it.
- **Logout and OS restarts still cancel jobs.** The service runs only in a logged-in session. At
  logout it releases its jobs; if macOS kills it first, the leases expire in 10 minutes and the
  Workflow retries them (§6).
- **Owner decisions D1–D4** are at the end, as decided.

## 1. The bundle and its launcher
### The bundle
`SF Runner.app` (`CFBundleIdentifier` `com.software-factory.runner`, `LSBackgroundOnly`), built by
`apps/desktop/scripts/bundle-runner.mjs`:

| Path | What | Signed as |
| --- | --- | --- |
| `Contents/MacOS/sf-runner` | **the launcher**, Swift, `apps/desktop/native/sf-runner-launcher` | the bundle's main executable: hardened runtime, **no entitlements** |
| `Contents/Helpers/node` | the pinned Node 24 (`vendor-node.mjs`, checked against its committed sha256) | nested code, identifier `com.software-factory.runner.node`, hardened runtime, `allow-jit` and `allow-unsigned-executable-memory` only (V8) |
| `Contents/Resources/runner/service.mjs` | **the guard**, `node:` built-ins only | sealed resource |
| `Contents/Resources/runner/sf-runner.mjs`, `check-sandbox-child.mjs` | the runner | sealed resources |
| `Contents/Resources/version.json` | `{ version, channel, sha, runnerSha, runnerSeq, compat, contract }` | sealed resource |

`version` is the app release's version, `sha` the commit built, `runnerSha` and `runnerSeq` the
deploy's (§5), `compat` the code's `RUNNER_COMPAT`. Signed with the app's Developer ID, notarized
and stapled. It sits in the app at `Contents/Helpers/SF Runner.app`, put there by the
`postPackage` hook as the key helper is (ADR 0394), and is published on its own (§5). The app's
`runner/` copy goes in the last build PR, not before.

### The launcher (ADR 0643)
Plain Node as the main executable would mean nothing checks the scripts at launch: the kernel
checks a Mach-O's pages, never a bundle's resource seal. Anyone running as this user could edit
`sf-runner.mjs` in `versions/`, or write a plist pointing the genuine executable at their own
script, and that code would run as SF Runner with every TCC grant made to it. So the main
executable is a launcher whose whole job is to refuse that. On **every** start, before anything
else:

1. **Find its own bundle from its own code object**, not from `argv[0]`, the working directory or
   the environment: `SecCodeCopySelf`, then `SecCodeCopyPath`, then `realpath`. Every later path
   is built from that resolved path, so swapping `current` after the check changes nothing for
   this process.
2. **Check the running code** (`SecCodeCheckValidity` on itself) and **the whole bundle on disk**
   (`SecStaticCodeCheckValidityWithErrors` with `kSecCSStrictValidate | kSecCSCheckNestedCode |
   kSecCSCheckAllArchitectures`, resources **not** skipped), against the requirement `anchor apple
   generic and identifier "com.software-factory.runner" and certificate leaf[subject.OU] =
   "<TEAM>"`. `<TEAM>` is compiled into the launcher at release (the release environment's Team ID)
   and must also equal the Team ID in its own signing information (`kSecCodeInfoTeamIdentifier`);
   the bundle's designated requirement must be that same requirement. Node is checked as nested
   code against `identifier "com.software-factory.runner.node"` and the same anchor and Team ID.
3. **Build Node's environment from nothing**: `HOME`, `USER`, `LOGNAME` and `SHELL` from
   `getpwuid(getuid())`, `TMPDIR` from `confstr`, `PATH` from `service-env.json` (§2; absolute
   directories only, at most 4 KiB, else the default `/usr/bin:/bin:/usr/sbin:/sbin` and a warning
   in the log), and `SF_RUNNER_SERVICE=1`, `SF_RUNNER_ROOT`, `SF_RUNNER_BUNDLE` (the resolved
   path). Nothing is copied from its own environment, so `NODE_OPTIONS`, `NODE_PATH`, `DYLD_*`,
   `NODE_EXTRA_CA_CERTS` or anything else a plist sets never reaches Node.
4. **Choose the script itself.** Its arguments select only among a fixed list of in-bundle entry
   points: none (the guard, which is what launchd starts), `runner`, `check-child`, `selftest` and
   `login-item-status` (§2). Any other argument, or more than one, exits 64. No argument ever names a
   path.
5. **Spawn** (not exec) `Contents/Helpers/node --disable-sigusr1 --no-addons <script>`, where the
   entry fixes the script: none → `Resources/runner/service.mjs`, `runner` → `sf-runner.mjs run`,
   `check-child` → `check-sandbox-child.mjs`, `selftest` → `service.mjs --selftest`
   (`login-item-status` is answered by the launcher itself, without Node). With stdin, stdout and stderr passed through and a pipe on fd 3
   that closes when the launcher dies (Node exits as on SIGTERM when it reads EOF). It forwards
   SIGTERM, SIGINT, SIGUSR2 and SIGHUP to the child and exits with the child's code (a signal
   becomes 128 + n). Spawning keeps the launcher the responsible process, so TCC and Login Items
   name SF Runner; exec would turn the process into Node.
6. A failed check writes one line to the log (`refused: <reason>`) and to
   `<stateDir>/service/launch-refused.json`, and exits 78 (`EX_CONFIG`). The guard and the app treat
   78 as "this version is untrustworthy" (§5).

`--disable-sigusr1` matters: without it, any same-user process can `kill -USR1` a Node process to
open its inspector and run code in it. The hardened runtime without `get-task-allow` refuses a
debugger attach, and ignores `DYLD_*` variables. `--no-addons` holds because the runner loads no
native addon; the bundle build fails if one appears. Every Node process in the service starts
through the launcher: the guard starts the runner with `<bundle>/Contents/MacOS/sf-runner runner`,
and the runner starts each check child with `… check-child` (its inputs on stdin), so each script
is checked just before Node reads it. The check costs about one hash of the bundle (about 120 MB
unpacked, mostly Node); the launcher PR measures it on an M1 and records it here. A check child
runs per check, not per command, so the cost is acceptable up to 1 s.

### What remains possible for a same-user process
Honestly, after the launcher:
- **It can stop, remove or replace the service.** The plist and the runner root are the user's. A
  plist pointing at its own program runs that program, but not as SF Runner: TCC and Login Items
  attribute by the responsible binary's designated requirement, which it can't produce.
- **It can race the check.** A script edited between the launcher's check and Node's read of it
  runs as SF Runner. The window is milliseconds at each start. Version directories are made
  read-only (`chmod -R a-w`) once verified, which a same-user process can undo, so this is a speed
  bump, not a wall.
- **It reaches whatever SF Runner runs.** The runner and its jobs run `git`, `tmux`, `claude`,
  `docker` from PATH, and the repository's own build scripts. Those are user-writable or come from
  the repository, and they run as SF Runner's children, with its TCC grants. So **a TCC grant to SF
  Runner is a grant to every job's code**, less what the harness's sandbox denies. This is why
  nothing in this spec asks for a grant.
- **It can read `runner.json`** and act as this runner (unchanged; see *What the owner should
  know*), and use the control socket as the app does (§3).
- **It can't** use the inspector (`--disable-sigusr1`), attach a debugger or inject a library
  (hardened runtime), redirect Node with environment (the launcher's environment is built from
  nothing), or make the launcher run a path of its choosing.

### TCC (privacy prompts)
The runner itself needs no TCC access: its worktrees are under its state dir. A checkout a person
points it at under `~/Documents`, `~/Desktop` or iCloud Drive makes macOS ask. Responsibility
follows the spawn chain to SF Runner, but the factory's tmux server double-forks, and on an
unattended Mac a prompt is likely to name **tmux** (or `git`), not SF Runner. Manual check F records
which. Either way the person should **click *Don't Allow*** and move the checkout out of the
protected folder. `sf-runner doctor` lists checkouts in those folders and says exactly that. It
**never** suggests granting Files and Folders or Full Disk Access to SF Runner, tmux, git or a
terminal, for the reason above.

## 2. Install and launchd
### Where the service runs it from
`~/Library/Application Support/Software Factory/Runner/` (the **runner root**, 0700):

| Path | What |
| --- | --- |
| `versions/<version>/SF Runner.app` | each installed version, verified before it was moved here, then made read-only |
| `current` → `versions/<version>` | a symlink, swapped with an atomic rename |
| `previous` → `versions/<version>` | the rollback target |
| `staging/` | downloads and unpacking; emptied at every start |
| `channel` | `canary` or `stable`, written by the app |
| `service-env.json` | `{ PATH, capturedAt }`, written by `service start` and `service restart` from the login shell |
| `app.json` | `{ path, bundleId, channel, version, lastSeen }`, written by the app at each launch (D4) |

**Why a copy and not the signed app bundle.** Running `Contents/Helpers/SF Runner.app` in place
would be simpler, and with the launcher it would be no less trusted at start. It loses on four
counts, so the copy stays:
1. An app update replaces the app bundle under a running service. The runner starts a check child
   (through the launcher) during a job, which would then run the new version's code beside the old
   runner, mid-job.
2. Runner updates arrive without the app (ADR 0642), and rollback needs the previous version on
   disk. Both need a place the service owns.
3. A translocated app (run from Downloads) has a random, temporary path; a deleted or moved app
   leaves launchd restarting a missing program.
4. What the app bundle has that a copy might not is macOS's *App Management* protection (macOS 13
   and later stop other apps modifying a notarized app). Whether it covers a bundle under
   Application Support is not documented; manual check F records it. The design doesn't depend on
   it: the launcher's check is the protection either way.

**Who verifies a copy before it moves in:** whoever moves it (the app installing from its bundle,
the service installing a download), with the app's updater check moved to a module both use
(`update-verify.ts` → `local/runner-host/src/bundle-verify.ts`): `codesign --verify --deep --strict
-R '<the requirement above>'` with the Team ID read from the verifier's own signature, `spctl
--assess --type execute`, the sealed `version.json` against what was expected, then the self-test
(§5). Nothing unverified is ever pointed at by `current`; and if something is, the launcher refuses
it at start.

**Old versions:** after a version confirms (§5), every version other than `current` and `previous`
is deleted. **Unsigned (dev) builds** install the service from their ad-hoc bundle with self-update
off and a launcher built with `TEAM` empty, which accepts an ad-hoc signature and logs `unsigned
build` at every start; `doctor` says so. Developers can keep using `sf-runner install` from a
checkout.

### The plist
`~/Library/LaunchAgents/com.software-factory.runner.plist`, written by `sf-runner service
install` (`launchd.ts`, a second flavor beside the checkout's). The app runs that command from its
bundled `SF Runner.app`, so the logic lives in `local/runner-host` and is tested there.

| Key | Value | Why |
| --- | --- | --- |
| `Label` | `com.software-factory.runner` | As `sf-runner install`: one runner per Mac, and the host lock already enforces it |
| `ProgramArguments` | `<root>/current/SF Runner.app/Contents/MacOS/sf-runner` and nothing else | The launcher; it takes no path and resolves its own bundle |
| `EnvironmentVariables` | none | The launcher builds Node's environment itself (§1); PATH comes from `service-env.json`, so a restart re-reads it |
| `RunAtLoad` | true | Starts when loaded; it is loaded only while the runner is on |
| `KeepAlive` | `{ SuccessfulExit: false }` | Restart after a crash, an update (75) or a requested restart (76); exit 0 means "stopped on purpose" |
| `ThrottleInterval` | 30 | No restart sooner than 30 s; the guard adds backoff on top |
| `ExitTimeOut` | 120 | launchd's default is 20 s, and the runner takes up to 90 s to cancel and release on SIGTERM (not honoured at logout: §6) |
| `ProcessType` | `Standard` | See *What the owner should know*; jobs are niced instead |
| `AbandonProcessGroup` | true | A runner restart doesn't take the factory's tmux server or containers with it (spec 39); see *Children after a kill* |
| `LimitLoadToSessionType` | `Aqua` | Only in a logged-in GUI session, where the login keychain (Claude's login) is unlocked |
| `AssociatedBundleIdentifiers` | `com.software-factory.desktop` | System Settings > Login Items lists it under Software Factory |
| `StandardOutPath`, `StandardErrorPath` | `~/Library/Logs/software-factory/runner.log` | As today |

**Why a hand-written plist, not `SMAppService`.** `SMAppService.agent(plistName:)` needs the plist
inside the app at `Contents/Library/LaunchAgents` and a `BundleProgram` relative to the app, so
the program runs from inside the app bundle (reason 1 above), stops when the app is moved or
deleted, and is registered only by the app's own native code, which Electrobun's Bun process
can't call. A legacy plist with `AssociatedBundleIdentifiers` still shows under Software Factory
in Login Items, and `SMAppService.statusForLegacy(plistURL:)` (macOS 13+) reads its switch, which
the launcher's `login-item-status` entry reports. So the plist is ours and only the switch's state
comes from ServiceManagement.

### Lifecycle commands
`kickstart` restarts a loaded job with the plist launchd already has; it never re-reads the file.
So any change to the plist goes through `bootout` and `bootstrap`, and the environment that changes
(PATH) lives outside the plist, read by the launcher at every start.

| Command | Steps |
| --- | --- |
| `service install` | verify and move in the bundled copy (if no `current`), write the plist, then `start` |
| `service start` | capture the login shell's PATH into `service-env.json`; if the plist on disk differs from what this version would write, rewrite it, and `bootout` if loaded; check the Login Items switch (below); `enable`; `bootstrap` if not loaded (retried, as `launchd.ts` does), else `kickstart` if not running; clear `crash.json` and `disabledReason` |
| `service restart {when}` | capture PATH into `service-env.json`; then over the socket `restart {when}`: the service exits 76 and launchd starts it again, and the launcher reads the new PATH. If the plist differs, `restart` instead asks `stop {when, keepEnabled}` and runs `start` once it has exited |
| `service stop {when}` | over the socket `stop {when}`; the service runs `launchctl disable` itself before exiting 0, so it stays off across logins (D2) and a pending idle stop survives the app quitting. With no socket: `disable` and `bootout` |
| `service uninstall` | §6 |

`stop {when: idle}` is the service's, not the app's: it holds the request across the app quitting
and exits when the last job ends. A stop or restart waiting for idle shows on the card with
*Cancel*.

### The Login Items switch
A person can switch SF Runner off under System Settings > General > Login Items. On macOS 13 and
later that is recorded by Background Task Management, not in launchd's disabled list:
`launchctl print-disabled` may still show the job enabled, and `bootstrap` then fails (expected
`Bootstrap failed: 5: Input/output error` or `Operation not permitted`). So `service start` asks
`login-item-status` first, and on `requiresApproval` or `notFound` doesn't bootstrap: `status`
answers `off-in-login-items`, and the card says *SF Runner is switched off in System Settings >
Login Items* with *Open Login Items* (`x-apple.systempreferences:com.apple.LoginItems-Settings.extension`).
A `bootstrap` that fails with the status still `enabled` is reported with launchctl's output as
`bootstrap-failed`. Manual check G records the real status values and launchctl's output on
macOS 15 and 26, and the code keys on what it records.

### Logs
launchd doesn't rotate. The runner copy-truncates `runner.log` when it passes 20 MB (checked
hourly and at start), keeping `runner.log.1`–`.3`, at most about 80 MB. Truncating works because
launchd opened the file with `O_APPEND`. The log directory is denied to agents and checks (§3).

### Children after a kill
`AbandonProcessGroup` means launchd doesn't kill the job's process group when the runner exits, so
after a `kill -9` (or a crash) its children are left: the tmux server and the job sessions in it,
check children, and containers. The runner records each in `<stateDir>/service/children.json` as
it starts it: `{ kind, pid, pgid, startedAt, jobId? }` (the tmux server by pid, socket `-L
software-factory` and start time; containers by the label `sf.runner=<runnerId>` it already sets).
On the next start, **before claiming**:
- a recorded process group whose leader still has the recorded start time (so not a reused pid),
  and isn't the tmux server, is sent SIGTERM, then SIGKILL after 10 s;
- each job session in the tmux server whose job isn't live any more is killed (`kill-session`);
  until spec 39 that is every job session, since a new process can't re-adopt, and their leases
  run out and the Workflow retries them. The server itself stays (its sessions' environments are
  the reason it exists). After spec 39, live sessions are re-adopted instead;
- containers with this runner's label and no live job are removed (`docker rm -f`).
The Node child of a killed launcher sees fd 3 close and exits as on SIGTERM, and a new launcher
waits up to 120 s for the host lock before giving up as a failed start.

### The checkout flavor
Keeps its wrapper and git self-update, and gains `ExitTimeOut`, `ProcessType Standard` and
`AbandonProcessGroup` too, and the same child cleanup.

## 3. The app and the service
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
- **Agents and checks can't reach it, shown by trying.** The state dir is in `DENY_HOME` (read and
  write), and the run settings list no `allowUnixSockets`. That is a setting, so the criterion is
  behaviour: on macOS, a command run under the harness's real sandbox (the `srt` runtime with
  `buildRunSettings`' output, as a Bash tool call would run) and under the check sandbox
  (`check-sandbox.ts`) tries to `connect` to a listening socket at the control path in a temp HOME,
  and to read a file in the log dir; both must fail with `EPERM`/`EACCES`, while the same commands
  outside the sandbox succeed (so the test can't pass by accident).
- **The log is denied too.** `Library/Logs/software-factory` joins `DENY_HOME_BY_PLATFORM.darwin`:
  the log carries job ids, work item titles and errors from other jobs, which one job's agent has
  no business reading.

### The protocol
One JSON request line per connection, one JSON answer line (or a stream of lines for `logs` with
`follow`), then close. Requests over 4 KiB are refused. Schemas with zod in
`local/runner-host/src/control-protocol.ts`, imported by the app.

| Request | Answer |
| --- | --- |
| `{v:1, op:"hello"}` | `protocol`, `version`, the ops it knows |
| `status` | below |
| `drain` / `resume` | stop claiming / claim again (a person's drain; an update's caps aren't undone) |
| `stop {when: "idle" \| "now", keepEnabled?}` | `idle`: claim nothing, exit 0 once no job runs. `now`: cancel and release every job, then exit 0. Unless `keepEnabled`, `launchctl disable` first |
| `restart {when: "idle" \| "now"}` | as `stop`, but exit 76, so launchd starts it again |
| `cancelRequest` | drop a pending `when: "idle"` stop or restart |
| `logs {lines ≤ 1000, follow?}` | the tail of `runner.log` |
| `doctor` | the doctor checks, run inside the service (§7) |
| `update.check` | look for a new version now (it still applies only when idle) |
| `update.offer {version}` | a version the app has already verified into `versions/` (§5, *The app repairs*); the service self-tests it and treats it as ready |
| `update.retry {version}` | a person clears a rolled-back version's skip (§5) |

`status` answers `{ version, sha, runnerSha, runnerSeq, channel, flavor: "bundle" | "checkout",
pid, startedAt, runnerId, name, state: "running" | "draining" | "stopping" | "restarting" |
"updating", claims: "all" | "light" | "none", request: {op, when, since} | null, jobs: [{ id,
stage, workItemId, heavy, since }], update: { state, target, reason, since }, lastError: { at,
line } | null, checkMode, sleepAssertion: boolean }`. An unknown `op` answers `unknown_op`, so an
older service and a newer app (or the reverse) degrade to what both know.
- No request takes or returns a secret: not the runner key, a job token, a model credential, or
  `runner.json` beyond its redacted form.
- When the service isn't running there is no socket. `sf-runner service status --json` then answers
  from `launchctl print`, `login-item-status`, `<stateDir>/service/status.json` (the last status,
  written on every change), `crash.json`, `launch-refused.json` and the update record, as one of:
  `off` (no plist, or disabled by Stop), `off-in-login-items`, `app-gone` (D4), `not-paired`,
  `starting`, `crashed` (with the log tail), `refused` (the launcher refused the bundle),
  `update-stuck` (§5), `bootstrap-failed`, `checkout` (the plist runs a checkout), `other-host`
  (the host lock is held by another process).

### What another process running as the same user can do with it
Everything the app can: read the status and logs, drain, stop or restart the runner, cancel its jobs
with `stop now`, offer a version that passes verification. It could already do all of that with
`kill`, `launchctl` or by editing files in the runner root (§1, *What remains*). It can't get a
secret over the socket, and nothing on the socket can claim a job, change config, approve a gate or
pair. Agents and checks inside their sandboxes can do none of it (above).

### The app's control surface
- **Settings > This Mac > Runner**, a card from `packages/ui` (shadcn `Card`, `Badge`, `Button`,
  `AlertDialog`, `DropdownMenu`, `ScrollArea`): state, version and channel, jobs in flight (stage
  and work item, linked), what it claims, a pending or blocked update with its reason, the last
  error with *Show log*, and *Start*, *Stop*, *Restart*:
  - with jobs running, *Stop* and *Restart* offer *when the jobs finish* (the default) and *now
    (cancels N jobs; their unpushed work is lost)*, as *Restart to update* does today; a pending
    request shows with *Cancel*;
  - `crashed` and `refused` show the log tail, the reason and *Repair* (§5) then *Start*;
    `checkout` shows *Use the app's runner instead*; `not-paired` shows *Pair this Mac*;
    `off-in-login-items` shows *Open Login Items*; `app-gone` (seen only if the app comes back)
    shows that the runner turned itself off and *Start*;
  - *Remove the runner from this Mac* in the card's menu (§6).
- **The menu bar** keeps its runner line from the same status, polled over the socket every 5 s
  while the window is open and every 30 s otherwise. No polling of the engine is added.
- **Quitting or updating the app** no longer touches the runner (once the flag is on: Build order).
  Pairing stays in the app (`sf-runner login` from the bundled `SF Runner.app`), then `service
  start`.

## 4. Credentials
| | In-app runner (today) | Service |
| --- | --- | --- |
| Runner identity | `runner.json` (0600), read by the child | the same file, read by the service |
| Environment | HOME, PATH, `SF_RUNNER_DESKTOP` | built by the launcher: HOME, USER, LOGNAME, SHELL, TMPDIR, PATH, `SF_RUNNER_SERVICE`, `SF_RUNNER_ROOT`, `SF_RUNNER_BUNDLE`; nothing inherited |
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
  the runner id in `<stateDir>/service/host.json` on first start. If `runner.json` and the state
  arrive on another Mac (a restored home folder, Migration Assistant), it refuses to start
  (`status` `not-paired`, reason `copied-identity`), and the app shows *Pair this Mac*. Two hosts
  with one identity would fight over leases.

## 5. Self-update
Details in ADR 0642.

### The runner sequence
`runnerSha` (ADR 0520) names the runner code to run, but a commit id has no order, and a Mac on
stable can't tell from a canary-only commit whether its own version is behind or ahead. So the
deploy also computes **`runnerSeq`**: the number of commits on `main`'s first-parent line up to and
including `runnerSha` (`git rev-list --count --first-parent <runnerSha>`), which only grows. 
- `scripts/deploy/lib.ts` computes it beside `runnerSha` and the deploy passes `RUNNER_SEQ`; the
  engine's heartbeat answer gains an optional `desiredRunnerSeq` beside `desiredVersion` (an
  optional field: ADR 0520's rule, no compat bump). In a shallow clone it is unset, as `RUNNER_SHA`
  is.
- The release workflow (already `fetch-depth: 0`) computes `runnerSha` and `runnerSeq` for the
  commit it builds and seals them in `version.json` and the index entry.

### The channel
Each desktop release also publishes `runner/<version>/SF-Runner-<version>.zip` (the notarized,
stapled bundle, zipped with `ditto`) and adds an entry to `<channel>-macos-arm64-runner.json`:
`{ version, sha, runnerSha, runnerSeq, compat, sha256, size }`, the most recent 20, written after
the zip (manifests last, as the app's). Every merge to `main` that touches the app or what it
bundles publishes a canary, so canary carries every runner change (or a later one: canary runs queue
and the newest wins, which the sequence handles). Stable is published by hand.

### Which version (`selectRunnerVersion`, pure)
Inputs: the installed `version.json`, the index, the heartbeat's `desiredRunnerSeq` and
`minRunnerCompat`, the rolled-back list, the clock, and how long the current state has lasted.
- **Compat floor first.** If the installed `compat` is below `minRunnerCompat` it claims nothing
  (ADR 0520). Target: the highest entry with `compat` high enough, not skipped. None: `compat-blocked`.
- **No `desiredRunnerSeq`** (an older engine or a shallow deploy): stay. **current**.
- **Installed `runnerSeq` ≥ desired:** **current** (at or ahead).
- **Behind:** the target is the highest entry with `runnerSeq` above the installed one, `version`
  above the installed one, `compat` high enough and not skipped. It need not reach the desired
  sequence: a stable Mac moves to the newest stable even when the desired code is only on canary.
  - A target exists: **ready**. The caps' timer starts when it is downloaded, verified and
    self-tested, not before.
  - None, and the channel's highest entry is below the desired sequence: **awaiting-release**. It
    keeps claiming as now and no cap starts. On **stable** this is the normal state between stable
    releases, not an error; the card says *Runner code newer than this Mac's is on canary; stable
    Macs get it with the next stable release*. On **canary**, a release normally lands within
    about 30 minutes of the deploy, so after **2 hours** it becomes **release-missing**: still
    claiming, a warning on the card (*The deployed runner code has no canary release after 2 h.
    Check the desktop-release workflow.*) and in `doctor`. A newer release, or the desired sequence
    dropping (a rollback deploy), clears it.
- **Never a downgrade**, except a channel switch the person asks for (§6).
- **Skipped versions:** a rolled-back version is skipped for 24 hours after its first rollback,
  7 days after its second, and after a third until a person presses *Retry update* on the card
  (`update.retry`). A higher version is never skipped because a lower one was.

### Verified before use
The zip's sha256 and size against the entry (transport only); `ditto -x -k` into `staging/`; the
requirement and `spctl` (§2); the sealed `version.json` must name the entry's `version`,
`runnerSha`, `runnerSeq` and the service's channel, and `version` must be higher than the installed
one. Then a **self-test**: the *new* bundle's launcher runs `selftest`, which checks its own seal
(so a launcher that refuses its bundle, or can't start, fails here), then loads every module under
the service's environment, parses `runner.json` and exits 0 within 30 s. Only then does it move into
`versions/` and become ready.

### When
ADR 0520 unchanged: it keeps claiming while a ready update waits, light only after 30 minutes,
nothing after 60, and swaps at the first heartbeat with no job running and no claim in flight. No
job is ever cancelled for an update. Re-adoption (spec 39), once built, removes the idle
requirement for tmux jobs.

### The swap
Write the update record (`<stateDir>/update/`, today's format, `mode: bundle`, `from`/`to` are
versions, plus `swappedAt`), point `previous` at the running version and `current` at the new one,
write `last-exit = 75`, exit 75. launchd starts the new version.

### Confirm, or roll back
The guard is the parent of the runner (launcher → guard → launcher `runner` → Node), so it can watch
a runner that hangs as well as one that crashes. While the record is `pending`:
- **Confirmed** by the first successful heartbeat of the new version. That prunes old versions.
- **Start count:** the guard counts starts. The third start without a confirmation rolls back.
- **Confirm deadline:** the runner writes `<stateDir>/service/heartbeat.json` on every heartbeat
  attempt: `{ at, outcome: "ok" | "unreachable" | "rejected" | "error", status? }`, where
  `unreachable` means no HTTP response at all (DNS, connect, TLS). Ten minutes after the start, and
  each minute after, the guard decides:
  - any `ok`: confirmed (the runner normally does this itself);
  - every attempt `unreachable`: **offline**, not broken. It waits, the start doesn't count, and the
    record shows `waiting: offline` (the card: *Update installed; waiting for the network to confirm
    it*). Offline has no expiry: a runner that can't reach the engine can't claim either, and the
    first heartbeat that gets an answer decides;
  - an answer that isn't `ok` (`rejected`, `error`), or **no attempt at all** in ten minutes (a
    runner that hangs before heartbeating): **broken**. Roll back now.
- **Rolling back:** the guard stops the runner (SIGTERM, SIGKILL after 30 s), points `current` back
  at `previous`, marks the record `rolled_back` with the reason, adds the version to the skip list
  (above) and exits 75. A launcher that exits 78 (refused its own bundle) or a version that can't
  even load counts as a failed start.
- **A version that heartbeats but can't do its work** (say, fails every job) is not caught here. The
  Workflow retries those jobs elsewhere, and the next release fixes it; a person can roll back
  from the card (*Roll back to <previous>*).

### The app repairs
The guard lives in the version it guards, so it can't help when the new launcher dies before the
guard runs. The app is the backstop, and every app launch (so every app update) runs
`repairDecision()` (pure) over: the bundled `SF Runner.app`'s `version.json`, the installed
`current` (and whether it verifies), the service status (§3), the update record and its age, and
whether a job is live (`live-jobs.json` and the host lock):
- **No `current`, or `current` fails verification, or `refused`:** install the bundled copy
  (verified), point `current` at it, then `start` if the runner is on.
- **`update-stuck`:** a `pending` record over 15 minutes old, no confirmation, and no socket (the
  guard isn't running): roll back as the guard would (by `app`), then `start`.
- **`crashed`** (the crash stop below) with a bundled copy newer than `current`: install it, then
  offer *Start* (it doesn't start a crash-stopped runner on its own).
- **Bundled newer than `current`** (higher `runnerSeq`, or `compat` enough where `current`'s
  isn't): copy and verify it into `versions/` and send `update.offer`. The service self-tests it and
  swaps when idle, under the usual caps, and the guard confirms or rolls it back.
- **The plist differs** from what the bundled version writes: rewrite it at the next idle restart
  (`service restart {when: idle}` with the plist path above).
- **Bundled older:** nothing. The app never downgrades the runner on its own.
Without the app running, a launcher that dies before the guard counts its start is restarted by
launchd every 30 s until the app next opens; the log says why. That is the honest limit.

### The heartbeat
Reports `version: { sha, … }` with the bundle's `sha`, the update state and `claims`, as the
checkout updater does, plus `compat` and `runnerSeq`. The engine change is the optional
`desiredRunnerSeq` above.

### Compatibility bumps need a release, enforced by the deploy
A `RUNNER_COMPAT` bump makes Mac services claim nothing until a release with the new compat is on
their channel. `scripts/deploy/runner-compat.ts`, run by `deploy.yml` before the engine deploys (as
`desktop-floor.ts` is), fails closed:
- For each channel that has a runner index: its highest entry's `compat` must be at least the
  engine's `RUNNER_COMPAT`.
- **Canary:** both workflows start on the same push, so the check waits for the canary index to
  carry the new compat, polling every minute for up to 60 minutes, then fails the deploy.
- **Stable:** a stable release has to be published by hand first. The deploy fails, unless the repo
  variable `RUNNER_COMPAT_STABLE_GAP` equals the new compat: a person's acknowledgement that stable
  Macs claim nothing until the next stable release.
- A channel with no runner index yet (before the first release with one) isn't checked.

## 6. Failure and lifecycle
- **Crash loop** (the guard, `<stateDir>/service/starts.json`). A start is healthy once the runner
  has heartbeated, or has run 120 s while not paired. An exit the runner announced in
  `service/last-exit` (0, 75, 76) is not a crash. After an unhealthy start the guard waits 30 s,
  60 s, then 120 s before starting the runner, on top of launchd's 30 s throttle. **The fifth
  unhealthy start in a row within 15 minutes** writes `crash.json` (when, how many, the last 50 log
  lines), runs `launchctl disable`, and exits 0, so launchd leaves it stopped. The app shows
  *Crashed* with the log, *Repair* and *Start* (which clears `crash.json`). Rollback (three starts,
  or the deadline) runs before the crash stop (five).
- **Sleep and wake (D3):** launchd doesn't stop the service on sleep. On wake the next heartbeat
  runs at once. A lease that expired while asleep (10 minutes) comes back as `cancel`, and the job
  is released as today. While at least one job runs, the service holds `caffeinate -s -w <pid>`: an
  assertion against system sleep that macOS honours **only on AC power**, so on battery the Mac
  sleeps as usual. It ends when the last job ends. Closing a laptop's lid still sleeps it.
- **Logout:** the Aqua session ends and launchd sends SIGTERM. At logout macOS may kill agents
  before `ExitTimeOut`, so on SIGTERM the runner **releases first**: one batched release of every
  job's lease, before cancelling sessions or cleaning up. If it is killed before that call lands,
  the leases expire in 10 minutes and the Workflow retries. After spec 39, SIGTERM leaves sessions
  running, but tmux dies with the session at logout, so the same applies. The service starts again
  at the next login only if it is on. It never runs without a login session (a system daemon is out
  of scope).
- **Two Macs:** each has its own `runner.json` from its own pairing, its own service and its own
  channel. Nothing is shared. A copied identity refuses to start (§4).
- **Canary and stable apps both installed** (one bundle identifier, so one at a time can run): there
  is one service per Mac, and `channel` records the one it follows. An app of the other channel
  shows *This Mac's runner follows canary* with *Switch to stable*. Switching writes `channel`; the
  selection then reads the new index and never downgrades, so canary → stable stays on the canary
  version until stable passes it, and the card says so, with *Install stable's runner now* (the
  app's bundled copy, when idle: the one downgrade, and only on a person's click). `repairDecision`
  compares within the service's channel, so the other app doesn't fight it.
- **The app gone (D4):** the app writes `app.json` at each launch. Once a day the service checks
  that path still holds an app with the bundle id `com.software-factory.desktop`. When it hasn't for
  **7 days** (a moved app updates the path the next time it opens), the service stops claiming,
  finishes its jobs, then runs `launchctl disable` and exits 0 with `disabledReason: app-gone`. It
  deletes nothing. If the app comes back, it starts the runner again (the person never chose off)
  and says so on the card.
- **Uninstall:** Settings > This Mac > Runner > *Remove the runner from this Mac* (also `sf-runner
  service uninstall`). It stops the runner (when idle, or now with the job count), `bootout`,
  removes the plist, the runner root, `<stateDir>/control`, `<stateDir>/service` and the logs. It
  keeps `runner.json` unless the person also ticks *Forget this runner's identity*. Revoking the
  runner on the engine stays where it is (Factory > Runners).
- **Migration from the in-app runner** (the last build PR, D1), on the first launch of the app
  version that turns the service on:
  - The previous app's runner child stopped when that app quit. *Restart to update* had waited for
    it to be idle, or the person cancelled its jobs. So normally there are no in-app jobs to hand
    over.
  - Paired, no plist: install and start the service, and say so once, in a notification and on the
    card, with **Remove** one click away (D1).
  - A checkout plist (`sf-runner install`, or one set aside as `….taken-over-by-desktop`): leave
    it. The card shows `checkout` and *Use the app's runner instead*. That drains the checkout
    runner (SIGUSR2, as today), waits for its live jobs to reach none (at most 60 minutes, then it
    asks before stopping it now), replaces the plist (same label) and starts the service.
  - **An orphan:** the host lock held by a live in-app runner whose app is gone (the old app crashed
    or was force-quit, and the child was left). The app update has already replaced the files it
    runs from: a running process keeps what it loaded, but the next check child it starts runs the
    new version's code or fails to find it. So it isn't left to finish: the app drains it (SIGUSR2),
    waits **at most 10 minutes** for its jobs, then SIGTERMs it (it releases them and the Workflow
    retries), and starts the service. The card says what it is waiting for and offers *Stop it now*.
  - `migrationDecision()` is pure and tested over those inputs.

## 7. Checks on a Mac, and doctor
What a LaunchAgent's environment changes, and what `sf-runner doctor` reports. When a service is
running, `doctor` asks it (the `doctor` op) to run the environment checks **in the service's own
process**, and labels each line with where it ran. Run from a shell, the shell's environment would
hide exactly these problems. Doctor's fixes are files, commands and the card's buttons; **it never
suggests granting a privacy permission** (§1, TCC).
- **PATH:** only `service-env.json`'s PATH. Doctor resolves `git`, `tmux`, `claude`, `docker` (or
  `container.docker`) and `node` from it, and compares with the login shell's current PATH. A tool
  found only in the shell is **!** with *Restart the runner to pick up your PATH* (restart
  re-captures it, §2).
- **Docker / OrbStack socket:** the service has no `DOCKER_HOST` or `DOCKER_CONTEXT`. The `docker`
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
  host first needs it, and keeps that host's environment and niceness for new sessions. Doctor
  reports its pid, uid, start time and nice value, and whether its PATH matches the service's. A
  server from the old in-app runner with a different PATH is **!**, and `doctor --fix` restarts it
  only when it has no sessions.
- **The service itself:** flavor and plist path, and the plist's keys as this version writes them;
  the launcher's last refusal (`launch-refused.json`); `current`'s signature against the
  requirement; the versions on disk; the channel and the update state (`awaiting-release`,
  `release-missing`, `compat-blocked`, skipped versions); the control directory's owner and mode,
  and the socket path's length; `crash.json`; the log's size; launchd's disabled list **and** the
  Login Items switch (`login-item-status`), named as such; leftover children from
  `children.json`; the hardware binding.
- **TCC:** checkouts the person pointed the runner at under `~/Documents`, `~/Desktop` or iCloud
  Drive, each with *Move it out of <folder>; don't grant access* (§1).

## Owner decisions (as decided, each easy to change)
- **D1, migration:** for an already-paired Mac, **install and start the service automatically**,
  only in the last build PR (after must-fix work: Build order), with a notification and a card
  notice that carry a one-click **Remove**.
- **D2, Stop:** **Stop keeps the runner off across logins until Start.**
- **D3, sleep:** **hold an idle-sleep assertion only while jobs run, and only on AC power**
  (`caffeinate -s`).
- **D4, the app gone:** after **7 days** without the app, **finish the jobs, then disable the
  service, deleting nothing**; the app turns it back on if it returns.

## Out of scope
- Linux and systemd (ADR 0420, unchanged), a system-wide daemon, running without a login session,
  several users on one Mac each with a service.
- Re-adopting live jobs (spec 39), and the stream-json supervisor.
- The runner key in the keychain (a follow-up: *What the owner should know*).
- Intel Macs (the channel is `macos-arm64`), and delta updates of the runner bundle.
- Any change to the runner contract beyond the optional `desiredRunnerSeq`.

## Acceptance criteria
Unit tests run in `local/runner-host`, `apps/desktop`, `scripts/deploy` and the launcher's Swift
package (Node or Swift, fake `launchctl`, `codesign`, `spctl`, `caffeinate` and a temp HOME; no
LaunchAgent is loaded on the machine running the tests). The **manual checks** are steps in
`local/runner-host/scripts/mac-service-check.md`, run on a **test macOS user account** or a spare
Mac, never on the owner's own account, and their results (with the macOS version) are recorded in
the PR that turns the service on.

**Trust**
1. **Launcher refuses a tampered bundle.** On macOS, a real bundle signed ad hoc with the launcher
   built for ad hoc: it starts the guard. Then each of these makes it exit 78 with the reason, and
   Node never starts: a changed byte in `sf-runner.mjs`, an added `.mjs` in `Resources/runner`, a
   changed `version.json`, a replaced `Contents/Helpers/node`, and (for the Team ID path, with fake
   signing information) a bundle signed by another team. *Test.*
2. **Launcher ignores its environment and arguments.** Started with `NODE_OPTIONS=--require
   /tmp/x.js`, `NODE_PATH`, `DYLD_INSERT_LIBRARIES` and a `PATH` without `/usr/bin`, the Node child's
   `process.env` has exactly the keys in §1 and `execArgv` is exactly `--disable-sigusr1
   --no-addons`. An argument that is a path, an unknown entry, or two arguments, exits 64. Started
   through a symlink and with `argv[0]` set to another bundle's path, it checks and runs its own
   bundle. SIGUSR1 to the Node child opens no inspector port. *Test.*
3. **Verification:** a version moves into `versions/` only if the requirement, `spctl` and the sealed
   `version.json` pass. A wrong Team ID, a changed file, a lower version, the wrong channel, a
   `runnerSha` or `runnerSeq` mismatch, or a failed self-test is refused, and `current` is unchanged.
   *Test* with fake tools, plus a real ad-hoc signed bundle on macOS for the seal (as
   `test/updates.test.ts` does).
4. **Agents and checks can't reach the socket or read the log.** As §3: under the harness sandbox
   and the check sandbox on macOS, `connect` to a listening control socket and a read of the log dir
   both fail, and both succeed unsandboxed. `DENY_HOME_BY_PLATFORM.darwin` holds the log dir.
   *Test* (macOS CI).

**launchd**
5. **Plist:** `serviceDefinition` for the bundle flavor gives exactly the keys in §2, with no
   `EnvironmentVariables`. The checkout flavor gains `ExitTimeOut`, `ProcessType Standard` and
   `AbandonProcessGroup`. *Test.*
6. **Lifecycle commands** against a fake `launchctl` in a temp HOME, the exact commands in order:
   `start` writes `service-env.json` and, with an unchanged plist, `enable` then `bootstrap` (or
   `kickstart` when loaded and not running); with a changed plist, `bootout`, write, `enable`,
   `bootstrap`; never `kickstart` after a plist change. `stop` is answered by the service's own
   `disable`; with no socket, `disable` and `bootout`. `restart` with a changed plist goes through
   stop-then-start. A PATH captured by `restart` reaches the next Node child's environment (with the
   real launcher). Nothing outside the temp HOME is touched. *Test.*
7. **Login Items switch:** with `login-item-status` faked to `requiresApproval`, `start` doesn't
   bootstrap and `status` is `off-in-login-items`; with it `enabled` and `bootstrap` failing,
   `bootstrap-failed` with launchctl's output. *Test.* **Manual check G:** switch SF Runner off in
   Login Items; record `print-disabled`, the status and `bootstrap`'s output; the card shows the
   state and *Open Login Items*; switching it back on and *Start* works.
8. **Children after a kill:** with a fake process table, `children.json` entries whose start time
   matches are killed (TERM then KILL), reused pids are left, the tmux server stays, dead jobs'
   sessions and labeled containers are removed, all before the first claim. The Node child exits
   when fd 3 closes. *Test.*
9. **Logs:** at 20 MB `runner.log` is copy-truncated to `.1` and older ones shift, never more than
   three; a write after truncation lands at the start of the file. *Test.*
10. **Hardware binding:** a first start records `IOPlatformUUID`; a start with a different one refuses
    with `copied-identity` and claims nothing. *Test* (fake `ioreg`).
11. **Sleep assertion:** with a fake `caffeinate`, the first job starts `caffeinate -s -w <pid>`, the
    last job's end kills it, and none runs with no jobs. *Test.* **Manual check E:** on a laptop,
    with a job running, `pmset -g assertions` lists it on AC and the Mac sleeps on battery when idle.
12. **Logout:** on SIGTERM the batched release is the first network call. *Test.* **Manual check B**
    (below) also logs out with a job running and records whether the release reached the engine or
    the lease expired.

**Control and the app**
13. **Drain state machine:** `runnerControl` (pure) over {person's request and `when`, ADR 0520's
    decision, jobs running, claim in flight}: the claims it allows and the action (none, swap and
    exit 75, exit 0, exit 76). Precedence is stop, then restart, then update. *Test.*
14. **Socket:** the server refuses a control dir that is a symlink, not 0700, or not ours, and a
    path over 100 bytes. Each op round-trips its zod schema. An unknown op answers `unknown_op`. A
    5 KiB request is refused. No answer contains `key`, a token or a credential (a test walks every
    answer). *Test* on a real socket in a temp dir.
15. **App surface:** the card renders each state (`running` with jobs, `draining`, a pending *when
    idle* request, `crashed`, `refused`, `update-stuck`, `off`, `off-in-login-items`, `app-gone`,
    `checkout`, `not-paired`, `awaiting-release`, `release-missing`, `compat-blocked`) with
    `packages/ui` components. *Stop* with jobs asks *when they finish* or *now (cancels N jobs)*.
    *Test* (`apps/desktop` view tests) plus screenshots in `docs/screenshots/runner-service/`.
16. **The app no longer touches jobs:** with the flag on, quitting the app, or *Restart to update*,
    sends nothing to the service. *Test.* **Manual check A:** with a build running, quit the app,
    relaunch it, and update it from canary; the job finishes and hands back.

**Updates**
17. **Version selection:** `selectRunnerVersion` over a table: current, ahead (higher sequence),
    ready, a stable Mac moving to the newest stable below the desired sequence, `awaiting-release`
    on stable with no expiry, canary `release-missing` after 2 h and cleared by a release,
    `compat-blocked`, the compat floor with and without a desired sequence, no desired sequence,
    skip windows (24 h, 7 days, until retry), never a downgrade. *Test.*
18. **Compat deploy check:** `runner-compat.ts` over {channels with indexes, their highest compat,
    the engine's compat, `RUNNER_COMPAT_STABLE_GAP`}: passes, waits then fails on canary, fails on
    stable without the acknowledgement, passes with it, skips a channel with no index. *Test.*
19. **Self-test and swap:** a staged version whose self-test fails (including its launcher refusing
    its bundle) is never swapped in. A good one is swapped only when idle, and `previous` and
    `current` are right. After confirmation only those two remain. *Test.*
20. **Guard and deadline:** with a fake clock and file system: backoff delays; the crash stop after
    the fifth unhealthy start in 15 minutes (`crash.json`, `disable`, exit 0); rollback on the third
    unconfirmed start; at the deadline, `ok` confirms, all-`unreachable` waits without counting,
    `rejected`/`error` or no attempt rolls back; exit 78 counts as a failed start; announced exits
    don't count. *Test.*
21. **App repair:** `repairDecision` over {bundled version, `current` and whether it verifies,
    status, update record and age, live jobs}: install, roll back a stuck update, offer a newer
    bundled copy, rewrite the plist at idle, never downgrade. *Test.*
22. **Channel switching:** canary → stable keeps the canary version until stable passes it; *Install
    stable's runner now* installs the bundled copy only when idle; `repairDecision` ignores the
    other channel's app. *Test.*
23. **Crash and update on a real Mac:** **manual check C:** `kill -9` the runner (then the launcher):
    launchd restarts it, leftover children are cleaned up before it claims. A runner made to crash at
    start stops after five tries and the app shows *Crashed*. A canary runner release is picked up
    while idle with no action from the person. A release made to fail its heartbeat is rolled back
    by the deadline. A release whose launcher crashes at once is rolled back by the app (*Repair*).
    A `sf-runner.mjs` edited in `versions/` makes the next start `refused`, and the app repairs it.

**Lifecycle**
24. **Login:** **manual check B:** on, log out and in, and it starts. Stop, log out and in, and it
    stays stopped. It shows under Software Factory in Login Items.
25. **Migration:** `migrationDecision` over {paired, plist flavor, host lock holder, live jobs, how
    long it has waited}: install, take over a checkout after its drain (60 min bound), drain then
    stop an orphan within 10 minutes. *Test.* **Manual check H:** on a test account running the
    previous app with a paired in-app runner, install the new app: the service is installed and
    started, the notice shows with *Remove*, and *Remove* works; repeat with an orphaned in-app
    runner (force-quit the old app mid-job first).
26. **Both channels installed:** **manual check I:** with canary's service running, open the stable
    app: it shows the channel and doesn't replace the runner; *Switch to stable* behaves as §6.
27. **App gone:** with a fake clock and `app.json` pointing nowhere for 7 days, the service drains,
    disables itself with `app-gone` and deletes nothing; the app's return starts it. *Test.*
28. **Uninstall:** **manual check D:** *Remove the runner from this Mac* leaves no plist, no runner
    root, no control directory and no logs, keeps `runner.json` unless asked, and `launchctl print
    gui/$(id -u)/com.software-factory.runner` fails.
29. **TCC:** **manual check F:** a checkout in `~/Documents` on the test account, a job on it:
    record which program the prompt names (SF Runner, tmux, git) and whether App Management
    protects the copy under Application Support (try to modify it from Terminal without the
    permission). Doctor flags the checkout and suggests moving it, never a grant.
30. **Doctor:** the service-run checks report a PATH missing a tool, an unreachable container
    runtime with `DOCKER_HOST` only in the shell, a tmux server with a different PATH, a bad control
    directory, a bad signature, a launcher refusal, the Login Items switch, an update state and
    leftover children, each with its fix; no fix text mentions granting access. *Test* with fakes.
31. `pnpm lint`, `pnpm typecheck` and the touched packages' tests pass.

## Build order
Each PR is from `main` and not stacked on unmerged work. Every merge to `main` publishes a canary
app, so **nothing installs, starts or replaces a service on anyone's Mac until the last PR**: until
then the service exists only as `sf-runner service …` commands run by hand on a test account, and
the app keeps its in-app runner. The app's service code sits behind `RUNNER_SERVICE_ENABLED`, a
build constant that is `false` until PR 9.
1. **This spec and ADRs 0640–0643.**
2. **The bundle, the launcher and the verifier:** `apps/desktop/native/sf-runner-launcher`,
   `bundle-runner.mjs`, `SF Runner.app` signed, notarized and nested in the app (unused), and
   `bundle-verify.ts` shared with the app's updater. The launch cost measured and recorded in §1.
   Criteria 1, 2, 3 (the verifier half).
3. **The runner sequence and the channel:** `runnerSeq` in `scripts/deploy/lib.ts`, `RUNNER_SEQ`
   and the optional `desiredRunnerSeq` in the engine, the zip and index published by the release,
   `runner-compat.ts` in `deploy.yml`. Nothing reads the index yet. Criterion 18.
4. **runner-host, the service (CLI only):** the bundle flavor of `launchd.ts`, `service-env.json`,
   `service install|start|stop|restart|status|uninstall`, the Login Items check, the guard (crash
   loop), `children.json` and cleanup, the hardware binding, log rotation, the sleep assertion,
   release-first on SIGTERM, niced jobs, `last-exit`, and the checkout plist's new keys. Criteria
   5–12.
5. **runner-host, control:** the socket and protocol, `runnerControl`, status snapshots, the log deny
   and the sandbox behaviour test. Criteria 4, 13, 14.
6. **Self-update:** selection, download, verification, self-test, swap, the confirm deadline,
   rollback, skip windows, pruning, `update.offer`, channel switching. Criteria 3, 17, 19, 20, 22.
7. **Doctor and Remove (CLI):** criteria 28 (CLI half), 30, plus `mac-service-check.md`.
8. **The app, behind the flag:** the card, the menu bar, Start, Stop, Restart, Remove, *Repair* and
   `repairDecision`, `app.json` and the app-gone return (D4). Criteria 15, 21, 27.
9. **Turn it on (last):** migration and D1's auto-install with its notice, removing the app's
   `Runner` child supervision and *Restart to update*'s drain, the app's `runner/` copy removed, and
   `RUNNER_SERVICE_ENABLED` set `true`. Merged only after PRs 2–8 are on `main` and manual checks
   A–I have passed on a test account with a canary build of PR 8 (run with the flag forced on
   locally), with the results in this PR's description. Criteria 16, 25, 26, and the manual checks.
