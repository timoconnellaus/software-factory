# ADR 0420: Linux hosts run the runner as a systemd user service

Status: accepted, 2026-11-12. Plan:
[`.kim/plans/2026-11-11-run-agents-on-hosts-without-orca.md`](../../.kim/plans/2026-11-11-run-agents-on-hosts-without-orca.md)
(piece 5). Spec [34](../specs/34-linux-hosts.md). Builds on
[0380](0380-runner-local-tmux-and-hook-status.md), [0360](0360-runners-update-themselves-to-the-deployed-commit.md),
[0270](0270-the-factory-launches-the-harness-and-verifies-it.md) and [0056](0056-runner-device-login.md).

## Context
runner-local (ADR 0380) has no desktop dependency: a git worktree, tmux and Claude Code. The owner
also wants to run jobs on Linux machines they own. Today `sf-runner install` only knows launchd, the
log lives in `~/Library/Logs`, and the harness's deny list names macOS paths only. On Linux, Claude
Code keeps its login in `~/.claude/.credentials.json`, not the keychain. Claude Code's sandbox uses
bubblewrap and socat there instead of Seatbelt.

## Decision
1. **One daemon, a service manager per platform.** `install`, `uninstall`, `status`, `doctor` and
   the restart after pairing pick launchd on macOS and a **systemd user service** on Linux
   (`~/.config/systemd/user/software-factory-runner.service`). Both run the same
   `bin/sf-runner-service` wrapper, so self-update and rollback (ADR 0360) are shared code. Joining
   is unchanged: device login, outbound only (ADR 0056).
2. **A user service, not a system one.** Claude Code runs as the owner, with their login, in tmux
   sessions they can attach to, exactly as on the Mac. The owner turns on lingering
   (`loginctl enable-linger`) so it runs without a login session. The CLI checks it and says how,
   but never runs sudo.
3. **The unit keeps launchd's semantics:**
   - restart on a non-zero exit only (`Restart=on-failure`), never give up
     (`StartLimitIntervalSec=0`);
   - `KillMode=process`, so a restart doesn't kill the factory's tmux server and its sessions;
   - stdout and stderr appended to a log file, the same as launchd. The log is under
     `$XDG_STATE_HOME/software-factory/logs`, where the harness already denies reads.
4. **The harness's deny lists are per platform.** A common list, plus macOS's keychain paths, plus
   Linux's keyrings and password stores. Claude's own credentials file is denied on every platform.
   `systemctl`, `loginctl`, `journalctl`, `secret-tool` and `keyctl` join the denied commands. The
   launch check reads `/proc/<pid>/cmdline` on Linux.
5. **The sandbox's prerequisites are checked, not installed.** `doctor` fails without `bwrap` or
   `socat`, since `failIfUnavailable` would fail every job, and warns about what it can't be sure
   of (a bwrap smoke run, AppArmor's user-namespace restriction, linger).

## Consequences
- A Linux box is set up by hand from the README (Node 24, git, tmux ≥ 3.2, bubblewrap, socat,
  Claude Code, the clone). A small `scripts/linux-prereqs.sh` checks and optionally apt-installs the
  packages. There is no curl-to-shell installer.
- `KillMode=process` makes systemd log a warning, and leaves processes behind on `stop`. That is
  intended: the runner cancels and releases its own jobs on SIGTERM (`TimeoutStopSec=120`), and
  `doctor --fix` reaps whatever a crash left.
- Distributions without systemd, a root service and a dedicated runner user are not supported. A
  container per job (piece 4) is the isolation story beyond Claude Code's sandbox.
- Piece 3 (accounts) moves Claude's config dir per account. Its credentials file then needs the
  same deny.
