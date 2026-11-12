# @software-factory/harness-claude

The Claude Code harness (ADR 0017, 0033, 0250). A runner adapter hosts the session; this package
says how Claude runs there:

- `runSettings` / `projectHarness` write the run's settings, the same bytes twice: `<runDir>/claude-settings.json`
  (passed with `--settings`, the authority) and `.claude/settings.local.json` in the worktree (ADR 0270):
  - **Permission mode and allowlist per stage.** Build: `bypassPermissions`, inside the sandbox.
    Triage, spec and verify: `dontAsk`, so an unattended run is refused, never stalled.
    - Triage and spec may read, and write only `.factory-result.json`.
    - Verify may also run the toolchain.
    - A project's `.factory/policy.json` → `harness` (on the job as `harness.profile`) can pick the
      modes and add allow rules and hosts. It can't touch the floor below.
  - **The sandbox, in every stage** (the floor):
    - `enabled`, `failIfUnavailable`, `allowUnsandboxedCommands: false`;
    - writes only to the worktree, temp and the run's own git objects/refs;
    - network only to the npm registry, GitHub, the Cloudflare API and the project's hosts
      (`strictAllowlist`).
  - **Deny rules** for `git push`, `gh`, `ssh`, `wrangler`, cloud CLIs, `orca` and the keychain; for
    reading or writing `~/.ssh`, `~/.config/gh`, `~/.wrangler` and the keychains; for reading the
    runner's own files and the owner's checkout; and for writing the worktree's `.claude/`.
  - **A credential-free environment** (`harnessEnv`): tokens blanked; git on a per-run global config
    with no credential helper and no system config; `gh` and cloud CLIs pointed at empty dirs; tool
    caches in the run's temp dir.
  - **The per-run git config** (an identity for commits, no helper), in a private run dir outside the worktree.
  - Runner hooks (`hooks`), but never `PreToolUse`, `PermissionRequest` or `Elicitation` ones.
- **The launch** (`launch.ts`): `claudeArgv` is the exact command,
  `claude --permission-mode <mode> --setting-sources project,local --settings <run settings> --strict-mcp-config [--model …]`,
  with no user settings, so the owner's own Claude config never applies.
  - `projectHarness` writes `launch.sh`, which records its pid and `exec`s that argv. The runner
    runs it as is.
  - It also writes `launch.json`, the launch record.
  - `verifyLaunch` compares the live process (`ps`) and both settings copies with the record. Any
    difference is `harness-config-mismatch`.
- **A planning session** (spec 20, ADR 0350, `src/planning/`): `projectHarness` with `planning:
  { relay }` writes `<runDir>/planning.json` (the host's relay and its per-job secret, 0600, denied to
  the Read tool) and `<runDir>/mcp.json`, and the launch gains `--mcp-config` and `--session-id`
  (or `--resume` on a resume job). The stage allows reading and the `mcp__planning__*` tools only.
  - The **planning MCP server** (`node cli.ts mcp`): one tool per planning operation
    (`question_ask`, `spec_revise`, `chat_reply`, `planning_ready`, …), schemas from runner-contract.
  - **Hooks**, kim's semantics: `PostToolUse` brings the news since the cursor at most every 15 s;
    `UserPromptSubmit` brings it every time and cancels a waiting Stop hook; `Stop` (asyncRewake)
    waits on `planning.wait` and wakes the model when news is due, or yields when the factory asks.
- `scrubbedProcessEnv`: the same, for a harness the runner spawns itself.
- `findTranscript` / `parseTranscript` / `checkOutputLog`: the check output and final message from a
  session's transcript (Orca's per-profile `CLAUDE_CONFIG_DIR` homes are searched too).
- `streamJsonToEvents` and `headlessArgs` (the same factory flags, then `-p`) for headless `claude -p` runs.
