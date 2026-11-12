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

> **Amended 2026-11-12 (third review).** The third independent review found the sandbox never
> started with the runner's real paths, an install could not succeed in it, a "not run" check was a
> dead end, and a check could still forge a later one. What is now true:
>
> 1. **The sandbox starts at the runner's real depth.** srt puts its proxy sockets in its process's
>    temp; the check's temp under `paths().checksDir` made that path about 123 characters on macOS
>    (limit 104) and 125 on Linux (limit 108). The sandbox child's own TMPDIR is now a short private
>    dir made per check under `paths().checkSocketsDir` (`<data dir>/s/c…`), which no check can write
>    and every harness's `protectPaths` names; the command still gets the check's own temp. A dir
>    that would still be too deep is "not run" with the reason. Tested at the real `paths()` depth
>    with a realistic job id, on both OSes.
> 2. **Each check has a dir of its own.** `<checks root>/r<round>-<i>/` holds its tree, HOME, temp and
>    pnpm store. The first check of a round gets the export of the commit; each later one gets a copy
>    of the tree the check before it left (so the install, declared first, carries over), made only
>    after that check ended and everything it started was killed; the earlier dir is then removed.
>    Symlinks are copied as they are, never followed. A process an earlier check left can write only
>    that check's dirs, never the one the next check runs in: that is the guarantee. The kill is
>    defence in depth: the process group, every descendant the host saw from spawn (the process
>    table read every 100 ms, a pid killed only with its recorded start time), then anything with a
>    cwd under the check's dir; on Linux bubblewrap's pid namespace with `--die-with-parent` kills
>    everything when the sandbox ends. Regression: a detached daemon with cwd `/` that keeps writing
>    PASS can't make the next check pass, on both OSes.
> 3. **None of the owner's home, no loopback.** The whole home is denied; only the toolchain on the
>    check's PATH (each tool's PATH entry and the install it resolves to: a node prefix, a package
>    such as `…/node_modules/pnpm`) is re-allowed, read-only, and never a path that is, holds or sits
>    in a denied one. `allowLocalBinding` is off: no loopback but the sandbox's own proxy, so a
>    service on the owner's 127.0.0.1 is unreachable. On Linux the check has a loopback of its own in
>    its network namespace; **on macOS a check can't reach a server it starts itself** (a workerd test
>    pool, a dev server): such a project's checks need a Linux or container runner.
> 4. **The install runs in the sandbox.** The check's pnpm store is its own (`<check dir>/store`), not
>    the agent's or another job's; `NODE_USE_ENV_PROXY=1` makes Node's own fetch (corepack fetching
>    pnpm) go through the proxy, so the runner's Node must be ≥ 24.5. The documented install check
>    (`pnpm install --frozen-lockfile`, then a check that runs the tests) passes end to end on a real
>    pnpm workspace, through a plain pnpm and through corepack's shim, on macOS and in Linux CI.
>    Lifecycle scripts run only there (and in a container check); the host never installs. A
>    container check gets its own copy of the job's pnpm store, mounted where the agent's was.
> 5. **"Not run" goes on to a person.** Stored with its reason (migration 0271,
>    `core_check_results.not_run`), never a pass, never a failure. The build's checks step sends
>    back only checks that failed; a not-run item goes on to verify and the merge gate, which say
>    "these checks could not be run on this runner: <reason> (<names>)", show the criteria they would
>    prove as Not proven, and refuse auto-merge. A not-run burns no build attempt.
> 6. **A start-up trial.** `sandboxTrial()` (exported from `local/runner-host/src/check-sandbox.ts`
>    for `sf-runner doctor` and the `checks` capability) runs a trivial command under a check's
>    settings; the host runs it before a job's checks (a pass stands 10 minutes). Where it fails
>    (Ubuntu's AppArmor restriction on unprivileged user namespaces, missing binaries) every check is
>    "not run: the sandbox could not start: …". CI has a job that leaves the restriction on and
>    asserts exactly that.
> 7. **Proof.** A CI check run proves a criterion only when the project's config requires it
>    (`protection.requiredChecks`, never `factory/verify`), not any job the PR added. The proof
>    iterates the approved spec's criteria: one the reviewer left out is Not proven, one it repeated
>    counts once, and the proven count is over the spec's criteria.
> 8. **Names and commands.** `run.handBack` refuses a result whose name isn't one of the item's
>    declared checks; the verdict ignores a stored result whose command differs from the current
>    declaration ("didn't run as declared").
> 9. **Gate files.** The tests-intact guard (ADR 0500) also flags lifecycle scripts and any other
>    package.json script, `packageManager`, overrides and allowed build scripts, the package
>    manager's config (`pnpm-workspace.yaml`, `.npmrc`, `.pnpmfile.cjs`, `.yarnrc*`, `bunfig.toml`),
>    and a lockfile change that moves the test tooling (vitest, jest, playwright, typescript, biome,
>    eslint, …); a lockfile GitHub didn't return is unreadable.
>
> **Known limits now.** On macOS the kill can miss a process that forks and exits between two reads
> of the process table (100 ms); it stays in its check's sandbox and can write only that check's dirs,
> which no later check uses, and it can reach only the allowlisted hosts through a proxy that ends
> with its check. There is no API to list the processes holding a macOS sandbox profile, so that is
> not done. A check can reach github.com and the other allowlisted hosts; on macOS it can talk to
> securityd (the owner's keychains are denied). Within a round, a check sees what the check before
> it left in the tree (that is how the install carries over), so an install's lifecycle scripts can
> change what the tests run: the guard flags any change to them, and a person sees it at the gate.

> **Amended 2026-11-12 (fourth review).** The fourth review, run on a Mac, found a "not run" check
> still let `factory/verify` pass, a leftover process could escape on macOS, a check could read the
> shared temp dirs there and reach no server it started, and the install step decided what the test
> runner was. What is now true:
>
> 1. **"Not run" is not success.** When any declared check did not run on the head, `factory/verify`
>    is posted as **action required**, titled "N declared checks could not be run on this runner:
>    <reason>", even with CI green and the reviewer approving. The packet's verdict still passes
>    (nothing a build can fix, so no build attempt is burned) and the item reaches the merge gate,
>    which shows those checks under their own heading, "Not run on this runner", apart from failures
>    and with the reason; their criteria are Not proven. `review.merge` refuses (`conflict`) unless
>    the person sends `mergeWithoutChecks: true` ("Merge without these checks" in the app). That
>    decision is recorded on the packet (`notRunWaived`: who, when, which checks), in the audit, and
>    in the gate's note, and `factory/verify` is posted again as success, saying a person merged
>    without them. Auto-merge stays refused (`pr.autoMerge`). The phone's merge doesn't send it yet:
>    it is refused there with the reason, and the person decides on the desktop app or the website.
> 2. **On a Mac, checks run in a check container.** The macOS OS sandbox can't close the leftover
>    process: a process that calls `setsid` behind a middle shell that exits inside the tracker's
>    100 ms poll is never seen, runs on after the job with the allowlisted network, and can exhaust
>    the process limit so later checks are "not run". A tracking loop can't close that, and Seatbelt
>    can't scope loopback per process (a rule names localhost or `*`, one port or `*`), so a check
>    either reaches the owner's services or none, its own server included. So a `sandbox` runner on
>    macOS runs each check in a fresh **check container** when a container runtime answers
>    (OrbStack, Docker Desktop; `container.docker` or `docker` on PATH), reusing the container
>    runner's check path (`execInCheckContainer`, the agent image, read-only root, every capability
>    dropped, no new privileges, a pids limit). For a local job it gets an internal network of its
>    own per check whose only way out is the image's egress proxy with the job's allowlist
>    (`allowedDomains(profile)`, not the model API): that is how install reaches the registry, as
>    srt's proxy does on Linux. Its loopback is private, so a test that starts a server works; when
>    its shell exits the container stops and every process in it dies; the container, proxy and
>    network are removed after every check. Its pnpm store is its own (`<check dir>/store`, empty at
>    the start of the round's first check), and nothing of the Mac's filesystem is mounted but the
>    check's tree and store. Each result says where it ran (`isolation`: `container`, `sandbox`,
>    `weaker-sandbox`; migration 0272).
> 3. **No container runtime: not run, unless the owner opts in.** Without one, every declared check
>    on a Mac runner is "not run: this Mac runner has no container runtime" (handled by 1). The
>    runner's owner may set `checks.weakerMacSandbox: true` in runner.json (only there: never from the
>    repo or the cloud) to use the macOS OS sandbox instead; the gate and `factory/verify` then say
>    the checks ran in the weaker sandbox. In that mode a check also can't read `/tmp`,
>    `/private/tmp` or the user's `/var/folders/<x>/<y>` (only its own dirs), can't run `launchctl`
>    (denied by path in the sandbox profile: it reads the owner's login session through the
>    bootstrap port, which the mach rules don't cover), and still has no loopback. **Its limit, in
>    plain words: a process a check starts can outlive the check, and keep running with the job's
>    allowlisted network after the job, until the Mac restarts or someone kills it.** It can still
>    write only that check's own dirs, which no later check uses.
> 4. **Linux stays on srt** (bubblewrap, private network and pid namespaces). Tested: the
>    setsid-behind-an-exiting-shell escape dies with the sandbox, and a server the check starts is
>    reachable on its own loopback.
> 5. **`sf-runner doctor`** reports which mode checks will run in and why (`checkModeReport`).
> 6. **The install step is trusted.** Each later check runs on the tree the previous one left,
>    `node_modules` and `.bin` included, so whatever install runs decides what the test runner is.
>    That is accepted because install is the project's own declared command, it runs inside the same
>    isolation as every check (so it can reach only the allowlist and write only its check's dirs),
>    and what it runs is a finding for a person: pnpm 10 runs no dependency's scripts unless the
>    project allows it (a package.json finding); for npm, a new or changed lockfile entry marked
>    `hasInstallScript` is a gate finding naming the package; yarn's lockfile doesn't say which
>    packages have scripts, so every dependency added or changed in yarn.lock is named. A finding
>    blocks auto-merge and is shown at the gate.
> 7. **Results are kept while their item is open and for 30 days after it ends** (done, failed,
>    rejected, cancelled): they are the merge gate's evidence. An hourly prune
>    (`pruneCheckResults`, minute 41) deletes at most 500 older rows a time, oldest first on
>    `core_check_results_created_idx` (migration 0272). A hand-back still drops an open item's
>    results for heads it replaced more than 30 days ago, never its current head's.

**Amended 2026-11-12 (fifth review).**

> 1. **A runner that dies mid-check leaves nothing for long.** A Mac check container is a foreground
>    `docker run --rm` beside an egress proxy on a network of its own, removed in a `finally`, which
>    a killed runner never reaches. A `sandbox` runner on a Mac now reaps every container carrying
>    the job label with role `check` or `egress`, and every check network, whose job it doesn't run:
>    at start-up (all of them) and on its periodic sweep (`reapCheckContainers`). Tested by killing
>    the runner mid-check on the real Docker.
> 2. **Check containers have limits.** By default 2 CPUs and 4 GB of memory, with `/tmp` a 1 GB
>    tmpfs inside that memory; a tree that grew past 10 GB isn't copied for the next check (that
>    check is not run, with the reason). runner.json `checks` sets each (`cpus`, `memoryGb`,
>    `tmpGb`, `maxTreeGb`). At most `checks.maxConcurrent` (default 1) checks run at once on a
>    runner; each counts as a heavy job on the heartbeat's capacity while it runs, and a check waits
>    to start while the load backoff (spec 43, ADR 0552) has stopped heavy work, for up to 10
>    minutes, then runs anyway.
> 3. **The egress proxy refuses non-public addresses.** An allowlisted name is resolved once by the
>    proxy, which connects to that address (no rebinding between the check and the connect), and is
>    refused when any address it resolves to is private, loopback, link-local, CGNAT (Tailscale),
>    benchmarking (OrbStack), multicast or reserved, or the runtime's host gateway
>    (`host.docker.internal` and its kin, resolved at start). Only the runner's own tests may exempt
>    an exact `host:port` (`--private-ok`).
> 4. **No packet, no merge.** For an item that runs the factory's checks, a merge gate with no review
>    packet for its head is refused (`conflict`, saying why): nothing says whether its checks ran.
> 5. **Not on the phone.** `review.merge` with `mergeWithoutChecks` is refused on the mobile surface
>    by the engine (`mobileRefuses`, pinned in the decidability test), with or without a
>    fingerprint, until the owner decides otherwise.
> 6. **The prune's reads are bounded by its limit.** It reads the next 500 rows older than the
>    cutoff after a cursor in `core_meta` (on `core_check_results_created_idx`), looks their items up
>    by primary key in one batch, deletes those whose item ended, and moves the cursor (back to the
>    start at the end), so rows read no longer grow with the number of finished items.
> 7. **A `sandbox` runner always declares `checks`** (back to the earlier decision; #115 had briefly
>    declared it only where a check could run, which left items stalled at build with no wait
>    reason). With no check exec, each declared check comes back not run with the reason (a Mac:
>    "this Mac runner has no container runtime (OrbStack is not answering): start it, or set
>    checks.weakerMacSandbox"), the item builds and reaches the gate, and the explicit
>    merge-without-checks decision applies. `sf-runner doctor` and Factory > Runners (the manifest's
>    `checksNote`, read by runner.list) say the same in one line. A sprite runner never declares
>    `checks`; a build that carries checks then waits with "no runner that can run this project's
>    checks is online" when no online runner declares it.

> **Amended 2026-11-13 (follow-ups to the fifth review).**
>
> 1. **A runner limit is a failure a person decides, not a fix round.** A check that fails on one
>    of the runner's own limits is a *failed* check (`limit` on the executed check, additive), never
>    "not run": the code under check may be what used the memory or the disk. It gets no fix round
>    (the agent can't raise a limit) and goes to a person through the ordinary checks-failing path,
>    not the merge-without-checks one meant for checks that never ran. Its log tail ends with "the
>    check hit the runner's memory limit (4 GB). The code under check may be the cause; raise the
>    limit in the runner's config or fix the code". A limit hit is read only from outside the check:
>    the memory limit from the Docker daemon's record (`docker inspect` State.OOMKilled, which is set
>    when any process in the container was OOM-killed: seen on Docker 29), the disk bound from the
>    host's own measure of the check's dir, every 15 s while it runs. The check container runs
>    without `--rm` so it can be inspected. *Re-review:* the first version also read the cgroup's
>    `pids.events` and `memory.events` and /tmp's free space from a line a wrapper printed after the
>    check's shell; the check could read the line's marker from `/proc/*/cmdline` and print a forged
>    line first, turning its own test failure into a "limit". That wrapper is gone. The pids limit and
>    a full /tmp are only visible from inside the container (its cgroup goes when it exits, and Docker
>    Desktop's host can't read it), so they are ordinary failures again, whose log shows the `fork`
>    or `No space left on device` error, and they get a fix round.
> 2. **A runner reaps only its own.** Every container and network carries `software-factory.runner`
>    with the runner's id beside the job label, and both reapers match on it: two runners on one
>    Docker daemon never remove each other's. One without the label (from before) is reaped by none.
> 3. **The egress proxy refuses every IPv6 form with an IPv4 address inside** (IPv4-compatible,
>    NAT64 and local-use NAT64, SIIT, 6to4, Teredo), after normalising the spelling; an IPv4-mapped
>    address is checked as its IPv4.
> 4. **The weaker macOS sandbox finds the user's `/var/folders` from `getconf`**
>    (`DARWIN_USER_TEMP_DIR`, `DARWIN_USER_CACHE_DIR`), never TMPDIR, which the launchd job doesn't set.
