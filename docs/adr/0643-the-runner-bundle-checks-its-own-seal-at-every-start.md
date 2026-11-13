# ADR 0643: The runner bundle's main executable is a launcher that checks its own seal at every start

Status: proposed, 2026-11-13 (revised the same day after the second design review: entry points
for every command, no module from outside the seal, scripts read from a hashed descriptor, the
requirement's form, Node started outside the launcher). Spec [45](../specs/45-runner-service-on-a-mac.md) §1. Builds on
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
   checked, against the standard Developer ID requirement (`anchor apple generic`, the Developer ID
   intermediate and leaf markers, the identifier and the Team ID compiled in at release, which must
   equal its own signing information's), built with `SecRequirementCreateWithString`; and the nested
   Node against the same requirement with its own identifier. The bundle's designated requirement
   isn't compared for equality (codesign's default can carry more clauses). A failure exits 78 and
   records why.
3. **It runs only scripts inside its own bundle, and every command is an entry.** The first argument
   names an entry from a fixed table (`launcher-entries.json`, compiled into the launcher and
   imported by the CLI): the guard, `runner`, `check-child`, the harness hooks, `selftest`,
   `login-item-status`, and every command the app or a person runs (`service-*`, `login`, `status`,
   `doctor`, `account`, `sprites`). Each entry has a closed argument grammar (fixed flags, enumerated
   values, patterned names and URLs, a run dir that must resolve under the state dir); anything else
   exits 64, and no argument names a script. Nothing runs `Contents/Helpers/node` directly: the
   runner's hooks and sprite bridge, which spawn `process.execPath` today, go through entries too.
4. **Sealed scripts import nothing but `node:` built-ins.** Node resolves a bare specifier through
   every `node_modules` above the script, which the seal doesn't cover and the user can write. So
   each script is one esbuild bundle with its dependencies inside (the check child included), and
   the build fails on any non-`node:` external, `createRequire`, `import.meta.resolve` or computed
   `require`/`import()`.
5. **Node runs exactly the bytes the launcher hashed.** The launcher reads the script
   (`O_NOFOLLOW`) into memory, compares the SHA-256 of those bytes with the hash in the resource
   directory of the code object it just validated, and writes those bytes into a pipe Node reads
   as `/dev/fd/4`, so nothing written to the file afterwards reaches Node. The scripts are
   CommonJS: Node reads an extensionless ES module twice and the second read of a descriptor gets
   nothing (amended 2026-11-13 from the launcher PR's prototype, which first passed the file's own
   descriptor).
   After spawning, it checks the child's running code against Node's requirement and kills a
   mismatch.
6. **It builds Node's environment from nothing**: the account's HOME, USER, LOGNAME and SHELL from
   `getpwuid`, TMPDIR, PATH from the runner root's `service-env.json` (absolute directories only),
   and the service's own four variables (the last names the lifeline pipe). `NODE_OPTIONS`,
   `NODE_PATH`, `DYLD_*` and everything else in its own environment are dropped. Node runs with `--disable-sigusr1` (no inspector by signal)
   and `--no-addons`.
7. **It spawns Node and stays its parent**, forwarding signals and exiting with Node's code, so it is
   the responsible process that TCC and Login Items name. A lifeline pipe (its descriptor named in
   the environment; fd 3 stays the check child's report pipe) makes Node exit if the launcher dies.
8. **A launch constraint on Node.** `Contents/Helpers/node` is Team-signed and would be runnable by
   anyone as this user under its own identifier, so it is signed with `--launch-constraint-parent`
   requiring SF Runner's launcher (and, in a release, our Team ID) as its parent; the kernel kills
   it when anything else starts it (shown by the launcher PR's prototype on macOS 26.5 and in CI
   on macOS 15).
9. **The service still runs a copy** under Application Support, not the app's bundle in place
   (ADR 0640 says why); with the launcher, a copy is as trustworthy at start as the app.

## What remains possible for a same-user process
Stated so nobody relies on more: it can stop, remove or replace the service (not as SF Runner); it
can copy the genuine bundle, start it as often as it likes and change files during the ~1 s
check, but not the script Node runs, which is the bytes the launcher hashed, on a pipe; what is
left is swapping Node between the check and the spawn, which in a release its launch constraint
refuses at exec (a substitute must carry our team's constraint) and the launcher's check of the
started child catches only after its first instructions; it reaches
everything SF Runner runs from PATH or from a repository (git, tmux, claude, docker, build scripts),
which run as SF Runner's children with its grants; and it can read `runner.json`. It can't use the
inspector, attach a debugger, inject a library, redirect Node through the environment, plant a
module above the bundle, or point the launcher at a path. Therefore **nothing asks for a TCC grant to SF Runner**, and `sf-runner doctor`
never suggests one: a grant to SF Runner is a grant to every job's code, less the harness's sandbox.

## Consequences
- The release builds a second Swift target and signs two pieces of nested code in the runner bundle.
- Each Node start pays one hash of the bundle (about 50 ms on Apple silicon, measured in the launcher PR; budget 1 s). Check
  children run per check, so that is acceptable.
- The self-test of a new version runs the new launcher first, so a launcher that refuses its own
  bundle or can't start is never swapped in.
- Unsigned dev builds use a launcher built with an empty Team ID, which accepts an ad-hoc signature
  and says so in the log and in `doctor`.
