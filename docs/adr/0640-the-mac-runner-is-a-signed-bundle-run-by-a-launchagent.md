# ADR 0640: The Mac runner is a signed bundle, run by a LaunchAgent from Application Support

Status: proposed, 2026-11-13 (revised the same day after design review, and again after the second:
commands run as launcher entries, and the owner-facing consequences listed). Spec
[45](../specs/45-runner-service-on-a-mac.md). Amends [ADR 0390](0390-the-desktop-app-is-the-daily-ui.md)
(the app no longer supervises the runner as a child). Builds on
[0360](0360-runners-update-themselves-to-the-deployed-commit.md),
[0394](0394-the-key-helper-is-its-own-signed-bundle.md) and
[0420](0420-linux-hosts-run-the-runner-as-a-systemd-user-service.md); its launcher is
[0643](0643-the-runner-bundle-checks-its-own-seal-at-every-start.md).

## Context
The desktop app runs `sf-runner run` as a child (spec 40 M2). On SIGTERM the runner cancels and
releases every job, so quitting, restarting or updating the app interrupts work. *Restart to
update* has to wait for the runner to be idle. The owner wants the app to be able to go away at any
time, with the runner as a per-user background service that the app switches on and off, and that
updates itself.

A LaunchAgent already exists for checkouts (`sf-runner install`, ADR 0360). It runs a shell wrapper
from a git checkout and updates with git. A person who installed the app has no checkout.

## Decision
1. **The runner is its own bundle, `SF Runner.app`** (`com.software-factory.runner`): a native
   launcher as its main executable (ADR 0643), the pinned Node 24 as nested code, the bundled
   JavaScript, a small guard and a sealed `version.json`. Signed with the app's Developer ID under
   the hardened runtime, notarized and stapled, and nested in the app at `Contents/Helpers`, as the
   key helper is. A bundle because one seal then covers the binaries and every script, and the
   launcher checks that seal at every start.
2. **The service runs a verified copy from
   `~/Library/Application Support/Software Factory/Runner/versions/<version>`,** through a
   `current` symlink, not the app's nested bundle in place. In place would be simpler, and with the
   launcher no less trusted at start, but: an app update would replace files under a running
   runner, which starts check children mid-job and so would mix versions; runner updates arrive
   without the app and rollback needs the previous version on disk; a translocated app has a
   throwaway path, and a moved or deleted app leaves launchd restarting a missing program. Whoever
   moves a version in verifies it first (the app's updater check, shared), and makes it read-only.
   Only `current` and `previous` are kept once an update confirms.
3. **launchd runs it as a LaunchAgent from a plist we write**, under the existing label
   `com.software-factory.runner` (one runner per Mac; the host lock refuses a second), written by
   `sf-runner service install`, which the app runs as the launcher's `service-install` entry (every
   command the app or a person runs is a launcher entry with a closed argument grammar, ADR 0643),
   so the logic is `local/runner-host`'s and tested there. Its program is the launcher, with no arguments and no
   `EnvironmentVariables`. Key choices, each for a reason given in the spec:
   - `KeepAlive { SuccessfulExit: false }`: exit 0 means "stopped on purpose";
   - `ThrottleInterval 30` and `ExitTimeOut 120` (the runner needs up to 90 s to release its jobs);
   - `ProcessType Standard`, with the runner starting its tmux server and checks at `nice 10`
     (`Background` throttles builds' CPU and I/O and delays heartbeats; a working laptop still
     wins under contention);
   - `AbandonProcessGroup` (a restart keeps the tmux server), with the runner recording the
     children it starts and cleaning up leftovers before its first claim;
   - `LimitLoadToSessionType Aqua` (the login keychain), and `AssociatedBundleIdentifiers` naming
     the app.
4. **The environment lives outside the plist.** `kickstart` never re-reads a plist, so PATH is in
   the runner root's `service-env.json`, captured from the login shell by Start and Restart and read
   by the launcher at every start. Any change to the plist itself goes through `bootout` and
   `bootstrap`.
5. **On and off are launchd's.** Start is `enable` then `bootstrap` (or `kickstart` when loaded and
   not running). Stop is `disable`, run by the service itself before it exits so an idle stop
   survives the app quitting; launchd remembers it, so nothing starts at login unless the person
   turned the runner on (spec 45 D2). The service also disables itself after a crash loop, and after
   seven days without the app (D4), deleting nothing.
6. **Not `SMAppService`.** `SMAppService.agent` needs the plist and its program inside the app
   bundle, which is the coupling decision 2 removes, ties the service's life to the app's location,
   and must be called from the app's native code, which the Electrobun app doesn't have. A legacy
   plist with `AssociatedBundleIdentifiers` still shows under Software Factory in Login Items. Its
   switch there is recorded by Background Task Management, not launchd's disabled list, and makes
   `bootstrap` fail; the launcher reads it with `SMAppService.statusForLegacy(plistURL:)` so the
   app can show it.
7. **No new authority.** The service reads the same `runner.json`, with an environment the launcher
   builds from nothing. It never receives the app's token or device key, can't decide a gate or
   pair, and never writes `runner.json`. It records this Mac's hardware UUID and refuses to run an
   identity copied from another Mac. The key stays a 0600 file for now; the keychain is a follow-up.
8. **The app repairs it.** Every app launch compares its bundled copy with `current` and installs,
   offers or rolls back as spec 45 §5 says, so an app update always brings the runner back to a
   working state. The app never downgrades it unasked.
9. **The checkout flavor stays** for development and Linux, and gains `ExitTimeOut`,
   `ProcessType Standard`, `AbandonProcessGroup` and the child cleanup.

## Consequences
- Quitting or updating the app doesn't touch jobs. *Restart to update* stops waiting for the
  runner. The app's `Runner` child supervision and its takeover from launchd go, in the last build
  PR, behind a flag until then.
- The release builds, signs and notarizes a second bundle with a Swift launcher, and the runner's
  Node moves into it.
- launchd doesn't rotate logs. The runner copy-truncates its own at 20 MB, keeping three. The log
  directory is denied to agents and checks.
- The crash stop's `launchctl disable` lasts across logins until a person presses *Start*; the app
  shows it. A Mac restored from another's backup refuses the copied identity and must pair again.
  Remove deletes the runner's logs. The checkout flavor's restarts now clean up leftover children.
- A checkout under a TCC-protected folder makes macOS ask once, probably naming tmux rather than SF
  Runner. The answer is *Don't Allow* and moving the checkout; doctor never suggests a grant.
