# Spec 33: A container per job

Read first: the plan ([`.kim/plans/2026-11-11-run-agents-on-hosts-without-orca.md`](../../.kim/plans/2026-11-11-run-agents-on-hosts-without-orca.md),
"Isolation"), ADRs [0430](../adr/0430-a-container-per-job.md), [0380](../adr/0380-runner-local-tmux-and-hook-status.md),
[0270](../adr/0270-the-factory-launches-the-harness-and-verifies-it.md),
[0250](../adr/0250-runner-host-pushes-and-harness-projection.md), [0033](../adr/0033-per-job-github-app-tokens.md)
and [0023](../adr/0023-runners-are-owned-by-users.md); spec [30](30-runner-local-without-orca.md);
`packages/runner-local`, `packages/harness-claude`, `local/runner-host`.

This is piece 4 of 8 in the plan. Piece 3 (Claude accounts on a host) is built alongside it and
plugs into the credential seam below.

## Goal
On a runner set to container isolation, each job's Claude Code runs in its own Docker container,
and every stage runs with permissions off. The container sees only the job's own repo, has no home
dir and no host credentials, and reaches only the stage's allowed hosts and the model API. The host
stays outside and pushes with the job token, as now. `tmux attach` still takes the session over.

## Scope
- **`runner.json`**:
  - `"isolation": "sandbox" | "container"`, default `"sandbox"` (today's worktree and Claude
    sandbox).
  - `"container"`: `docker` (the CLI path, default found on PATH), `env` (the model credential:
    `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`), `allowedHosts` (more egress hosts for every
    job on this runner), `cpus`, `memory`, `pids`.
- **`packages/runner-local/src/container/`**, a separate module so the tmux adapter stays as it
  is:
  - `runtime.ts`: `ContainerRuntime` and `dockerRuntime`, over the `docker` CLI.
  - `image.ts`: the build context `packages/runner-local/container/` (`Dockerfile`,
    `egress-proxy.mjs`), its content-hash tag `software-factory-agent:<12 hex>`, and `ensureImage`
    (build if missing, once per process).
  - `egress.ts`: the job's allowlist (`allowedDomains(profile)` + `api.anthropic.com` + the
    runner's `allowedHosts`), and host matching (exact, `*.suffix`, ports 443 and 80 unless an entry
    names one). The proxy itself is `container/egress-proxy.mjs`: `CONNECT` and absolute-URI HTTP,
    403 otherwise, one log line per decision.
  - `job-repo.ts`: the self-contained job repo (ADR 0430 §3), the git dir check after the session
    (§9), and the credential scan (§8).
  - `spec.ts`: the container spec (mounts, env, user, limits, network), `docker run` argv,
    `container.sh`, and `containerProblems(record, inspect)`.
  - `adapter.ts`: `createContainerRunner(config)`, a `RunnerAdapter` that reuses runner-local's
    tmux session, status hook, events, artifacts and steering. It changes:
    - `prepareWorkspace`: the job repo under `<containersDir>/sf-<jobId>/` (`work`, `git`, `home`,
      `tmp`), and `projectHarness` with `isolation: "container"`, the container's Node for the
      status hook, `claude` for the binary, and `runTmp` in the job dir. It then writes the
      container record and `container.sh`, and seeds the home's `.claude.json` (onboarding done,
      the working tree trusted). A planning job goes to runner-local unchanged.
    - `startSession`: makes sure the image exists, creates the job network and the egress proxy,
      writes the credential env file, then runs runner-local's start with the container script as
      the launch script. The launch check reads the process through `docker exec … ps` and adds
      the container check (ADR 0430 §7). The env file is deleted once Claude is up.
    - `events`: on `session.ended` it keeps the proxy log, stops both containers, checks the job
      git dir and scans for the credential before it passes the end on. A failed check turns the
      outcome to `failed` with the reason, so nothing is pushed.
    - `collectArtifacts`: adds `egress-log`.
    - `release` (safe twice): kills the tmux session, removes both containers and the network,
      and removes the job dir, run dir and attachments with plain file operations.
    - `manifest`: runner-local's capabilities plus `container-isolation`.
  - `reapContainers` / `diagnoseContainers`: containers, networks and job dirs without a live
    job, by the label `software-factory.job`.
  - `checkRunningContainer(runDir)`: the launch and container check, for `sf-runner doctor`.
- **`packages/runner-local/src/adapter.ts`** (additive): a workspace may bring its own
  `readCommand` and `launchChecks`, which `startSession` uses before the prompt.
- **`packages/harness-claude`**:
  - `isolation: "sandbox" | "container"` on the settings options and `claudeArgv`.
  - With `container`, every stage's default mode is `bypassPermissions` (a profile's mode still
    wins), and `sandbox.enabled` and `failIfUnavailable` are `false`. Everything else in the
    settings is unchanged.
  - The launch record carries `isolation`.
- **`packages/runner-contract`**: the capability `container-isolation`.
- **`local/runner-host`**:
  - `buildRunner` wires `createContainerRunner` when `isolation` is `container`, with the
    credential seam `modelCredential(job)` (from `container.env`, else `CLAUDE_CODE_OAUTH_TOKEN` /
    `ANTHROPIC_API_KEY` in its environment). The host's reaping also reaps containers.
  - `doctor` checks Docker (server reachable, version), the image (built with `--fix`), the
    credential, and orphaned containers, but only on a container runner. Running container jobs
    are checked inside their containers.
  - `install` puts `docker` on the launchd PATH.
  - `paths().containersDir`.

## Out of scope
- Moving planning sessions into the container (their relay is on the host's loopback, ADR 0350).
- Apple's `container` CLI, Podman, rootless setups beyond "the `docker` CLI works for this user".
- Named Claude accounts and switching (piece 3), the dashboard (piece 2), Linux services (piece 5),
  the web terminal (piece 6), Sprites (piece 7), the chat UI (piece 8).
- A shared package cache across jobs.
- Injecting the credential at the proxy so it never enters the container.

## Acceptance criteria
1. With `"isolation": "container"`, a build job runs end to end on the M5 (Docker Desktop): the
   job repo, the container under tmux, the launch verified inside the container, the prompt sent,
   the run branch pushed by the host with the job token, and hand-back with artifacts. The PR goes
   green through `factory/verify`. A triage job also runs end to end in a container.
2. Every stage but planning runs `bypassPermissions` in a container, and a profile's mode for a
   stage still wins. A test checks the settings and argv for each stage.
3. The agent can't read the host home: it isn't mounted, and a file next to the job dir on the
   host isn't visible. Tested against a real container.
4. The agent can't reach a host off the allowlist: through the proxy it gets 403, and directly it
   gets no route. An allowlisted host works through the proxy. Tested against real containers.
5. The agent can write only its working tree, its git dir's objects and refs, its home and temp.
   Writes to the root filesystem, the run dir, the settings, `.claude/`, `.git`, the git dir's
   config and hooks, and alternates all fail. Tested against a real container.
6. The agent's commit in the container is pushed by the host with the job token. The owner's
   checkout is unchanged (branches, head, status, worktrees, config), and the job repo holds none of
   the checkout's other branches. Tested with the runner host's real git, and in the real-container
   test.
7. A live process or container that doesn't match its record (argv, settings, image, mounts,
   network, privileges) is killed before the prompt, and the job fails with
   `harness-config-mismatch`. Tested with a scripted `docker`.
8. A job git dir tampered with (a `commondir`, alternates, a changed config) is repaired, the job
   fails, and nothing is pushed. A session that writes the credential into the repo fails without a
   push. Tested.
9. `tmux -L software-factory attach -t sf-<jobId>` attaches to the live Claude in the container,
   and typing reaches it (live check on the M5).
10. `release` twice leaves no container, network, job dir, run dir or tmux session. After a killed
    host, `sf-runner doctor --fix` reaps them.
11. `sf-runner doctor` on a container runner reports Docker, the image and the credential, and
    `--fix` builds the image. A runner without `isolation` behaves exactly as before.
12. `pnpm lint`, `pnpm typecheck` and `pnpm test` pass. The real-container test is skipped when
    Docker isn't available.
