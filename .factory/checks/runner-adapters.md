# Guidance: runner adapters and workspaces

From incident [2026-11-11 bootstrap #5](../../docs/incidents/2026-11-11-bootstrap.md#5-the-runner-added-a-second-orca-repo)
and [ADR 0260](../../docs/adr/0260-runners-attach-to-the-existing-checkout.md). Applies to any change
to `packages/runner-*`, `packages/harness-*` or `local/runner-host`.

- **Resolve existing workspaces by canonical identity.** A runner adapter finds the checkout its
  machine already has for a repo by `github.com/<owner>/<name>` (`canonicalRepoKey`), and makes each
  job's workspace (a worktree on the run branch) inside it.
- **Never create a duplicate registration.** Register a repo with the runner's own tool (Orca, a dev
  box's workspace list) only when none exists for that identity, and then once, permanently.
- **Per-job state is a worktree and a branch, nothing more.** `release` removes those; it never
  unregisters a repo or deletes a checkout.
- **The owner's checkout is read-only to the runner** except for the host's own refs
  (`refs/software-factory/*`) and the job worktrees: no remote or config changes, no checkout,
  commit or push in the main worktree, and the job token never touches disk.
- Test it against a scripted runner CLI: reuse of the existing repo, no second registration, no
  churn across consecutive jobs, the fallback clone registered once, and the token not in
  `.git/config` (see `local/runner-host/test/orca-workspace.test.ts`).

`runner-adapter-resolves-existing-repo.json` and `runner-never-rewrites-remotes.json` enforce the
parts a regex can see.

## A harness verifies its effective configuration after launch

From incident [2026-11-11 bootstrap #6](../../docs/incidents/2026-11-11-bootstrap.md#6-the-launcher-overrode-the-harnesss-permission-mode)
and [ADR 0270](../../docs/adr/0270-the-factory-launches-the-harness-and-verifies-it.md).

- **The harness owns its invocation.** Start it with the harness adapter's own launch command (for
  Claude: `harness-claude`'s launch script), never through a launcher that adds its own agent flags or
  loads the owner's agent config (`orca agent launch` adds the owner's permission mode).
- **Verify after launch, before any work.** Check the live process's flags against the launch record
  and the projected settings against their hash before the prompt is sent. On any difference, kill the
  session and fail the job with `harness-config-mismatch`.
- **No owner config.** No `user` setting source, no launcher plugins, and no launcher hook that can
  answer a permission decision.
- **The sandbox is the floor.** Every stage runs Bash in the sandbox with `allowUnsandboxedCommands:
  false`; a project's policy can only pick a mode and add to allowlists.
- `sf-runner doctor` runs the same check on running jobs.

`harness-verifies-its-launch.json` and `harness-sandbox-floor.json` enforce the parts a regex can see.
