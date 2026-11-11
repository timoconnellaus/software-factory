# @software-factory/harness-claude

The Claude Code harness (ADR 0017, 0033, 0250). A runner adapter hosts the session; this package
says how Claude runs there:

- `runSettings` / `projectHarness` write `.claude/settings.local.json` into the worktree, with four parts:
  - **Permission profile per stage**: `dontAsk` by default, so an unattended run is refused, never stalled.
    - Triage and spec may read, and write only `.factory-result.json`.
    - Verify may also run the toolchain.
    - Build may edit, commit and run the toolchain.
  - **Deny rules** for `git push`, `gh`, `ssh`, `wrangler`, cloud CLIs, `orca` and the keychain, and for
    reading `~/.ssh`, `~/.config/gh` and the runner's own files.
  - **A credential-free environment** (`harnessEnv`): tokens blanked; git on a per-run global config
    with no credential helper and no system config; `gh`, wrangler and cloud CLIs pointed at empty dirs.
  - **The per-run git config** (an identity for commits, no helper), in a private run dir outside the worktree.
- `scrubbedProcessEnv`: the same, for a harness the runner spawns itself.
- `findTranscript` / `parseTranscript` / `checkOutputLog`: the check output and final message from a
  session's transcript (Orca's per-profile `CLAUDE_CONFIG_DIR` homes are searched too).
- `streamJsonToEvents` and `headlessArgs` for headless `claude -p` runs.
