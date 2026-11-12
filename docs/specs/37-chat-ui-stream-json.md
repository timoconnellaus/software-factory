# Spec 37: A chat UI on a stream-json session

Read first: the plan ([`.kim/plans/2026-11-11-run-agents-on-hosts-without-orca.md`](../../.kim/plans/2026-11-11-run-agents-on-hosts-without-orca.md)),
ADRs [0450](../adr/0450-a-stream-json-session-mode-with-a-chat-view.md), [0380](../adr/0380-runner-local-tmux-and-hook-status.md),
[0400](../adr/0400-watch-and-steer-runs-from-the-dashboard.md), [0270](../adr/0270-the-factory-launches-the-harness-and-verifies-it.md)
and [0300](../adr/0300-planning-is-a-live-session-on-a-runner.md); specs [30](30-runner-local-without-orca.md)
and [31](31-watch-and-steer-runs.md); `packages/runner-local`, `packages/harness-claude`, `local/runner-host`
and the Live tab (`apps/app/src/components/live-run*.tsx`).

This is piece 8 of 8 in the plan. Accounts on a host (3), containers (4), the web terminal (6) and
Sprites (7) have their own specs.

## Goal
A second way to run a job on a host, next to tmux: Claude Code headless as a long-lived two-way
stream-json session. What the agent does comes straight from its structured output (no screen
reads), the dashboard shows it as a chat, the runner's owner talks to it from there, and can take it
over in a terminal with `claude --resume`. tmux stays the default.

## Scope
- **Runner contract** (additive, no `CONTRACT_VERSION` bump, as ADR 0400 §5):
  - a **`chat`** capability: the runner runs sessions as a structured stream, which the dashboard
    shows as a chat, and the owner can take one over by resume;
  - `session.started` gains optional `mode: "terminal" | "stream"`; `SessionHandle` gains `mode?`;
  - `tool` gains optional `id` (≤ 100), to pair it with its result;
  - a `tool.result` event: `{ toolId, output ≤ 4,000, isError? }`;
  - a `turn` event, the end of one turn: `{ outcome: "success" | "error", durationMs?, turns?,
    usage?: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }, error? ≤ 2,000 }`;
  - a `takeover` event: `{ sessionId, hint ≤ 4,000 }`, once the stream has stopped for a person;
  - the steer call's steers gain optional `kind: "message" | "takeover"` (absent: a message);
  - `RunnerAdapter.takeover?(session)`: stop the stream session cleanly for a person.
- **Core** (`packages/core`), migration **0220** (`core_run_steers.kind`, default `message`):
  - `run.takeover { workItemId, runId }`: human, `member`, risk `write`. Owner of the run's runner
    only (`forbidden`), an active run (`conflict`), a stream session on a runner with `chat`
    (`unavailable`), once per run (`conflict`). Queues a `takeover` row and wakes the host like
    `run.steer`. The `takeover` event's command becomes the run's takeover hint (`core_runs.takeover`,
    label "Resume in a terminal").
  - `run.takeSteers` returns each row's `kind`; `run.live` returns `run.mode` (from the run's
    `session.started`, null before it), each steer's `kind`, and `takeover: { allowed, reason,
    requested }` for the viewer.
- **harness-claude**:
  - `claudeArgv(..., { stream: true, sessionId? })`: the same factory flags, then `-p --input-format
    stream-json --output-format stream-json --verbose --permission-prompts none` (nothing waits on a
    permission answer; the mode and allow rules decide). A non-planning stream run gets its own
    `--session-id <uuid>`; a planning one keeps `--session-id`/`--resume` from ADR 0350.
  - `projectHarness(..., { session: "stream" })` writes that argv into the launch script and record,
    so ADR 0270's check covers it.
  - `stream-json.ts`: `streamLineEvents` (one output line → contract events, sizes bounded),
    `userMessageLine`, `interruptLine`, `denyPermissionLine`, and `resumeCommand` (the exact
    interactive `claude --resume <id>` with the run's cwd, settings, mode, MCP config and model, and
    the launch script's unsets as `env -u`).
- **runner-local**, `stream.ts`, a session mode beside tmux (`config.session: "tmux" | "stream-json"`):
  - `startSession`: spawns `/bin/sh <launch.sh>` with piped stdio (its own process group), waits
    for the pid file and the exec, runs `verifyLaunch` (mismatch: kill, `harness-config-mismatch`),
    then writes `.factory-prompt.md` and sends `PROMPT_POINTER` as the first JSON user message;
  - `events()`: each stdout line through `streamLineEvents`; stderr as `log` (`stderr`); a
    non-planning job ends at the `result` that answers the last user message it was sent (a steer
    sent mid-turn gets its own turn first); a planning session goes `idle` and stays open;
    the process exiting ends the session (`completed` with the result file, else `failed`);
  - `steer()`: one JSON user message on stdin;
  - `takeover()`: an `interrupt` control request, stdin closed, the process waited for (then
    killed); `events()` emits `takeover` with `resumeCommand`, then follows the resumed session by
    the status hook and transcript (assistant `message`s, `tool`s) and ends `completed` at its
    `SessionEnd` (the person decided; a build still needs its commits), or fails if nobody resumes
    within the waiting-input timeout;
  - manifest adds `chat` in stream mode; `capacity` counts stream processes; `release` kills the
    process group. tmux mode is unchanged.
- **runner-host**: `runner.json` `session: "tmux" | "stream-json"` (default `tmux`); `session.started`
  carries the session's mode; the steer loop calls `adapter.takeover` for a `takeover` row;
  the host logs its mode at start.
- **App**: on the Live tab, a run with `mode: "stream"` gets a **Chat** view (the default for it,
  next to Transcript and Terminal): assistant text as Markdown, each tool call collapsible with its
  input and output, status lines, a line per turn with its tokens and time, the owner's messages as
  their bubbles with delivery status; a composer (Textarea, Enter sends, Shift+Enter breaks a line)
  for the runner's owner, and **Take over in a terminal**, which confirms, calls `run.takeover`
  and then shows the resume command to copy. Others watch read-only, with why.
- **Docs**: `CONTEXT.md` (Session mode, Chat view, `chat` capability), `docs/architecture.md`, the
  runner-contract, runner-local, harness-claude and runner-host READMEs.

## Out of scope
- Resuming a taken-over session back into the factory's stream (ADR 0450 §6 says how it would go).
- Choosing the mode per job or per project policy (per runner only, ADR 0450 §2).
- Partial message streaming (`--include-partial-messages`), thinking blocks, images in the chat.
- The web terminal (piece 6), containers (4), accounts (3), Sprites (7).

## Acceptance criteria
1. With `"session": "stream-json"` in `runner.json`, a build on the M5 runs end to end as a
   stream-json session: launch verified, prompt sent as the first JSON message, the run branch
   pushed and handed back; the Live tab shows it as a chat as it goes.
2. A planning session in stream mode stays open between turns (idle) and ends when the host stops it.
3. The runner's owner sends a message from the chat composer; it reaches the session as a JSON user
   message and the agent answers it in the chat; the run ends normally.
4. **Take over in a terminal** stops the stream session and shows a `claude --resume <session-id>`
   command; run on the host, it continues the same conversation in the worktree with the run's
   settings, and quitting it ends the job (handed back as usual).
5. A live process that doesn't match its launch record is killed before the prompt and the job fails
   with `harness-config-mismatch`, in stream mode too.
6. `run.takeover` is an operation (schemas, description, permission, risk), owner-only, refused for
   an ended run, a terminal-mode run or a second request; the host gets it only over the signed
   channel, scoped by job and fencing token.
7. New event fields and types are bounded (tool output 4,000, turn error 2,000, hint 4,000, message
   8,000) and additive: a tmux run's events are unchanged and the Transcript and Terminal views
   still work for both modes.
8. runner-local, against a scripted stand-in `claude` that speaks stream-json: prompt in, events out
   in order, a steer as a user message, a turn's result ends a build, planning stays open, a launch
   mismatch fails, takeover emits the resume command and follows the resumed session.
9. `pnpm lint`, `pnpm typecheck` and `pnpm test` pass.
