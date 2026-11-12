# ADR 0430: A container per job

Status: accepted, 2026-11-12. Plan:
[`.kim/plans/2026-11-11-run-agents-on-hosts-without-orca.md`](../../.kim/plans/2026-11-11-run-agents-on-hosts-without-orca.md)
(piece 4, "Isolation"). Spec [33](../specs/33-container-per-job.md). Builds on
[0380](0380-runner-local-tmux-and-hook-status.md), [0270](0270-the-factory-launches-the-harness-and-verifies-it.md),
[0250](0250-runner-host-pushes-and-harness-projection.md), [0033](0033-per-job-github-app-tokens.md),
[0052](0052-job-tokens-and-branch-confinement.md) and [0023](0023-runners-are-owned-by-users.md). Amends 0270.

## Context
`runner-local` (ADR 0380) runs Claude Code on the host, in a git worktree of the owner's checkout,
held in by Claude Code's own OS sandbox and settings (ADR 0270). That works, but the floor is a
set of rules inside the very program it constrains. Every stage except build stays on `dontAsk`
with an allowlist, because the sandbox only covers Bash. The deny list grows with every new way
to reach a credential. A worktree also shares the checkout's whole git dir: every branch, every
object, the config and the hooks.

The owner wants every stage to run with permissions off, on long-lived hosts (the Macs now, Linux
later), and the same boundary to carry over to cloud sandboxes (plan piece 7).

## Decision
1. **Opt-in per runner: `runner.json` `"isolation": "container"`.** The default stays
   `"sandbox"` (ADR 0270). A container runner declares the new capability `container-isolation`,
   so a project's policy can require it per stage (`requires`) later. Planning sessions (ADR 0350)
   still run on the host: their MCP server and hooks reach the host's relay on `127.0.0.1` and run
   from the runner's source tree. Moving them is a follow-up, so a policy must not require
   `container-isolation` for `planning` yet.
2. **Docker, behind a small runtime interface.** Docker Desktop on the Mac (and OrbStack, which
   speaks the same API) and Docker Engine on Linux, through the same `docker` CLI calls. The
   interface (`ContainerRuntime`: info, image, network, run argv, exec, inspect, logs, remove, list)
   leaves room for Apple's `container` CLI later. It isn't built.
3. **The agent's workspace is a self-contained job repo, not a linked worktree.** A linked
   worktree's `.git` file points at the checkout's common git dir: mounting it would hand the
   agent every branch, the config and the hooks, and leaving it out breaks git. A reference clone
   (`--reference`, alternates) still exposes every object of the checkout. So the host makes a
   new repo per job:
   - `git init --separate-git-dir` gives a working tree (`<job>/work`) and a git dir
     (`<job>/git`).
   - It fetches from the checkout only the start point's history and the default branch (for
     the ADR 0320 merge), through a temporary ref in the factory's own namespace
     (`refs/software-factory/jobs/<jobId>`), which is deleted straight after.
   - It checks out the run branch. Nothing of the owner's other branches or uncommitted work is
     in it.
   - The host's own git steps (merge the default branch, check the config, commit leftovers,
     push with the job token, diff) run on this repo exactly as they ran on the worktree. The
     checkout is never changed beyond that one temporary ref.
   - The cost is one local fetch of the start point's history per job (seconds for this repo).
4. **What the container sees, at the same absolute paths as on the host,** so the harness's
   projected paths (settings, launch script, status file, transcript) hold inside and out:
   - the job's working tree, read-write;
   - its `.git` file and `.claude/`, read-only;
   - its git dir, read-write, with `config`, `hooks`, `info` and `objects/info` read-only;
   - the run dir, read-only (settings, launch script, git identity, status hook). Only the status
     file and the pid file inside it are writable;
   - a fresh per-job home (`HOME`), the run's temp dir and its own pnpm store, read-write;
   - the run's attachments, read-only;
   - a tmpfs `/tmp`.

   Nothing else: no host home, no `~/.ssh`, no keychain, no Docker socket, no owner checkout.
   The root filesystem is read-only. The container gets `--cap-drop ALL`, `no-new-privileges`,
   `--init` and a pids limit, and runs as the host user's uid and gid so its writes belong to the
   host user.
5. **Egress is an allowlist proxy.** Each job gets an `--internal` Docker network, which has no
   route out and no outside DNS, and its own proxy container (the same image, `egress-proxy.mjs`)
   on that network and on the default bridge. The agent's `HTTPS_PROXY`/`HTTP_PROXY` point at it.
   - It allows `CONNECT` and plain HTTP only to the stage's hosts: `allowedDomains(profile)` from
     ADR 0270 (npm, GitHub, Cloudflare, plus the project's), plus the model API
     (`api.anthropic.com`).
   - Only ports 443 and 80, unless an entry names a port. Everything else gets 403.
   - Its log of decisions becomes the run's `egress-log` artifact.

   Nothing to set up on the host, and it works the same on Docker Desktop and Engine. A cloud
   sandbox can run the same proxy.
6. **Every stage runs `bypassPermissions`** under container isolation, unless the project's
   policy picks another mode for a stage. **Claude Code's own sandbox is off inside the
   container.** Its Linux backend (bubblewrap) needs user namespaces that Docker's default seccomp
   profile blocks, and loosening the container to allow them would weaken the outer boundary. The
   rest of ADR 0270's settings stay as defence in depth: deny rules, the credential-free
   environment, `--setting-sources project,local`, and the status hook.
7. **The launch check holds, inside the container.** The tmux pane (ADR 0380) runs
   `<runDir>/container.sh`, which `exec`s `docker run -it …` with the harness's unchanged
   `launch.sh` as the command, so `tmux attach` still takes over the live Claude. Before the prompt,
   the runner checks:
   - the live process: `docker exec <container> ps -o command= -p <pid>`, where the pid is the
     in-container pid the launch script recorded. It must equal the launch record's argv exactly;
   - both settings copies' sha256, as before;
   - the container itself, against the container record (`<runDir>/container.json`, from
     `docker inspect`): image id, user, read-only root, dropped capabilities, no new privileges,
     not privileged, only the job's network, no published ports, no devices, and exactly the
     expected mounts.

   Any difference kills the container and fails the job with `harness-config-mismatch`.
   `sf-runner doctor` runs the same check on running container jobs.
8. **One secret inside: the model credential.** It is the host owner's (ADR 0023) and goes in as
   an environment variable (`CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`, or
   `ANTHROPIC_API_KEY`). A Mac keeps its Claude login in the Keychain, which a container can't
   read, so a token is the one form that works on every host.
   - It comes from the job's **Claude account** (ADR 0410), the host's active one when the
     workspace was prepared:
     - a **token account**: its token, read from its 0600 file;
     - a **login account**: refused before anything is made. Container isolation needs a token
       account, and `doctor` says so. A login's credentials are in the macOS Keychain, or in its
       config dir next to every other conversation on the account. Mounting that dir would hand the
       agent a refreshable login and the account's history;
     - `default`: `runner.json` `container.env` (0600, next to the runner key), else `sf-runner`'s
       own environment.

     The account's config dir and token file are never mounted. Claude in the container uses its
     own home's `.claude`, where the run's transcript is.
   - It travels by `--env-file`: a 0600 file outside every mount, deleted once Claude is up. It is
     never in an argv.
   - The seam is `modelCredential(job, account)` (`credentialForAccount` by default).
   - Since the agent can read its own environment, tight egress matters. When the session ends,
     the host also scans everything it would push for the credential: the new objects, the
     uncommitted changes and the untracked files. If it finds it, it fails the job and pushes
     nothing.
9. **The host stays outside and pushes, as before** (ADR 0250, 0033). The agent commits into the
   job repo. When the session ends, the runner stops the container and checks the job git dir
   before the host runs any git there:
   - no `commondir`, `gitdir`, `config.worktree`, `worktrees/` or alternates;
   - `config` unchanged, `hooks` empty;
   - `.git` still pointing at the job's own git dir.

   Anything off is removed and the job fails without a push. Then the host's unchanged steps
   (config check, leftovers, push with a fresh job token, diff) run on the job repo. Release
   removes the containers, the network and the job dir with plain file operations, never git, so
   a tampered job repo can't run anything on the host.
10. **The image is in the repo**: `packages/runner-local/container/Dockerfile`, with Node 24, git,
    procps, build tools, corepack/pnpm, ripgrep, jq and Claude Code at a pinned version. It is
    tagged `software-factory-agent:<sha256 of the build context, 12 hex>`. `sf-runner` builds it
    on first use, or `sf-runner doctor --fix` does. Jobs run it by image id. Plan piece 7 reuses
    the image and the proxy.

## Consequences
- Every stage can edit, run and install freely, inside the container. Triage and spec no longer
  depend on an allowlist keeping up with what they need.
- A container job never sees the owner's checkout or other branches, so `checkouts` (ADR 0260)
  only saves the network fetch.
- Jobs start a few seconds slower (a local fetch, two containers), and the first job on a host
  waits for the image build (a few minutes).
- The pnpm store is per job, not shared, so installs download every time. A shared read-only
  cache can come later.
- `tmux attach` still works. Docker's detach keys are set to `ctrl-^ ctrl-_`, so `ctrl-p` reaches
  Claude.
- The credential scan is defence in depth: an agent can encode the token. The real limits are the
  egress allowlist, a credential per host that its owner can revoke (`claude setup-token` again),
  and review before merge.
- On Linux the runner's user must be able to use Docker (the `docker` group, or rootless Docker).

> Amends [ADR 0270](0270-the-factory-launches-the-harness-and-verifies-it.md): under container
> isolation the container is the floor. The Claude sandbox is off, and every stage's default
> mode is `bypassPermissions`. The launch check runs inside the container, and a container check
> is added.
