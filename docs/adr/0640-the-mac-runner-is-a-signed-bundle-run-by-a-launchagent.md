# ADR 0640: The Mac runner is a signed bundle, run by a LaunchAgent from Application Support

Status: proposed, 2026-11-13. Spec [45](../specs/45-runner-service-on-a-mac.md). Amends
[ADR 0390](0390-the-desktop-app-is-the-daily-ui.md) (the app no longer supervises the runner as a
child). Builds on [0360](0360-runners-update-themselves-to-the-deployed-commit.md),
[0394](0394-the-key-helper-is-its-own-signed-bundle.md) and
[0420](0420-linux-hosts-run-the-runner-as-a-systemd-user-service.md).

## Context
The desktop app runs `sf-runner run` as a child (spec 40 M2). On SIGTERM the runner cancels and
releases every job, so quitting, restarting or updating the app interrupts work. *Restart to
update* has to wait for the runner to be idle. The owner wants the app to be able to go away at any
time, with the runner as a per-user background service that the app switches on and off, and that
updates itself.

A LaunchAgent already exists for checkouts (`sf-runner install`, ADR 0360). It runs a shell wrapper
from a git checkout and updates with git. A person who installed the app has no checkout.

## Decision
1. **The runner is its own bundle, `SF Runner.app`** (`com.software-factory.runner`): the pinned
   Node 24 as `Contents/MacOS/sf-runner`, the bundled JavaScript, a small guard (`service.mjs`) and
   a sealed `version.json`. It is signed with the app's Developer ID under the hardened runtime
   (V8's two JIT entitlements only), notarized and stapled, and nested in the app at
   `Contents/Helpers`, as the key helper is.
   - A bundle because one `codesign --verify --deep --strict` then covers the binary and every
     script, wherever the copy sits. Loose `.mjs` files carry no signature.
2. **The service runs a verified copy from
   `~/Library/Application Support/Software Factory/Runner/versions/<version>`,** through a
   `current` symlink. It does not run from inside the app.
   - Inside the app, an app update would replace files under a running runner, which reads some at
     run time (the check child) and so would mix versions mid-job. A translocated app has a
     throwaway path. A deleted app would leave launchd restarting a missing program.
   - Whoever moves a version in verifies it first, against the identifier and the Team ID read
     from the verifier's own signature, plus `spctl` and the sealed version file: the app's updater
     check, shared. `current` only ever points at a verified copy.
   - Only `current` and `previous` (the rollback target) are kept once an update confirms.
3. **launchd runs it as a LaunchAgent** under the existing label `com.software-factory.runner`
   (one runner per Mac; the host lock already refuses a second). The plist is written by
   `sf-runner service install`, run by the app from its bundled copy, so the logic is
   `local/runner-host`'s and tested there. Its program is the bundle's own executable, so Login
   Items and TCC name SF Runner, and grants survive updates (same designated requirement). Key
   choices, each for a reason given in the spec:
   - `KeepAlive { SuccessfulExit: false }`: exit 0 means "stopped on purpose";
   - `ThrottleInterval 30` and `ExitTimeOut 120` (the runner needs up to 90 s to release its jobs);
   - `ProcessType Standard` (`Background` throttles builds) and `AbandonProcessGroup` (a restart
     keeps the tmux server);
   - `LimitLoadToSessionType Aqua` (the login keychain), and `AssociatedBundleIdentifiers` naming
     the app.
4. **On and off are launchd's.** Start is `enable` and `kickstart`. Stop is `disable`, which
   launchd remembers, so nothing starts at login unless the person turned the runner on (spec 45
   D2). The service may `disable` itself: to stop after a crash loop, or after a stop it was asked
   to do when idle.
5. **Not SMAppService.** `SMAppService.agent` wants the plist and its program inside the app
   bundle, which is the coupling this ADR removes. A legacy plist with `AssociatedBundleIdentifiers`
   still shows under Software Factory in Login Items, where the person can switch it off.
6. **No new authority.** The service reads the same `runner.json`, with the same environment
   allow-list as the app's child (plus launchd's own variables). It never receives the app's token
   or device key, can't decide a gate or pair, and never writes `runner.json`. It records this Mac's
   hardware UUID and refuses to run an identity copied from another Mac.
7. **The checkout flavor stays** for development and Linux, and gains `ExitTimeOut`,
   `ProcessType Standard` and `AbandonProcessGroup`.

## Consequences
- Quitting or updating the app doesn't touch jobs. *Restart to update* stops waiting for the
  runner. The app's `Runner` child supervision and its takeover from launchd go.
- The release builds, signs and notarizes a second bundle, and the runner's Node moves into it.
- A runner keeps running after the app is dragged to the Trash (spec 45 D4). Removing it is a
  button in the app, or `sf-runner service uninstall`.
- launchd doesn't rotate logs. The runner copy-truncates its own at 20 MB, keeping three.
- A checkout under a TCC-protected folder makes macOS ask SF Runner for access once. Doctor
  names those folders.
