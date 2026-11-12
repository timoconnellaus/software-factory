# Guidance: runner adapters and workspaces

From incident [2026-11-11 bootstrap #5](../../docs/incidents/2026-11-11-bootstrap.md#5-the-runner-added-a-second-orca-repo)
and [ADR 0260](../../docs/adr/0260-runners-attach-to-the-existing-checkout.md) (amended by
[ADR 0380](../../docs/adr/0380-runner-local-tmux-and-hook-status.md)). Applies to any change
to `packages/runner-*`, `packages/harness-*` or `local/runner-host`.

- **Resolve existing workspaces by canonical identity.** A runner adapter finds the checkout its
  machine already has for a repo by `github.com/<owner>/<name>` (`canonicalRepoKey`), and makes each
  job's workspace (a worktree on the run branch) inside it.
- **Never create a duplicate checkout or registration.** runner-local finds the owner's checkouts
  under the `checkouts` dirs in `runner.json`; only when none matches does the host clone, once, and
  keep it. A runner with its own workspace registry (a dev box) registers a repo only when none
  exists for that identity, and then once, permanently.
- **Per-job state is a worktree, a branch and a session, nothing more.** `release` removes those
  (safe twice); it never unregisters a repo or deletes a checkout.
- **The owner's checkout is read-only to the runner** except for the host's own refs
  (`refs/software-factory/*`) and the job worktrees: no remote or config changes, no checkout,
  commit or push in the main worktree, and the job token never touches disk.
- Test it over real git with a scripted terminal (runner-local's `scriptedTmux`): reuse of the
  existing checkout, nothing changed in it across consecutive jobs, the fallback clone made once, and
  the token not in `.git/config` (see `local/runner-host/test/local-workspace.test.ts`).

`runner-adapter-resolves-existing-repo.json` and `runner-never-rewrites-remotes.json` enforce the
parts a regex can see.

## Sessions run on the factory's own tmux socket

From [ADR 0380](../../docs/adr/0380-runner-local-tmux-and-hook-status.md).

- **Never touch the owner's tmux.** Every tmux call goes through runner-local's `tmuxCli`, which
  targets `tmux -L software-factory -f /dev/null`: the factory's own server, without the owner's
  `~/.tmux.conf`. A job's session is `sf-<jobId>`; the takeover hint is
  `tmux -L software-factory attach -t sf-<jobId>`.
- **Status comes from hooks, not the screen.** The harness projects its own status hook, which only
  records events to `<runDir>/status.jsonl` and always answers `{}`; it never decides a permission.
  A `Stop` before the prompt was submitted never ends a job.
- The harness's deny list includes `tmux` (and `orca`), so an agent can't drive its own session or
  anyone else's.

`runner-tmux-own-socket.json` enforces it.

## A harness verifies its effective configuration after launch

From incident [2026-11-11 bootstrap #6](../../docs/incidents/2026-11-11-bootstrap.md#6-the-launcher-overrode-the-harnesss-permission-mode)
and [ADR 0270](../../docs/adr/0270-the-factory-launches-the-harness-and-verifies-it.md).

- **The harness owns its invocation.** Start it with the harness adapter's own launch command (for
  Claude: `harness-claude`'s launch script), never through a launcher that adds its own agent flags or
  loads the owner's agent config (Orca's `agent launch` added the owner's permission mode, the
  incident that set this rule).
- **Verify after launch, before any work.** Check the live process's flags against the launch record
  and the projected settings against their hash before the prompt is sent. On any difference, kill the
  session and fail the job with `harness-config-mismatch`.
- **No owner config.** No `user` setting source, no launcher plugins, and no launcher hook that can
  answer a permission decision.
- **The sandbox is the floor.** Every stage runs Bash in the sandbox with `allowUnsandboxedCommands:
  false`; a project's policy can only pick a mode and add to allowlists.
- `sf-runner doctor` runs the same check on running jobs.

`harness-verifies-its-launch.json` and `harness-sandbox-floor.json` enforce the parts a regex can see.

## The prompt travels as a file, never as typed input

From incident [2026-11-11 bootstrap #8](../../docs/incidents/2026-11-11-bootstrap.md#8-agents-received-only-the-tail-of-their-prompts).

- **Never type a job's prompt into a terminal.** A multi-kilobyte paste into an agent's terminal
  can arrive truncated, and the agent then works on a fragment. Write the full prompt to the
  harness's prompt file in the worktree (`.factory-prompt.md`, excluded from git like the result
  file) and send only the harness's one-line pointer to it.
- Test that the terminal only ever receives the pointer, and that the file holds the prompt exactly.

`runner-sends-the-prompt-as-a-file.json` enforces it.
