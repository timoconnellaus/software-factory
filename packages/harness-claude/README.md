# @software-factory/harness-claude

The Claude Code harness (ADR 0017, 0033, 0250). A runner adapter hosts the session; this package
says how Claude runs there:

- `runSettings` / `projectHarness` write the run's settings, the same bytes twice: `<runDir>/claude-settings.json`
  (passed with `--settings`, the authority) and `.claude/settings.local.json` in the worktree (ADR 0270):
  - **Permission mode and allowlist per kind of run** (`runKind`). In a repository (a worktree on
    the item's branch): `bypassPermissions`, inside the sandbox; edits, the shell, git add and
    commit and the toolchain. In a plain directory (a job without a repository): `dontAsk`, so an
    unattended run is refused, never stalled; it may read, and write only inside its directory.
  - **The sandbox, always** (the floor):
    - `enabled`, `failIfUnavailable`, `allowUnsandboxedCommands: false`;
    - writes only to the worktree, temp and the run's own git objects/refs;
    - network only to the npm registry, GitHub and the Cloudflare API (`strictAllowlist`).
  - **Deny rules** for `git push`, `gh`, `ssh`, `wrangler`, cloud CLIs, `orca` and the keychain; for
    reading or writing `~/.ssh`, `~/.config/gh`, `~/.wrangler` and the keychains; for reading the
    runner's own files and the owner's checkout; and for writing the worktree's `.claude/`.
  - **A credential-free environment** (`harnessEnv`): tokens blanked; git on a per-run global config
    with no credential helper and no system config; `gh` and cloud CLIs pointed at empty dirs; tool
    caches in the run's temp dir.
  - **The per-run git config** (an identity for commits, no helper), in a private run dir outside the worktree.
  - Runner hooks (`hooks`), but never `PreToolUse`, `PermissionRequest` or `Elicitation` ones.
- **The launch** (`launch.ts`): `claudeArgv` is the exact command,
  `claude --permission-mode <mode> --setting-sources project,local --settings <run settings> --strict-mcp-config [--mcp-config …] [--model …] [--effort …]`,
  with no user settings, so the owner's own Claude config never applies.
  - `projectHarness` writes `launch.sh`, which records its pid and `exec`s that argv. The runner
    runs it as is.
  - It also writes `launch.json`, the launch record.
  - `verifyLaunch` compares the live process (`ps`) and both settings copies with the record. Any
    difference is `harness-config-mismatch`.
- **A job's MCP servers** (spec 70 milestone 2, `src/flow-mcp.ts`): the job's `mcpServers` are
  written as HTTP servers, with their headers, to `<runDir>/mcp.json` (0600, denied to the Read
  tool, gone with the run dir), and the launch gains `--mcp-config`. Each named server gets
  `mcp__<name>__*` allowed, nothing broader; a name outside `[A-Za-z0-9_-]` is refused. Claude Code
  connects to them itself, outside the Bash sandbox, so the sandbox's host allowlist is unchanged.
- `scrubbedProcessEnv`: the same, for a harness the runner spawns itself.
- `findTranscript` / `parseTranscript`: the final message and usage from a session's transcript
  (Orca's per-profile `CLAUDE_CONFIG_DIR` homes are searched too).
- `streamJsonToEvents` and `headlessArgs` (the same factory flags, then `-p`) for headless `claude -p` runs.
- A stream-json session (ADR 0450): `projectHarness(…, { session: "stream" })` launches with
  `STREAM_FLAGS` (and `--session-id`, recorded as `launch.stream.sessionId`), so ADR 0270's check
  covers it. `stream-json.ts`: `streamLineEvents` (one output line → bounded contract events),
  `userMessageLine`, `denyPermissionLine`.
