# ADR 0643: The runner bundle's main executable is a launcher that checks its own seal at every start

Status: proposed, 2026-11-13. Spec [45](../specs/45-runner-service-on-a-mac.md) §1. Builds on
[0640](0640-the-mac-runner-is-a-signed-bundle-run-by-a-launchagent.md) and
[0394](0394-the-key-helper-is-its-own-signed-bundle.md) (a Swift helper in a signed bundle).

## Context
The first draft of spec 45 made the pinned Node binary the main executable of `SF Runner.app` and
verified a version only when it was moved into the runner root. At exec, the kernel checks a
Mach-O's code pages, never a bundle's resource seal. So any process running as the same user could
edit `sf-runner.mjs` in `versions/`, or write a plist pointing the genuine `Contents/MacOS/sf-runner`
at a script of its own: the signature would stay valid, and that code would run as SF Runner, with
every privacy (TCC) grant and the Login Items identity made to it. The draft said this was "equally
true of the app bundle", which was wrong: the spec invites grants to this identity, and a
general-purpose interpreter signed as SF Runner hands that identity to whoever picks the script.

## Decision
1. **`Contents/MacOS/sf-runner` is a small Swift launcher**, built from
   `apps/desktop/native/sf-runner-launcher` as `sf-keys-app` is, hardened runtime, no entitlements.
   Node moves to `Contents/Helpers/node`, signed as nested code with its own identifier
   (`com.software-factory.runner.node`) and V8's two JIT entitlements only.
2. **At every start the launcher checks its own bundle** before anything else: located from its own
   code object (`SecCodeCopySelf`, `SecCodeCopyPath`, `realpath`), never from `argv[0]`, the working
   directory or the environment; the running code and the whole bundle on disk, with
   `kSecCSStrictValidate | kSecCSCheckNestedCode | kSecCSCheckAllArchitectures` and resources
   checked, against `anchor apple generic`, the identifier and the Team ID compiled in at release
   (which must equal its own signing information's); and the nested Node against its identifier and
   the same team. A failure exits 78 and records why.
3. **It runs only scripts inside its own bundle.** Arguments select from a fixed list of entry points
   (the guard, `runner`, `check-child`, `selftest`, `login-item-status`); none names a path. Every
   Node process in the service starts through it, so each script is checked just before Node reads
   it.
4. **It builds Node's environment from nothing**: the account's HOME, USER, LOGNAME and SHELL from
   `getpwuid`, TMPDIR, PATH from the runner root's `service-env.json` (absolute directories only),
   and the service's own three variables. `NODE_OPTIONS`, `NODE_PATH`, `DYLD_*` and everything else
   in its own environment are dropped. Node runs with `--disable-sigusr1` (no inspector by signal)
   and `--no-addons`.
5. **It spawns Node and stays its parent**, forwarding signals and exiting with Node's code, so it is
   the responsible process that TCC and Login Items name. A pipe on fd 3 makes Node exit if the
   launcher dies.
6. **The service still runs a copy** under Application Support, not the app's bundle in place
   (ADR 0640 says why); with the launcher, a copy is as trustworthy at start as the app.

## What remains possible for a same-user process
Stated so nobody relies on more: it can stop, remove or replace the service (not as SF Runner); it
can race the check by editing a script in the milliseconds between check and read; it reaches
everything SF Runner runs from PATH or from a repository (git, tmux, claude, docker, build scripts),
which run as SF Runner's children with its grants; and it can read `runner.json`. It can't use the
inspector, attach a debugger, inject a library, redirect Node through the environment, or point the
launcher at a path. Therefore **nothing asks for a TCC grant to SF Runner**, and `sf-runner doctor`
never suggests one: a grant to SF Runner is a grant to every job's code, less the harness's sandbox.

## Consequences
- The release builds a second Swift target and signs two pieces of nested code in the runner bundle.
- Each Node start pays one hash of the bundle (measured in the launcher's build PR; budget 1 s). Check
  children run per check, so that is acceptable.
- The self-test of a new version runs the new launcher first, so a launcher that refuses its own
  bundle or can't start is never swapped in.
- Unsigned dev builds use a launcher built with an empty Team ID, which accepts an ad-hoc signature
  and says so in the log and in `doctor`.
