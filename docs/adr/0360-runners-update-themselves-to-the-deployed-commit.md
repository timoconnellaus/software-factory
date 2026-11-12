# ADR 0360: Runners update themselves to the deployed commit

Status: accepted, 2026-11-12. Spec [08](../specs/08-runner-auto-update.md). Builds on
[ADR 0014](0014-runners-are-adapters.md), [0100](0100-runner-contract.md) and
[0250](0250-runner-host-pushes-and-harness-projection.md).

## Context
The runner host runs from a git checkout on a person's machine, and nothing updated it. After the
fix for incident #8 merged, the M5's runner kept running the old code until someone SSH'd in:
1. `git pull` and `sf-runner install` restarted the service, which cancelled a running build and
   cost work item #4 a retry.
2. The SSH session's `PATH` had no Orca, so the service couldn't start jobs (incident #9).
3. `launchctl bootstrap` failed straight after `bootout`, so the runner was briefly down.

A runner that lags `main` is a silent failure mode: the factory looks healthy while its jobs run old
code.

## Decision
1. **The deployed commit is the version.** The deploy passes `DEPLOYED_SHA` to `sf-engine`, and the
   heartbeat answers with it as `desiredVersion`.
   - A runner never chases `main`'s tip. It runs exactly what the cloud runs, a commit that passed
     CI, `factory/verify` and the merge gate.
   - The trust is the same as the cloud deploy's, so no extra gate is added.
2. **Update only when idle.** A runner behind the desired commit stops claiming and lets its jobs
   finish. Then it fast-forwards to exactly that commit, reinstalls with a frozen lockfile and exits
   non-zero, and launchd restarts it on the new code.
   - No `launchctl` from inside the runner, and no `sf-runner install`.
3. **Refuse rather than guess.** The runner reports `blocked` with the reason, and keeps working on
   its current code, when:
   - its checkout has local changes;
   - it isn't on `main` (or detached);
   - the desired commit isn't on `origin/main`;
   - the move would go backwards;
   - auto-update is off.
4. **Rollback lives outside the code being updated.** launchd starts a small `sh` wrapper that reads
   the update record before starting Node. After three starts with no confirmed heartbeat, it resets
   to the previous commit and the runner reports `rolled_back`. The wrapper is in the repo too, so
   a broken wrapper is the one case a person must fix. It is kept tiny for that reason.
5. **Visible:** the runner reports its version and update state on every heartbeat. `core_runners`
   records them, and `runner.list`, the app's health line and `sf-runner status` show them.

## Consequences
- A merged runner fix reaches every runner within one idle moment of the deploy.
- **A broken runner commit is bounded:** it can only arrive through the merge gate, and an update
  that doesn't start is rolled back.
- Moving existing runners to the wrapper takes one manual `sf-runner install`. After that, updates
  happen on their own.
- **Not handled:** an update that starts but misbehaves later (heartbeats fine, jobs fail). That is
  caught by incidents, not by the updater.
