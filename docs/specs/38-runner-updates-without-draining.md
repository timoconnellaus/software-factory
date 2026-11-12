# Spec 38: runner updates without draining on every deploy

Read first: ADRs [0520](../adr/0520-runners-keep-claiming-while-an-update-waits.md),
[0360](../adr/0360-runners-update-themselves-to-the-deployed-commit.md) (and spec
[08](08-runner-auto-update.md)), [0301](../adr/0301-runner-capacity-has-heavy-and-light-pools.md),
[0016](../adr/0016-signed-runner-channel.md); `local/runner-host/src/self-update.ts`,
`local/runner-host/src/host.ts`, `scripts/deploy/`, `packages/runner-contract/src/wire.ts`.

## Goal
A merge to `main` no longer stops a runner taking work. A runner updates only when runner code
changed, at its first idle moment, and a busy runner still gets there within a bound. Only a change
the engine marks as breaking makes a runner stop claiming at once.

## Scope
- **The deploy computes the runner commit.** `scripts/deploy/lib.ts`:
  - `runnerPackageDirs()`: `local/runner-host`, `packages/runner-*`, `packages/harness-*` and their
    workspace dependency closure (`dependencies`, `optionalDependencies`, `peerDependencies` on
    `workspace:` versions, read from the package.json files);
  - `runnerSha(sha)`: `git log -1 --first-parent <sha> -- <those dirs> package.json
    pnpm-lock.yaml pnpm-workspace.yaml .nvmrc`, or null in a shallow clone or when nothing
    matches;
  - `deployArgs` passes `--var RUNNER_SHA:<sha>` to a Worker that declares `RUNNER_SHA`, next to
    `DEPLOYED_SHA`. The Deploy workflow checks out with `fetch-depth: 0`.
- **The engine stays dumb.** `sf-engine` declares `RUNNER_SHA` (empty by default). The heartbeat
  answers `desiredVersion` = `RUNNER_SHA` if it is a full SHA, else `DEPLOYED_SHA`, else null, and
  `minRunnerCompat` = `RUNNER_COMPAT`. `runner.list` shows the same desired version. The inbox health
  line says `behind` only for a runner that doesn't report itself `current`.
  - It stores the runner's reported `compat` (`core_runners.compat`, migration 0290; missing counts
    as 1), and `job.claim` returns no job to a runner below `RUNNER_COMPAT`.
  - It places no planning job on a runner that reports `waiting`, and a heartbeat reporting
    `waiting` with `claims: none` asks the runner's oldest idle planning session to yield.
- **The contract.** `RUNNER_COMPAT` (a number, 1) in `packages/runner-contract`, with the
  compatibility rule in its comment. The heartbeat response gains `minRunnerCompat`, the heartbeat
  request gains `compat`, and the runner's update report gains `claims` (`all`, `light`, `none`),
  all optional. `RUNNER_UPDATE_STATES` is unchanged.
- **The host.**
  - A checkout at or ahead of the desired commit (`merge-base --is-ancestor desired HEAD`) with
    HEAD on `origin/main` is `current`. "Would go backwards" is gone; a checkout with its own
    commits is still `blocked`.
  - Behind, able to update, jobs running: `waiting`, and the host keeps claiming. The first
    heartbeat with no job running applies the update as before (spec 08).
  - Pending for `heavyAfterMs` (30 min): the host reports its heavy pool full (`max` = heavy jobs in
    use) on the heartbeat and the claim, and claims light jobs only.
  - Pending for `allAfterMs` (60 min): it claims nothing.
  - `minRunnerCompat` above the code's `RUNNER_COMPAT`: it claims nothing at once, whatever the
    update state; it updates when idle if it can, else it reports `blocked` with both reasons. A
    host with no self-update (not a git checkout) also claims nothing, and logs it once.
  - The caps' timer is kept in `<stateDir>/update-pending-since`: a restart keeps it, and a
    transient failure (a fetch, a git error) doesn't reset it.
  - `runner.json` `updateCaps: { heavyAfterMinutes, allAfterMinutes }`, for tests only.
- **Docs:** ADR 0520, a dated amendment to ADR 0360, `docs/deploying.md`, the runner-host README,
  `docs/architecture.md`.

## Out of scope
- Re-adopting live jobs after a restart, so an update needs no idle moment at all: spec 39.
- Ending a planning session a person is actively in for an update.
- Any change to `CONTRACT_VERSION`, or the dashboard beyond the health line's rule.

## Acceptance criteria
1. A runner behind the desired commit with a job running reports `waiting` and claims the next
   queued job, heavy or light. When its last job ends, the next heartbeat updates it (fast-forward,
   install, exit 75). No job is cancelled.
2. After the update has been pending 30 minutes, the runner claims a queued triage job but not a
   queued build; the verify it was already running finishes and hands back. Its heartbeat and claim
   report the heavy pool full.
3. After 60 minutes it claims nothing, light jobs included, and updates once the running ones end.
4. A heartbeat with `minRunnerCompat` above the runner's `RUNNER_COMPAT` stops all claims from that
   heartbeat, before any cap; the runner updates when idle. A runner that can't update (auto-update
   off) claims nothing and reports `blocked` with the reason. A host without self-update claims
   nothing.
5. `runnerSha` in a scratch git repo: engine-only and devDependency-only commits don't move it; a
   commit to a package the runner depends on transitively does, and so do a lockfile change and a
   revert of a runner change; a merged PR gives the merge commit, not the branch's commit; a shallow
   clone gives null and the deploy falls back to `DEPLOYED_SHA`.
6. A runner ahead of the desired commit (on a later deployed commit of main) is `current`, doesn't
   move, and claims as usual, even with auto-update off or local changes. One with unpushed commits
   on top of it is `blocked`.
7. The heartbeat answers `desiredVersion` = `RUNNER_SHA` when it is set and valid, else
   `DEPLOYED_SHA`, and always `minRunnerCompat`.
8. The engine: a runner that reported a `compat` below `RUNNER_COMPAT` gets no job; one that
   reported none gets jobs. A capped heavy pool (`max` = `inUse`) gets a queued triage job, not a
   queued build. A runner reporting `waiting` gets no planning job (a triage job, yes); a heartbeat
   with `claims: none` makes its idle planning session's next wait answer `yield: true`.
9. The caps' timer survives a transient git failure and a restart, and clears once current.
10. `pnpm lint`, `pnpm typecheck`, `pnpm test` and `node --test "scripts/*/*.test.ts"` pass.
