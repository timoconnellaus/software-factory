# ADR 0661: A run can run in a container on the runner's own machine

Status: accepted, 2026-11-18. Brings back [ADR 0430](0430-a-container-per-job.md), smaller.
Builds on [0270](0270-the-factory-launches-the-harness-and-verifies-it.md),
[0410](0410-claude-accounts-live-on-the-host.md) and [0660](0660-the-core-is-a-small-workflow-engine-with-plugins.md).

## Context
A run's Claude Code works on the runner's machine, held in by Claude Code's own OS sandbox and an
allowlist (ADR 0270). The floor is a set of rules inside the program it constrains, and a run
without a repository stays on `dontAsk`, so it can't install or run what it needs. Other factories
(Mastra's, OpenHands) run each agent in a sandbox. The owner wants that, with Claude Code still on
their own machine and their own subscription.

ADR 0430 built a container per job and was deleted with the old pipeline (spec 70). Most of it was
an egress proxy, a credential scan and checks of the old stages.

## Decision
1. **`runner.json` `"isolation": "container"`**, per runner; `sandbox` stays the default. A
   container runner declares `container-isolation`.
2. **Docker over its CLI** (Docker Desktop, OrbStack, Docker Engine), behind a small
   `ContainerRuntime` interface, so another sandbox (Apple's `container`, a remote one) is another
   implementation. The image (`software-factory-agent:<hash>`: Node 24, git, a toolchain, a pinned
   Claude Code) is built by the runner from a Dockerfile held as text, on first use.
3. **The run's session runs the container in the foreground** (`docker run -it` in tmux, `-i` for a
   stream-json session), and the harness's own launch script runs inside it, so `tmux attach`, the
   status hook, the launch check (read with `ps` inside the container) and steering are unchanged.
4. **A repo run works in its own job repo** (ADR 0430 §3): a new repo holding only the start point,
   never a worktree of the owner's checkout. Its config, hooks, `info` and `objects/info` are
   mounted read only, and after the session the container is removed and the git dir checked and
   put back before the host's git (commit leftovers, push with the job token) touches it.
5. **The container sees only** its working tree, a fresh home, its temp dir, the run dir (read
   only, except the status and pid files), the account's token file (read only) and a passwd file
   naming the runner's uid. It runs as the runner's user with a read-only root, every capability
   dropped and no new privileges. No host home, keychain, SSH keys, Docker socket or checkout.
6. **Permissions off inside**: every run in `bypassPermissions`, Claude's own sandbox off. The
   container is the floor.
7. **A token account is required** (`claude setup-token | sf-runner account add <name>
   --token-stdin`). A login lives in the macOS Keychain and can't be handed over.

Left out, until someone needs them: an egress allowlist (the container has Docker's default
network), the credential scan, CPU and memory limits, a project's own image (`.devcontainer`), and
remote sandboxes.

## Consequences
- A run can install packages, run tests and start servers inside its container, with or without a
  repository.
- Jobs start a few seconds slower; the first job on a machine waits for the image build.
- The model token is inside the container (it always was inside Claude's process). An agent could
  send it out over the open network; the owner can revoke it with `claude setup-token` again.
- `sf-runner doctor` checks Docker, the account and the image. The reaper removes this runner's
  containers whose job it no longer runs.
