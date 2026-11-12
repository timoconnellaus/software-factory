# ADR 0501: The factory runs the checks, and only executed evidence proves a criterion

Status: accepted, 2026-11-12 ([spec 51](../specs/51-verify-from-the-factorys-own-evidence.md), PR B).
Amends [ADR 0020](0020-verification-and-review-packet.md), [ADR 0231](0231-verify-verdict-and-the-github-connector.md)
(the verdict) and [ADR 0014](0014-runners-are-adapters.md) (an optional `exec` on the adapter).

## Context
Verify's verdict used the reviewer agent's own report of whether lint, typecheck and tests passed,
and whether each acceptance criterion was met. CI on GitHub is read too, but CI is whatever the
repo's workflows run, and the criteria were "met" because the reviewer said so.

## Decision
- **The project declares its checks** (`checks: [{ name, run, timeoutMinutes }]` in its config,
  plus any a workflow adds). Removing or changing one loosens the config: self-modify, a person.
- **The runner host runs them, not the agent.** After a build session's turn ends, the host commits
  what the session left and runs each check in the job's worktree, on the head it will push,
  through the adapter's optional `exec` (so a containerised job runs them in its container). Only
  an adapter without `exec` gets a local process in the worktree. The host reports exit code,
  duration and a log tail per check on the hand-back; `run.handBack` stores them in
  `core_check_results` against the work item and head SHA. A new head has none.
- **A failure goes back to the same session.** If a check fails and the adapter can steer, the host
  types the exact failure (command, exit code, log tail) into the same build session and checks its
  fix, up to the project's `retryLimit` rounds. After that the item asks a person (Workflow v8; v7 is spec 50 part C's, PR #79),
  never a cold build retry. A session that can't be steered hands back at once and asks a person.
- **The verdict uses executed results.** `reviewPacket.record` passes only when every declared check
  passed on the head SHA, CI is green, the reviewer didn't find a criterion unmet and didn't request
  changes. The agent's own `checks` are ignored.
- **A criterion is Proven only by executed evidence.** The reviewer links each criterion to check
  names (executed checks or CI check runs). The packet marks it **Proven** only when a linked check
  passed on the head SHA; otherwise **Not proven**, the reviewer's evidence shown as opinion. Not
  proven doesn't fail the verdict on its own (a person sees it at the merge gate); unmet does.
- `factory/verify`'s summary lists the executed results and the proven count, and fails when a
  declared check failed or didn't run on the SHA.

## Consequences
- The build job runs a little longer, and a check that needs services the worktree lacks fails
  until the project declares a command that works there.
- An adapter that declares `steer` must accept a second `events()` call after a steer that follows
  `session.ended`: it reports the turn the steer started (runner-local: one small change).
- The reviewer can still argue a criterion is met, and a person can merge on its word, but the
  packet says it is opinion.

> Amended 2026-11-12 (PR #73 review). The first version ran a local check as the runner's owner,
> outside any sandbox, on whatever the session left in the worktree. Changed:
>
> 1. **Isolation or nothing.** A check runs through the adapter's `exec` (a container job: a check
>    container with no network, no credential, no terminal), or under the host's OS sandbox with the
>    harness's floor (ADR 0270): Anthropic's sandbox runtime (`srt`, the engine under Claude Code's
>    sandbox) with `harness-claude`'s own deny lists (`denyHome`), the runner's dirs and the owner's
>    checkouts unreadable, writes only to the check's tree and its temporary HOME and temp, the
>    harness's credential-free environment, and the job's network allowlist. Where neither exists
>    (no `sandbox-exec`, no bubblewrap and socat), each check is reported **"not run: no isolated
>    exec on this runner"**: it fails, so the verdict can't pass on it and a person decides.
> 2. **A clean tree of the exact commit.** Every round runs on a fresh copy of the commit made by the
>    host (`read-tree` + `checkout-index` through a throwaway index, so no ignored files and no git
>    dir; never `git archive`, which honours `export-ignore`). A project declares its install as a
>    check of its own (e.g. `pnpm install --frozen-lockfile`). The check container mounts only that
>    tree and the job's pnpm store; with no network it installs offline from the store.
> 3. **Git guards after every check and fix round.** Before any host git that follows code the job
>    ran, the host compares the worktree's sensitive git config with its value before the session
>    and calls the adapter's optional `checkWorkspace` (the container adapter's `checkJobGitDir`). A
>    finding fails the job; nothing is pushed.
> 4. **The pushed head is the checked head.** The host never commits after the last round; it
>    pushes exactly the commit the last round ran on.
> 5. **An attached PR's checks run before its reviewer session**, on the PR's head, in the verify
>    job (no fix rounds). The reviewer is told their names (`verify #b: check names`).
> 6. **Proof.** The links come from the human-approved spec where a criterion carries
>    `[checks: a, b]`; otherwise they are the reviewer's, labelled "linked by the reviewer". A static
>    check (lint, typecheck, format) never proves a criterion, and a CI check run proves one only when
>    the spec names it. Proven is marked **weakened** when the tests-intact guard (ADR 0500) found
>    gate-file edits on the SHA.
> 7. **The verdict without declared checks** keeps the reviewer's failing check as a reason, as
>    before this ADR.
> 8. **Versioned.** Everything here applies from Workflow v8 (`hostChecksOn`): an item that started
>    earlier gets no checks on its jobs and keeps the old verdict.
> 9. **`run.handBack`** accepts check results only for the run's head (a build's pushed head, a verify
>    job's asked head) and its ancestors on GitHub, and redacts token shapes from the log tails
>    again; the host already redacts them and the job's own tokens.
> 10. **The merge queue's carried packet** records `checksRanOn`; `factory/verify` and the packet
>     say the checks ran on that SHA, not on the updated head.
> 11. `continueSession` is off for stream-json sessions until tested against a real one (a failing
>     check there goes to a person). A hung check settles on `exit` after the kill, even when a
>     detached process holds its output, and the checks get a timer of their own.

> Amended 2026-11-12, second review of PR #73 (exploits run against `srt` 0.0.81, and the hosts
> session's review of the runner side). Changed:
>
> 1. **No sandbox settings on disk, and nothing a check started outlives it.** The settings went to
>    `<root>/srt-settings.json`, which the check could write: a background loop left by one check
>    rewrote them before `srt` read them for the next, which then read `~/.ssh`. Now the host runs
>    its own small child (`check-sandbox-child.mjs`) that takes the settings and the command on stdin
>    and calls `SandboxManager` directly: nothing is written. The check writes only its own tree,
>    HOME and temp (not the rest of its root: the empty tool dirs and git config are denied
>    explicitly, and a later round's tree is outside its `allowWrite`). After **every** check, however
>    it ended, the host kills its whole process group and then anything still running with a cwd
>    under the check's root (a daemon that called setsid). On Linux srt's bubblewrap already runs
>    with `--new-session --die-with-parent --unshare-pid`.
> 2. **The command's own exit, never srt's.** srt's CLI exits 0 when its command dies of SIGTERM or
>    SIGINT, so a test that printed a failure and signalled itself passed. The child reports the
>    command's own exit (its code, or the signal it died of) on a pipe only the host holds. A sandboxed
>    process can signal only its own sandbox (macOS `signal (target same-sandbox)`, a pid namespace on
>    Linux), so nothing in the check can stop that report. Any signal death, a missing or garbled
>    report, or a child that exits non-zero is a failure. A sandbox that couldn't start is "not run".
> 3. **The checks root is the runner's, not the system temp dir.** It was `<tmpdir>/sf-checks`, and
>    every agent's sandbox may write `/tmp` and `/private/tmp`: with two jobs on one runner, job A's
>    agent could rewrite job B's tree between the export and the check. It is now
>    `~/.local/share/software-factory/runner/checks` (`paths().checksDir`; not under the state dir,
>    which the floor denies, so a check could not read its own tree), and every harness's
>    `protectPaths` names it. The export's index sits beside the job's root, outside the check's view.
> 4. **`run.handBack` drops what it can't place.** A result on a SHA that isn't the head or one of
>    its ancestors on GitHub (a fix round that amended or rebased, so that commit was never pushed)
>    is dropped, never a reason to fail the run. A completed run's last round must still be on its
>    head. A failed run keeps its own reason, whatever its check results say.
> 5. **Only a person's link proves.** A criterion is Proven only through the approved spec's
>    `[checks: …]` tag on that criterion, matched by its text, never by position (a reworded criterion
>    inherits nothing, and a tag the reviewer writes on a criterion is not the spec's). The reviewer's
>    links are shown as "linked by the reviewer, not proven", whatever passed.
> 6. **A `checks` capability** (ADR 0520's compatibility rule). The host declares it for any adapter.
>    A job that carries checks requires it, so it is never placed on an older runner, which would
>    drop the field and hand back with none; `job.claim` also adds checks only for a runner that
>    declares it.
> 7. **"Not run" is its own result.** An executed check may carry `notRun` (why). A job with no
>    container on a container runner, a runner whose jobs live elsewhere (a container, a sprite: the
>    `container-isolation` or `cloud-sandbox` capability; the host's own sandbox is never used for
>    them), or a sandbox that couldn't start: the check is reported not run, never failed, and never
>    sent to a fix round it can't win. It still isn't a pass, so a person decides.
> 8. **A container's install check runs offline.** The check container has no network, so a project
>    on a container runner declares its install as `pnpm install --offline --frozen-lockfile`, which
>    installs from the job's pnpm store (the session filled it). An online install fails there.
> 9. **The export runs no filter.** It is the host's own git, outside every sandbox: attributes come
>    from the empty tree, no attributes file is read, and every filter driver the checkout's config
>    names is blanked, so an owner's smudge filter plus an in-tree `.gitattributes` can't run a
>    command on the agent's content. A container check's output is streamed with a cap.
> 10. **Tested for real, in CI too.** The sandbox tests run where `sandbox-exec` or bubblewrap and socat
>     exist, and CI installs them and requires them (`SF_REQUIRE_SANDBOX`): a check that signals
>     itself, one that leaves a loop and a setsid'd daemon, one that goes for the settings and the
>     host's files, unix sockets (the factory's tmux socket, Docker's, the ssh agent's), and a harness
>     command trying the checks dir.
>
> **Known limits**, inherited from the harness's floor (ADR 0270) and not changed here: a check can
> read the owner's home outside the deny list and `/private/tmp`; it can connect to localhost ports
> (the floor allows local binding for dev servers and the workerd test pool); it can reach github.com
> and the other allowlisted hosts through the proxy; and on macOS it can talk to securityd (the floor
> allows its mach service), though the owner's keychains are not on its list because their directory
> is denied. A daemon that both leaves the check's process group and changes its cwd out of the
> check's root before the check ends escapes the reaping on macOS; it stays inside the sandbox, which
> lets it write only that check's own dirs, and the root is deleted when the job ends.
