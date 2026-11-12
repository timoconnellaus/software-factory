# Spec 34: Linux hosts, the same runner on a server you own

Read first: the plan ([`.kim/plans/2026-11-11-run-agents-on-hosts-without-orca.md`](../../.kim/plans/2026-11-11-run-agents-on-hosts-without-orca.md)),
ADRs [0420](../adr/0420-linux-hosts-run-the-runner-as-a-systemd-user-service.md),
[0380](../adr/0380-runner-local-tmux-and-hook-status.md) (spec [30](30-runner-local-without-orca.md)),
[0360](../adr/0360-runners-update-themselves-to-the-deployed-commit.md) (spec [08](08-runner-auto-update.md)),
[0270](../adr/0270-the-factory-launches-the-harness-and-verifies-it.md) and
[0056](../adr/0056-runner-device-login.md); `local/runner-host`, `packages/runner-local` and
`packages/harness-claude`.

This is piece 5 of 8 in the plan. Piece 3 (Claude accounts on a host) and piece 4 (a container per
job, spec 33) are built separately.

## Goal
The same `sf-runner` daemon runs on a Linux VM or server the owner owns (a Hetzner box, a home
server). It joins by device login (pull, outbound only), runs as a per-user service that survives
logout and reboot, updates and rolls itself back as on the Mac, and runs every job in a git worktree
with Claude Code in tmux, under Claude Code's Linux sandbox (bubblewrap).

## Scope
- **The service, chosen by platform** (`local/runner-host/src/service.ts`): `install`, `uninstall`,
  `status`, `doctor` and the restart after `pair`/`login` use launchd on macOS (unchanged) and a
  **systemd user service** on Linux. Any other platform: `install` refuses with a clear message;
  `run` still works in the foreground.
- **`src/systemd.ts`**: the unit `~/.config/systemd/user/software-factory-runner.service`
  (`$XDG_CONFIG_HOME` respected):
  - `ExecStart=/bin/sh <checkout>/local/runner-host/bin/sf-runner-service`, the same wrapper as
    launchd, so self-update (exit 75) and the three-start rollback work unchanged (ADR 0360).
  - `Environment=` `PATH` (captured at install, plus tmux's and claude's directories), `HOME`,
    `SF_RUNNER_NODE`, `SF_RUNNER_STATE_DIR`, and `SF_RUNNER_CONFIG` when set. Values are quoted and
    `%` is escaped for systemd.
  - `Restart=on-failure`, `RestartSec=30`, `StartLimitIntervalSec=0`: restarts after a crash or a
    self-update, never after the clean exit of an unpaired runner, and never gives up.
  - `KillMode=process`: a restart stops only the runner, not the factory's tmux server, which the
    service starts and which would otherwise share its cgroup. That matches launchd. `stop` lets
    the runner cancel and release its jobs itself (`TimeoutStopSec=120`).
  - `StandardOutput=append:` and `StandardError=append:` the log file.
  - `WantedBy=default.target`.
  - `install` writes the unit, runs `systemctl --user daemon-reload`, `enable` and `restart`.
    `uninstall` runs `disable --now`, removes the file and reloads. `status` reads
    `systemctl --user show` as `state = …, pid = …, last exit = …`.
- **Lingering:** without `loginctl enable-linger`, a user service stops at logout and doesn't start
  at boot. `install` and `doctor` check `loginctl show-user <user> -p Linger`. If it is off they
  print the one command to run (`sudo loginctl enable-linger $USER`). Neither runs sudo.
- **Platform paths** (`paths()`): logs at `~/Library/Logs/software-factory/runner.log` on macOS, and
  at `$XDG_STATE_HOME/software-factory/logs/runner.log` (default `~/.local/state/…`) elsewhere. That
  is under the state root the harness already denies. Config, state and data paths stay XDG on
  every platform.
- **The harness on Linux** (`packages/harness-claude`):
  - `DENY_HOME` is split into the common list and a per-platform list (`denyHome(platform)`). The
    common list gains `~/.claude/.credentials.json`, where Claude Code keeps its login on Linux (on
    macOS it is in the keychain). macOS keeps `Library/Keychains` and
    `Library/Preferences/.wrangler`. Linux adds the desktop keyrings (`.local/share/keyrings`,
    `.local/share/kwalletd`), `pass` (`.password-store`) and the Hetzner CLI (`.config/hcloud`).
  - The deny commands gain `systemctl`, `loginctl`, `journalctl`, `secret-tool` and `keyctl` (the
    service manager and the keyrings, as `launchctl` and `security` on macOS).
  - The sandbox's default temp dirs include `/private/tmp` only on macOS.
  - `runSettings` takes `platform` (default `process.platform`), so a settings file is a function of
    its inputs and tests pin it.
  - Reading a live process's command line (the ADR 0270 check) uses `/proc/<pid>/cmdline` on Linux,
    so it needs no procps (slim images have no `ps`). It still uses `ps -ww -o command=` elsewhere.
- **`doctor` on Linux** adds:
  - `bwrap` and `socat` on PATH: **✗** when missing. Claude Code's Linux sandbox needs both, and
    the factory sets `failIfUnavailable`, so a job would fail at launch.
  - a bubblewrap smoke run (`bwrap --ro-bind / / --dev /dev --unshare-net true`): **!** warning on
    failure, with the AppArmor fix from Claude Code's docs when
    `kernel.apparmor_restrict_unprivileged_userns` is 1. It is a warning because Claude Code's exact
    bwrap flags aren't ours. The optional seccomp filter isn't checked.
  - linger: **!** warning when off.
  - the systemd user manager reachable (`systemctl --user is-system-running`): **!** warning when
    not.

  The tmux hint says `apt install tmux` on Linux and `brew install tmux` on macOS.
- **`login`** opens the link with `xdg-open` on Linux when a display is present (`DISPLAY` or
  `WAYLAND_DISPLAY`). Otherwise it only prints the link and code, as over SSH today.
- **Install path:** the runner-host README gets "Running on Linux". It covers Node 24 via nvm, git,
  tmux ≥ 3.2, bubblewrap, socat, Claude Code and its login, the clone, `pnpm install`,
  `sf-runner login` and linger. It names every command it runs and pipes nothing from the internet
  into a shell without saying what it does.
- **Scripts** (`local/runner-host/scripts/`):
  - `linux-prereqs.sh` checks the packages and prints what is missing. With `--install` it runs
    the one `apt-get install` line.
  - `linux-check.sh` runs runner-local's real-tmux test, the harness tests and the runner-host unit
    tests inside a Debian container (Docker or OrbStack). It skips with a message when no container
    runtime is available.

## Out of scope
- A container per job (piece 4), Claude accounts (piece 3), the dashboard, the web terminal and
  Sprites.
- A system-wide (root) service, or running as a dedicated user that isn't the owner. The service
  runs as the owner, with their Claude login, as on the Mac.
- Distributions without systemd, and Alpine/musl.
- Bundling Node: the runner runs from a checkout on the owner's Node 24, as on the Mac.

## Acceptance criteria
1. On Linux, `sf-runner install` writes
   `~/.config/systemd/user/software-factory-runner.service` running `/bin/sh …/sf-runner-service`
   with the pinned Node, state dir and PATH. It reloads, enables and restarts it, and says whether
   linger is on. `status` shows `service: state = running, pid = …`; `uninstall` removes it. On
   macOS nothing changes (launchd).
2. The unit restarts the runner after a non-zero exit (a crash, a self-update's 75, the rollback's
   starts) and not after exit 0. A restart doesn't kill the factory's tmux server.
3. A self-update on the Linux host moves the checkout, exits 75, and the service starts the new code.
   An update that doesn't confirm in three starts is rolled back by the wrapper (spec 08 criteria,
   on systemd).
4. On Linux the log is at `~/.local/state/software-factory/logs/runner.log` (or under
   `$XDG_STATE_HOME`) and nothing refers to `~/Library`. `status` prints that path.
5. The run settings on Linux deny reads of `~/.local/share/keyrings`, `~/.password-store` and
   `~/.claude/.credentials.json` and don't list `~/Library/...`. macOS keeps `~/Library/Keychains`.
   The agent's own worktree and attachments stay readable on both.
6. `sf-runner doctor` on a Linux box without bubblewrap or socat fails, naming the package. With
   them, a failing bwrap smoke run, linger off or no user systemd show as warnings with the fix.
7. The ADR 0270 launch check reads the live command line on Linux without `ps`.
8. A fresh Debian/Ubuntu box set up by following the README joins by `sf-runner login` (the owner
   approves the code in the app) and runs a triage and a build end to end in tmux. The build's PR
   goes green through `factory/verify`. `tmux -L software-factory attach -t sf-<jobId>` takes it over.
9. Unit tests cover the unit generation (escaping, restart policy, kill mode, log, env), the platform
   selection and the per-platform deny lists. `local/runner-host/scripts/linux-check.sh` passes
   runner-local's real-tmux test in a Linux container where Docker is available. `pnpm lint`,
   `pnpm typecheck` and `pnpm test` pass.

Criteria 1–7 and 9 are covered by unit tests and the container check. Criteria 2–3 (on a real
systemd), 6 (on a real box) and 8 are live checks on a Linux host.
