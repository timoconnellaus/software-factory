# @software-factory/runner-orca

The Orca runner adapter (ADR 0014, 0100), promoted from `spikes/runner-orca`. It implements
`RunnerAdapter` from `@software-factory/runner-contract` over the `orca` CLI (`--json`):

- **resolveCheckout** / **prepareWorkspace** (ADR 0260): finds the Orca repo whose canonical remote
  (`gitRemoteIdentity.canonicalKey` from `orca repo list`) is the job's `github.com/<owner>/<repo>`,
  usually the owner's own project, and creates the job's worktree **in that repo**, on the run branch,
  from the host's start point (the item branch's SHA as fetched into `refs/software-factory/heads/`, or
  the reviewed head for verify), tagged `sf-job:<jobId>`. Only when Orca has no repo for the remote
  does it register the host's clone, once and for good. It refuses a workspace whose branch Orca
  renamed (one branch per run), denies the harness reads of the main checkout, then projects
  `harness-claude`'s per-run settings.
- **startSession**: `orca agent launch --agent claude --surface terminal --prompt …`. Takeover hint: open
  the worktree and terminal in Orca.
- **events**: polls `orca worktree ps` (agent state, tool, last message) and pages `orca terminal read`.
  The session ends on `done` after the agent was seen working, or once `.factory-result.json` exists and
  the agent has been quiet for three polls. It fails after 15 minutes waiting on input.
- **collectArtifacts**: the terminal screen, the check output (tests, lint, typecheck) and the final
  message from Claude's transcript, and screenshots from Orca's browser (`browser` capability). The
  diff and the push are the runner host's job.
- **release**: closes terminals, removes the worktree and its empty parent folder, deletes the local
  run branch (only a `factory/…-run-<k>` branch) and the run dir. It never unregisters a repo. Safe
  to call twice.
- `reapOrphanWorktrees`: after a host crash, removes `sf-job:` worktrees the host isn't running.
- `migrateRunnerRepos` (`src/workspace.ts`): retires a clone the runner registered earlier next to the
  owner's repo for the same remote (removes its leftover job worktrees, unregisters it, deletes it),
  unless a live job uses it. `diagnose`: duplicate source repos per remote and orphaned job worktrees,
  for `sf-runner doctor`.

The spike's findings about the Orca CLI still apply. See `spikes/runner-orca/README.md`.
