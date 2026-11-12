# Spec 08: Runners update themselves

**Read first**: [ADR 0360](../adr/0360-runners-update-themselves-to-the-deployed-commit.md),
[ADR 0014](../adr/0014-runners-are-adapters.md) and [0100](../adr/0100-runner-contract.md) (the
runner contract), [ADR 0250](../adr/0250-runner-host-pushes-and-harness-projection.md), incidents
[2026-11-11 #8](../incidents/2026-11-11-bootstrap.md#8-agents-received-only-the-tail-of-their-prompts)
and #9.

## Goal
A runner runs the code the factory was deployed from, without anyone running commands on the
runner's machine. It updates only when idle, only to a commit that passed CI, `factory/verify` and
the merge gate, and it rolls back an update that doesn't start.

## Scope
- **The engine knows its commit.** The deploy passes `DEPLOYED_SHA`, the commit it deployed, to
  `sf-engine`.
- **The heartbeat carries both versions:**
  - the runner reports its commit, whether auto-update is on, and its update state;
  - the engine answers with `desiredVersion`;
  - `core_runners` records what the runner reported (migration 0130);
  - `runner.list` returns the runner's version, the desired one and the update state, and the app's
    runner health line flags a runner that is behind or blocked.
- **The runner host updates itself when its commit isn't the desired one.**
  1. **Check it can:** auto-update on, a clean checkout, on `main` or detached, the desired commit
     on `origin/main`, and moving forward only. Otherwise it reports `blocked` with the reason.
  2. **Drain:** it stops claiming (`waiting`). Jobs already running finish; none are cancelled.
  3. **Update once idle:** fetch and fast-forward to exactly that commit, run
     `pnpm install --frozen-lockfile`, write the update record, then exit non-zero so launchd
     starts the new code.
  4. **Confirm:** the first successful heartbeat on the new code marks the update as done.
- **Rollback:** the service runs through `bin/sf-runner-service`, a small `sh` wrapper that checks
  the update record before starting Node. After three starts without a confirmation, it resets the
  checkout to the previous commit, reinstalls and starts that, and the runner reports `rolled_back`
  with the reason. It won't try that commit again.
- **`sf-runner install`:**
  - puts Orca's bin directory on the service `PATH` (incident #9);
  - retries `launchctl bootstrap` when it fails straight after `bootout`;
  - installs the wrapper as the service's program.
- `sf-runner status` shows the version, the desired version, the update state and its reason.
- `autoUpdate: false` in the runner config turns it off, reported as `blocked`.

## Out of scope
- Signed releases or update channels. The trust is the default branch's: CI, `factory/verify` and
  the merge gate.
- Updating Node, Orca or Claude Code themselves.
- Runners that aren't launchd services. They report their version, but nothing restarts them.

## Acceptance criteria
1. A deploy sets `DEPLOYED_SHA`. The heartbeat returns it as `desiredVersion`, and a dev engine
   without it returns null.
2. **Behind and idle:** a runner fast-forwards to exactly the desired commit, reinstalls, records
   the update and exits non-zero. On the new code's first heartbeat it reports `current`.
3. **Behind but busy:** it claims nothing new and reports `waiting`. It updates when its last job
   ends, and no job is cancelled.
4. **Blocked:** a dirty checkout, a branch other than `main`, a desired commit not on `origin/main`,
   a backwards move or `autoUpdate: false` each give `blocked` with the reason. The runner carries
   on claiming on its current code.
5. **Rollback:** three starts without a confirmed heartbeat reset the checkout to the previous
   commit. The runner then reports `rolled_back` and doesn't retry that commit.
6. `runner.list` and the app show each runner's version against the desired one, and its update
   state.
7. **`sf-runner install` from a shell without Orca on its `PATH`** still gives the service Orca's
   bin directory. A bootstrap that fails right after `bootout` is retried.
