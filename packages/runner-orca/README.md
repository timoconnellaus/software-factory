# @software-factory/runner-orca

The Orca runner adapter (ADR 0014, 0100), promoted from `spikes/runner-orca`. It implements
`RunnerAdapter` from `@software-factory/runner-contract` over the `orca` CLI (`--json`):

- **prepareWorkspace**: registers the runner host's clone in Orca if needed. It creates a worktree on
  the job's run branch, from the host's start point (`origin/<item branch>`, or the reviewed head for
  verify), tagged with the comment `sf-job:<jobId>`. It refuses a workspace whose branch Orca renamed
  (one branch per run). Then it projects `harness-claude`'s per-run settings.
- **startSession**: `orca agent launch --agent claude --surface terminal --prompt …`. Takeover hint: open
  the worktree and terminal in Orca.
- **events**: polls `orca worktree ps` (agent state, tool, last message) and pages `orca terminal read`.
  The session ends on `done` after the agent was seen working, or once `.factory-result.json` exists and
  the agent has been quiet for three polls. It fails after 15 minutes waiting on input.
- **collectArtifacts**: the terminal screen, the check output (tests, lint, typecheck) and the final
  message from Claude's transcript, and screenshots from Orca's browser (`browser` capability). The
  diff and the push are the runner host's job.
- **release**: closes terminals, removes the worktree and its empty parent folder, deletes the local
  branch and the run dir, and unregisters a repo it registered once no job uses it. Safe to call twice.
- `reapOrphanWorktrees`: after a host crash, removes `sf-job:` worktrees the host isn't running.

The spike's findings about the Orca CLI still apply. See `spikes/runner-orca/README.md`.
