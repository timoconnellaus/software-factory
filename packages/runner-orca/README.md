# @software-factory/runner-orca

The Orca runner adapter (ADR 0014, 0100), promoted from `spikes/runner-orca`. It implements
`RunnerAdapter` from `@software-factory/runner-contract` over the `orca` CLI (`--json`):

- **resolveCheckout** / **prepareWorkspace** (ADR 0260): finds the Orca repo whose canonical remote
  (`gitRemoteIdentity.canonicalKey` from `orca repo list`) is the job's `github.com/<owner>/<repo>`,
  usually the owner's own project, and creates the job's worktree **in that repo**, on the run branch,
  from the host's start point (the item branch's SHA as fetched into `refs/software-factory/heads/`, or
  the reviewed head for verify), tagged `sf-job:<jobId>`. Only when Orca has no repo for the remote
  does it register the host's clone, once and for good. It refuses a workspace whose branch Orca
  renamed (one branch per run), denies the harness reads of the main checkout (except its git dir, which
  the run's own git needs), then projects `harness-claude`'s per-run settings and launch script.
- **startSession** (ADR 0270):
  - Runs the harness's launch script in a visible Orca terminal
    (`orca terminal create --command "exec /bin/sh <runDir>/launch.sh"`), never `orca agent launch`,
    which adds the owner's own Claude flags.
  - Answers Claude's first-run folder trust dialog for the job's worktree, once.
  - Waits until Orca sees the agent in the job's own pane.
  - Checks the live process against the launch record (`verifyLaunch`). On a mismatch it closes the
    terminal and fails with `harness-config-mismatch`.
  - Only then sends the prompt (`terminal send --enter --wait-submit`).
  - Orca's status hooks are passed in the factory's settings (`orcaStatusHooks`), without the ones
    that can answer permissions.
  - Takeover hint: open the worktree and terminal in Orca.
- **events**: polls `orca worktree ps` (agent state, tool, last message) and pages `orca terminal read`.
  The session ends on `done` after the agent was seen working, or once `.factory-result.json` exists and
  the agent has been quiet for three polls. It fails after 15 minutes waiting on input.
- **collectArtifacts**: the terminal screen, the check output (tests, lint, typecheck) and the final
  message from Claude's transcript, and screenshots from Orca's browser (`browser` capability). The
  diff and the push are the runner host's job.
- **release**: closes terminals, removes the worktree and its empty parent folder, deletes the local
  run branch (only a `factory/…-run-<k>` branch) and the run dir. It never unregisters a repo. Safe
  to call twice.
- `checkRunningHarness(runDir)`: the same launch check for a running job, for `sf-runner doctor`.
- `reapOrphanWorktrees`: after a host crash, removes `sf-job:` worktrees the host isn't running.
- `migrateRunnerRepos` (`src/workspace.ts`): retires a clone the runner registered earlier next to the
  owner's repo for the same remote (removes its leftover job worktrees, unregisters it, deletes it),
  unless a live job uses it. `diagnose`: duplicate source repos per remote and orphaned job worktrees,
  for `sf-runner doctor`.

The spike's findings about the Orca CLI still apply. See `spikes/runner-orca/README.md`.
