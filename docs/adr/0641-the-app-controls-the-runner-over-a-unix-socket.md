# ADR 0641: The app controls the runner over a Unix socket in a 0700 directory

Status: proposed, 2026-11-13 (revised the same day after design review). Spec
[45](../specs/45-runner-service-on-a-mac.md). Builds on
[0640](0640-the-mac-runner-is-a-signed-bundle-run-by-a-launchagent.md).

## Context
With the runner in its own launchd service (ADR 0640), the app needs its state (version, jobs, what
it claims, the last error) and needs to ask it to drain, stop or restart, when idle or now. Today
the app signals its child (SIGUSR2 to drain) and reads `live-jobs.json`. A signal carries no
argument and gets no answer, and files can't carry a request.

## Decision
1. **A Unix domain socket, `<stateDir>/control/sf.sock`,** in a directory the service creates
   0700 and checks before listening (a real directory, owned by its uid, mode 0700). The socket is
   0600. **No TCP port**: a port is reachable by every local user and, through a browser, by web
   pages.
2. **The directory's mode is the access check.** The kernel refuses a `connect` from anyone
   without search permission on the directory, that is anyone but this uid and root. A
   peer-credential call (`getpeereid`) would admit the same set, and Node has none without a
   native addon, so there is none. The app checks the owner and mode before it connects.
3. **The protocol:** one JSON request line per connection, one answer line (a stream for followed
   logs), requests at most 4 KiB, zod schemas shared by the service and the app, a protocol number
   and `unknown_op` so versions can differ. Ops: `hello`, `status`, `drain`, `resume`, `stop` and
   `restart` (`when: idle | now`), `cancelRequest`, `logs`, `doctor`, `update.check`,
   `update.offer` (a version the app already verified into the runner root) and `update.retry`.
4. **Nothing secret crosses it,** and nothing on it adds authority: no op returns the runner key, a
   job token or a model credential, and none claims a job, changes config, pairs or approves a gate.
5. **Starting is launchd's,** since a stopped service has no socket. When the socket isn't there,
   `sf-runner service status` answers from `launchctl print`, the Login Items switch and the
   snapshots the service and its launcher write.
6. **Sandboxed code can't reach it, and a test shows it by trying.** The state dir is denied to the
   harness and checks, and no unix socket is allowed. On macOS, a command run under the harness's
   real sandbox and under the check sandbox tries to connect to a listening control socket and to
   read the runner's log, and must fail, while the same command unsandboxed succeeds. The log
   directory, `~/Library/Logs/software-factory`, joins the darwin deny list: it carries other jobs'
   ids, titles and errors.

## What another process running as this user can do
Everything the app can, including `stop now`, which cancels the runner's jobs. It could already
`kill` the runner, `launchctl bootout` it, or read `runner.json` and act as the runner. The socket
gives it nothing it lacked.

## Consequences
- The app no longer signals the runner or reads its files for state. `live-jobs.json` stays, for
  `doctor`, the app's repair decision and the checkout flavor.
- A state dir whose socket path would pass 100 bytes (`SF_RUNNER_STATE_DIR` set deep) refuses to
  listen and doctor says why. The default path is about 55 bytes plus the user name.
