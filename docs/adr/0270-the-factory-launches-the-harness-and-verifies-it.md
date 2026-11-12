# ADR 0270: The factory launches the harness, sandboxes it, and verifies the live process

Status: accepted, 2026-11-11 (incident [2026-11-11 bootstrap #6](../incidents/2026-11-11-bootstrap.md#6-the-launcher-overrode-the-harnesss-permission-mode)).
Builds on [ADR 0017](0017-harness-adapters.md), [0033](0033-per-job-github-app-tokens.md),
[0036](0036-policy-from-the-default-branch.md), [0250](0250-runner-host-pushes-and-harness-projection.md)
and [0260](0260-runners-attach-to-the-existing-checkout.md).

## Context
On the M5, work item #1's job projected `.claude/settings.local.json` with `"defaultMode": "dontAsk"`,
but its Claude process ran as `claude … --permission-mode auto`. `runner-orca` started Claude with
`orca agent launch`, which adds the owner's own Claude permission mode (`"defaultMode": "auto"` in
their `~/.claude/settings.json`). A CLI flag beats any settings file, so the factory's mode was
silently replaced, and nothing checked the process after launch. The spike had flagged the gap
(`spikes/runner-orca` finding 7: `agent launch` takes no agent arguments).

Two more launcher effects came out of fixing it: Orca's status hooks live in the owner's user
settings, and two of them (`PreToolUse`, `PermissionRequest`) can answer permission decisions.
Orca's terminals also add `CLAUDE_CODE_PLUGIN_DIRS`.

## Decision
1. **The harness owns the invocation; the runner only hosts it.** `harness-claude` writes a launch
   script per run (`<runDir>/launch.sh`) that records its pid and `exec`s exactly:
   `claude --permission-mode <mode> --setting-sources project,local --settings <runDir>/claude-settings.json --strict-mcp-config [--model <model for the role>]`.
   - No `user` setting source: the owner's personal Claude config (mode, hooks, plugins) never applies.
   - No MCP servers.
   - The script unsets every credential variable the harness env blanks, and `CLAUDE_CODE_PLUGIN_DIRS`.
   - `runner-orca` runs it in a visible Orca terminal on the job's worktree
     (`orca terminal create --command "exec /bin/sh <launch.sh>"`), never `orca agent launch`.
   - It answers Claude's first-run folder trust dialog for that worktree. Orca's `agent launch` does
     this by writing the owner's `.claude.json`; the runner presses the key in the terminal instead,
     and only once.
   - The takeover in Orca is unchanged.
2. **Settings, twice, the same bytes.** The settings go to `<runDir>/claude-settings.json`, passed with
   `--settings`, and to the worktree's `.claude/settings.local.json`. The flag copy is the authority:
   Claude Code treats a `--settings` file's `allowUnsandboxedCommands: false` and `strictAllowlist` as
   closed to the repo's own project settings.
3. **Per stage** (defaults; `.factory/policy.json` can change them, see 5):
   - **build:** `bypassPermissions`, inside the sandbox. The bypass confirmation dialog is skipped by
     the settings.
   - **triage, spec, verify:** `dontAsk` with the stage allowlists from ADR 0250. Bash isn't
     auto-allowed by the sandbox in these stages, so the allowlist decides.
4. **The floor, in every stage:**
   - **Sandbox:** `sandbox.enabled`, `failIfUnavailable`, `allowUnsandboxedCommands: false`, no
     `excludedCommands`.
   - **Network:** `allowedDomains` = `registry.npmjs.org`, `github.com`, `api.github.com`,
     `api.cloudflare.com`, plus the project's additions; `strictAllowlist` (deny, never prompt); local
     ports allowed (dev servers, the workerd test pool).
   - **Filesystem writes:** the worktree, the run's temp dir and the system temp dirs. A linked
     worktree's `objects`, `refs`, `logs`, `packed-refs` and its own admin dir in the checkout's git dir,
     so the run can commit; never that git dir's `config` or `hooks`. File tools are held to the
     working directory too (`blockWritesOutsideWorkingDirectories`).
   - **Deny rules:** reads and writes of `~/.ssh`, `~/.config/gh`, `~/.wrangler`, the keychains and the
     other credential paths; reads of the runner's key, run dirs, clones and the owner's checkout (its
     git dir is re-allowed for the run's own git); writes to the worktree's `.claude/` (a hook runs
     outside the sandbox, so a run that wrote one could escape it); the deny commands from ADR 0250.
     `WebFetch` is limited to the allowlist where the mode allows that, and denied in bypass mode,
     where it can't be (WebFetch isn't sandboxed).
   - **Hooks:** a runner may add hooks (Orca's status hooks), but never on `PreToolUse`,
     `PermissionRequest` or `Elicitation`.
   - **Caches:** npm, corepack, wrangler and XDG homes go to the run's temp dir. pnpm's store is one
     shared directory in temp: it is content-addressed and checked on read.
5. **`.factory/policy.json` → `harness`** (`harnessProfileSchema` in `runner-contract`):
   `permissionMode` per stage (`dontAsk | acceptEdits | bypassPermissions | plan`; no `auto`, which
   puts a model classifier in charge, and no prompting mode), `allow` rules per stage, and
   `allowedDomains`. It can only pick a mode and add to allowlists; the floor above is code.
   - The engine reads it from the default branch's synced policy and puts it on the job as
     `harness.profile`, never from the run's own branch.
   - A change to it is a `.factory/` change, so a person merges it.
   - The field is optional and additive, so `CONTRACT_VERSION` stays `1`: an older runner ignores it,
     and a job without one gets the defaults.
   - The runner owner's `permissionMode` in `runner.json` is removed. `doctor` says it is ignored.
6. **Verify after launch, before any work.** Once Claude is up in the job's own pane (its pid
   recorded, Orca sees an agent in that pane), the runner compares:
   - the process's command line (`ps -o command=` on the recorded pid) with the launch record's argv,
     exactly;
   - both settings copies' sha256 with the projected hash.

   Any difference closes the terminal, which kills Claude, and fails the job with
   `harness-config-mismatch: …`. The prompt is sent only after the check passes (`orca terminal send
   --enter --wait-submit`). The incident classifier files the failure as a `runner` incident.
   `sf-runner doctor` runs the same check for every running job.

## Consequences
- A launcher can no longer change the harness's mode, settings or tools without the job failing
  before it does anything. The incident class is closed by a check, not by trusting the launcher.
- The settings are no longer only defence in depth: the OS sandbox enforces the filesystem and network
  limits on every Bash command, verified on the M5 (blocked: `example.com`, `~/.ssh`, the owner's
  checkout's `.env`, writes to `~`; allowed: the npm registry, a commit in the linked worktree).
- `pnpm install` in a run uses a shared store in temp, so the first run after a reboot downloads
  everything.
- A run can't change `.claude/` in its worktree. A work item that needs to change the project's Claude
  config is done by a person.
- Orca's `PreToolUse` hook no longer runs, so Orca's sidebar shows a run's tools after they finish, not
  while they run.

## Proposed Orca feature (for later)
`orca agent launch --agent claude … --agent-args <json array>` (or a narrower
`--permission-mode <mode> --setting-sources <list> --settings <file>`), with these semantics:
1. Orca appends the given arguments verbatim and adds **none of its own** that change the agent's
   permission mode, setting sources, settings, MCP config or tools (`--permission-mode`,
   `--dangerously-skip-permissions`, `--settings`, `--setting-sources`, `--mcp-config`,
   `--allowedTools`). If the owner's Orca preferences would add one, the launch fails
   (`agent_args_conflict`), never merges.
2. The launch receipt reports the final argv and the agent's pid, so a caller can verify it without
   `ps`.
3. Orca keeps pre-trusting the worktree and keeps its status hooks working when `user` isn't among
   the setting sources: it passes the status hooks on its own (`--settings` merge or a plugin dir),
   without `PreToolUse`/`PermissionRequest` deciders when the caller asks for `--no-decision-hooks`.

With that, `runner-orca` can go back to `agent launch`. The post-launch check stays either way.

## Open questions
- Drop `project` from the setting sources too? The repo's committed `.claude/settings.json` still adds
  hooks (which run unsandboxed) and allow rules. A run can't write it, but a person's merge can. For
  now it stays, as the task asked, and the floor holds against it.
- Fail fast without retries on `harness-config-mismatch`. Today the engine retries the run up to the
  retry limit before the item fails and the incident opens; every retry fails the same way, before
  doing anything.

> Amended 2026-11-12 (incident [2026-11-11 #8](../incidents/2026-11-11-bootstrap.md#8-agents-received-only-the-tail-of-their-prompts)):
> the prompt is no longer typed into the terminal. A multi-kilobyte prompt sent with
> `orca terminal send --text … --enter` arrived with only its tail. The adapter writes it to
> `.factory-prompt.md` in the worktree (excluded from git) and, after the live-process check, sends
> harness-claude's one-line `PROMPT_POINTER` to it.

> Amended 2026-11-12 ([ADR 0350](0350-runner-local-tmux-and-hook-status.md)): the terminal is now a
> tmux session on the factory's own socket (`runner-local`), not an Orca terminal. The launch script,
> the launch record and the post-launch check are unchanged: the session runs
> `exec /bin/sh <runDir>/launch.sh`, the adapter waits for the pid file and the status hook's
> `SessionStart`, runs `verifyLaunch`, and kills the session on `harness-config-mismatch` before any
> prompt. The "Proposed Orca feature" above no longer applies. The harness now adds one hook of its own,
> the status hook. It runs on `PreToolUse` among other events, but it only records the event and
> always answers `{}`, so it decides nothing. Runner-supplied hooks still may not use decision events.
> The deny list adds `tmux`.
