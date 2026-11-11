# ADR 0250: The runner host pushes; the harness gets a projected settings file and no credentials

Status: accepted, 2026-11-11 (V1 step 3, the runner). Builds on [ADR 0017](0017-harness-adapters.md),
[0033](0033-per-job-github-app-tokens.md), [0035](0035-lease-fencing-and-one-branch-per-run.md),
[0052](0052-job-tokens-and-branch-confinement.md) and [0100](0100-runner-contract.md).

## Context
V1 runs Claude Code in Orca terminals on the M5. Orca starts Claude with Orca's own environment and
has no launch arguments or environment option yet (spike finding 7). So the harness process inherits
whatever the owner's Orca has: `SSH_AUTH_SOCK`, the macOS keychain git helper, `gh`'s stored login,
cloud CLI logins. ADR 0033 says the harness must run without them, and push only the run branch
with the per-job App token.

## Decision
1. **The host pushes, not the harness.** The harness commits; the runner host (`local/runner-host`)
   pushes `HEAD` to `refs/heads/<job.branch>` after the session, with a fresh job token. The token is
   never written to the worktree, never in a process's arguments, and never in the harness's
   environment. The host checks that the branch is the job's run branch (`<baseRef>-run-<runNo>`,
   `factory/<n>-<slug>-run-<k>`) and that the token's `pushBranch` matches, and it never forces. Its
   git calls run with no system or global config, hooks off, protocol allowlists, and a credential
   helper that answers only `github.com`. Tokens are revoked (`DELETE /installation/token`) when the
   job ends.
2. **The host owns the clone.** One clone per repo under the runner's state dir, fetched with the job
   token. Its `origin` push URL is disabled and it has no credential helper. The runner never uses
   the owner's own checkouts.
3. **The config check before a push.** The host snapshots the clone's push-relevant git config
   (remotes, `url.*.insteadOf`, credential helpers, `http.*`, includes, hooks path, filters) after
   preparing the workspace and compares it before pushing. If anything changed, it doesn't push and
   the run fails.
4. **A projected settings file.** `harness-claude` writes `.claude/settings.local.json` into the
   worktree, rather than `.claude/settings.json`: the local file is Claude Code's per-checkout scope,
   ranks above a repo's committed settings, and is never part of the repo. It and `.factory-result.json`
   are excluded in the clone's `info/exclude`. The file sets:
   - a permission profile per stage. `dontAsk` everywhere by default, so an unattended run is refused
     rather than stalled. Triage and spec may read and write only the result file; verify may also
     run the toolchain; build may edit, commit and run the toolchain. The runner owner can choose
     another mode per stage (e.g. `auto` for builds).
   - deny rules: `git push|remote|config|fetch|…`, `gh`, `ssh`, `wrangler`, cloud CLIs, `orca`,
     `security`; reads of `~/.ssh`, `~/.config/gh`, the runner's key and clones.
   - an environment that blanks credential variables and points git (`GIT_CONFIG_NOSYSTEM`,
     `GIT_CONFIG_GLOBAL` → a per-run config with no helper), `gh`, wrangler and cloud CLIs at empty
     per-run directories.
5. **Completion.** A session is over when Orca reports the agent `done` after it was seen working,
   or when the result file exists and the agent has been quiet for three polls. A session waiting on
   a person for 15 minutes fails (it can be taken over in Orca before then).

## Consequences
- A leaked or misused job token can't come from the harness: it never has one. A harness that rewires
  git to redirect the host's push is caught by the config check.
- The settings file is defence in depth, not a sandbox. A determined harness process can still read
  files the owner can read (Bash `cat` is not the Read tool). An OS sandbox (Claude Code's `sandbox`
  setting, or Orca launch options) is the follow-up.
- Builds that leave changes uncommitted still produce a branch: the host commits the leftovers with a
  clear message and says so in the summary. A build with no commits fails.
- Moving the projection into Orca launch arguments, once Orca has them, changes only `runner-orca`.

## Open questions
- Whether to turn on Claude Code's Bash sandbox (network allowlist, filesystem scope) for runs.
- Whether the runner key should move to the macOS keychain (it is a 0600 file today; the harness's
  Read tool is denied it).
- Rate-limit detection (`rateLimitedUntil` in the heartbeat) from Claude's usage-limit message.
