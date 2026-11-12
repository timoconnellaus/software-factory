# ADR 0450: A stream-json session mode, shown as a chat, taken over by resume

Status: accepted, 2026-11-12. Plan:
[`.kim/plans/2026-11-11-run-agents-on-hosts-without-orca.md`](../../.kim/plans/2026-11-11-run-agents-on-hosts-without-orca.md)
(piece 8). Spec [37](../specs/37-chat-ui-stream-json.md). Builds on [0380](0380-runner-local-tmux-and-hook-status.md)
§4 (sessions are pluggable behind the adapter), [0400](0400-watch-and-steer-runs-from-the-dashboard.md)
and [0270](0270-the-factory-launches-the-harness-and-verifies-it.md).

## Context
Since piece 1 a run is Claude Code's TUI in tmux. The dashboard learns what it does from the status
hook and the transcript file (ADR 0400) and shows the terminal from screen captures. That is enough
to watch, but it is a reconstruction: tool results, turn ends and token counts aren't in it, and a
steer is typed into a TUI. Hosted coding agents run Claude headless instead, as a two-way
stream-json session, and show it as a chat. The owner wants that as a second way to run, not a
replacement: tmux stays for people who attach.

## Decision
1. **A session mode beside tmux in runner-local.** `claude -p --input-format stream-json
   --output-format stream-json --verbose --permission-prompts none`, after the harness's usual flags
   (`--permission-mode`, `--setting-sources project,local`, `--settings`, `--strict-mcp-config`,
   `--model`). It runs the same launch script as a child process with piped stdio, so ADR 0270
   holds unchanged: the argv and both settings hashes are checked on the live process before the
   prompt, and a mismatch kills it. The prompt is the first JSON user message (still the
   `.factory-prompt.md` pointer, so the prompt is a file the agent reads, as in tmux); steers are
   further JSON user messages. `--permission-prompts none` makes anything that would prompt a
   denial, so nothing waits on an answer that no one gives; the stage's mode and allow rules decide
   as before. The status hook stays projected: it is the cross-check, and it is what follows a
   session after takeover. The mode lives in its own module (`stream.ts`) so container work on the
   launch (piece 4) and the tmux path don't collide with it.
2. **Chosen per runner.** `runner.json` `session: "tmux" | "stream-json"`, default `tmux`. A runner
   in stream mode declares the **`chat`** capability, and every run says its mode on
   `session.started`, so the dashboard shows the right view even if the runner later switches.
   Per job or per project policy is not built: a project that needs a mode can route with
   `requires: ["chat"]` today. The core stays runner-neutral: it stores events and checks
   capabilities, and never branches on runner kind.
3. **Events come from the structured output and widen compatibly.** Assistant text → `message`,
   `tool_use` → `tool` (with its `id`), `tool_result` → the new `tool.result` (output ≤ 4,000), a
   turn's `result` → the new `turn` (outcome, time, turns, token counts; never cost or keys) and a
   status change. No second channel: the same events table, the same `run.live` poll. Every field is
   bounded, and the additions are additive like ADR 0400 §5 (the engine deploys first; a runner
   sends them only once it runs the deployed commit). A tmux run's events are unchanged.
4. **When a job ends.** A non-planning job ends at the `result` that answers the last user message
   sent (a steer sent mid-turn gets its own turn, and a short grace covers a queue that Claude
   folded into one turn); the process exiting also ends it. A planning session (ADR 0300) idles in
   its Stop hook as in tmux; if a turn does end, it goes `idle` and stays open until the host stops
   it.
5. **Takeover by resume is an operation.** `run.takeover` (owner of the run's runner only, like
   `run.steer`) queues a `takeover` row on the steer table (migration 0220 adds `kind`) and wakes
   the host's held steer call. The host asks the adapter to stop the session cleanly: an `interrupt`
   control request, stdin closed, the process waited for. The adapter emits a `takeover` event with
   the exact interactive command, `cd <worktree> && env -u … claude --resume <session-id>` with the
   run's settings, mode, setting sources and model, and the job keeps its worktree and lease. The
   owner runs it on the host; the projected status hook reports the resumed session, its assistant
   text keeps showing from the transcript, and quitting it (`SessionEnd`) ends the job, which hands
   back and pushes as any other. A non-planning stream run starts with its own `--session-id`, so
   the id is known before the first turn. If nobody resumes within the waiting-input timeout, the job
   fails.
6. **Not built: resuming back into the factory.** It would be a second `takeover`-kind row, `resume`,
   that waits for the terminal session to end and then relaunches the stream with `--resume <id>`
   through the same launch-verify path (a new launch record, since the argv changes). Left until
   someone needs it; quitting the terminal session hands the run back today.

## Consequences
- Two session modes behind one adapter; the dashboard shows a chat for one and the terminal for
  the other, from the same events. Moving a runner between them is a config change and a restart.
- A stream session has no screen: the Terminal view shows only stderr and stray stdout. A person
  who wants a terminal takes the session over.
- The runner host's process owns the stream session's stdio: a host that dies takes the session's
  stdin with it, and Claude exits after its turn; the job is reaped as any other.
- A steer is delivered as structured input, not typed: no chunking, no paste limits.
