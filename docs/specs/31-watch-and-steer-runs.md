# Spec 31: Watch and steer runs from the dashboard

Read first: the plan ([`.kim/plans/2026-11-11-run-agents-on-hosts-without-orca.md`](../../.kim/plans/2026-11-11-run-agents-on-hosts-without-orca.md)),
ADRs [0400](../adr/0400-watch-and-steer-runs-from-the-dashboard.md), [0380](../adr/0380-runner-local-tmux-and-hook-status.md),
[0100](../adr/0100-runner-contract.md), [0350](../adr/0350-how-the-planning-loop-is-wired.md) (the held
`planning.wait`, the PlanningHub), [0023](../adr/0023-model-credentials-stay-with-the-runner-owner.md)
and [0038](../adr/0038-runner-sharing-is-an-owner-allowlist.md); spec [30](30-runner-local-without-orca.md);
`packages/runner-local`, `local/runner-host`, `apps/engine/src/channel.ts`, and the work item page
(`apps/app/src/routes/_app/work.$id.index.tsx`). Mockup: [`.kim/mockups/live-run.html`](../../.kim/mockups/live-run.html).

This is piece 2 of 8 in the plan. Accounts on a host (3), containers (4), Linux (5), the web
terminal (6), Sprites (7) and the chat UI (8) get their own specs.

## Goal
A person sees a run live on the work item page: what the agent says, the tools it calls, its status,
and the terminal. The runner's owner can send it a message from there. Others in the org watch
read-only. No inbound ports, no new standing tokens, and every message is journalled.

## Scope
- **Runner contract** (additive, no `CONTRACT_VERSION` bump, ADR 0400 §5):
  - a `message` runner event: `{ role: "assistant" | "user", text }`, text ≤ 8,000 characters;
  - `log` events gain an optional `screen: true` for the visible screen (as opposed to lines that
    scrolled off);
  - a `steer` capability: a person can send a message into the live session from the dashboard;
  - a job call `steer` (`POST /runner/v1/jobs/<id>/steer`, `{ fencingToken, waitMs? }` →
    `{ steers: [{ id, text, at }] }`), not stored, and `ControlPlaneClient.steers?` for it (with an
    abort signal);
  - `STEER_MAX` (2,000) and `steerText()`: `sanitiseUntrusted`, then one line, then the cap.
- **Core** (`packages/core`), migration **0170** (`core_run_steers`: id, run, work item, author, text,
  created, delivered):
  - `run.steer { workItemId, runId, text }`: human, `member`, risk `write`. Refuses (`forbidden`)
    anyone but the owner of the run's runner, (`conflict`) a run that isn't active, and
    (`unavailable`) a runner whose manifest lacks `steer`. Stores the sanitised text and emits
    `run.steered` to the outbox.
  - `run.takeSteers { jobId, fencingToken }`: runner, fenced. Returns the run's undelivered steers,
    oldest first, and marks them delivered.
  - `run.live { workItemId, runId?, afterSeq? }`: `member`, read. The run (the one asked for, else
    the latest), its events after `afterSeq` (the newest 300 without it, at most 300 with it), the
    highest seq, its steers with author and status (`queued`, `delivered`, `undelivered` once the
    run ended), and `steer: { allowed, reason }` for the viewer.
- **Engine** (`apps/engine`): the channel's `steer` call holds like `planning.wait`: it runs
  `run.takeSteers` and, while nothing is queued, waits on the work item's hub until woken or ~25 s
  pass. The outbox delivers `run.steered` as a hub wake (`PlanningHub.wake()`: wakes waiters, sends
  no SSE).
- **Runner host** (`local/runner-host`): once the session has started, a job whose adapter declares
  `steer` and has `steer()` keeps one `steers` call open until the session ends, types each message
  with `adapter.steer(session, steerText(text))`, and logs a failure to type as a `log` event
  (`stderr`). A 404 (an older engine) stops the loop; a 409 `fenced`/`killed` stops the job as any
  channel call does; other errors back off.
- **runner-local** (`packages/runner-local`):
  - declares `steer`;
  - `events()` tails the Claude transcript (the path from the status hook) from a byte offset and
    emits each new assistant text as a `message` event (clipped to 8,000), alongside the hook's
    `tool` and `agent.status` events; screen captures carry `screen: true`;
  - `steer()` types one line in chunks (so a long message isn't taken as a paste), then `Enter`.
- **harness-claude**: `readTranscriptFrom(path, offset)`, which returns the assistant texts after a
  byte offset and the next offset (a partial last line is left for the next read).
- **App** (`apps/app`), the work item page gets a **Live** tab (the default while a run is active and
  no question is open), after the mockup:
  - the run's header line (run number, stage, runner, agent status);
  - a dark stream with **Transcript** (assistant messages, tool calls with their short input, status
    changes, steers with who sent them and whether they were delivered) and **Terminal** (lines that
    scrolled off, then the latest screen);
  - a steer box for the runner's owner ("Message the agent…", Send) while the run is active; for
    everyone else a line saying why they can only watch;
  - polls `run.live` every 2 s while the run is active, appending events after the last seq.
- **Docs**: `CONTEXT.md` (Steer, `steer` capability), `docs/architecture.md` (the live view and the
  steer path), the runner-contract and runner-local READMEs.

## Out of scope
- The web terminal (piece 6), Claude accounts (3), containers (4), Linux (5), Sprites (7).
- A chat UI or a stream-json session mode (piece 8). The `message` event and `run.steer` are built so
  piece 8 can reuse them; nothing here assumes the TUI beyond runner-local.
- Steering from the CLI or MCP surfaces (the operation allows it; no command is added).
- Multi-line steers (flattened to one line), attachments in a steer, editing or recalling a steer.
- Pushing live updates over SSE or a WebSocket (polling for now, ADR 0400 §4).

## Acceptance criteria
1. On a running build, the work item page's Live tab shows the agent's assistant messages, its tool
   calls with short inputs and its status changes as they happen (within a few seconds), and the
   terminal's output, without a reload.
2. The runner's owner types a message in the Live tab and it reaches the live Claude session (it
   appears in the terminal and Claude answers it) within a few seconds; the run still ends and hands
   back normally.
3. Every steer is an operation: `run.steer` is in the registry with zod schemas, a description, a
   permission and a risk class, and each call has an audit row naming who sent it.
4. A member of the org who doesn't own the run's runner sees the live view but no steer box, and
   `run.steer` refuses them (`forbidden`). A run that has ended, or a runner without `steer`, is
   refused too.
5. Steer text is sanitised before it is stored and again before it is typed: control and bidi
   characters are removed, newlines become spaces, it is capped at 2,000 characters.
6. The host gets steers only over the signed outbound channel, scoped by the job and its fencing
   token: a stale fencing token is refused, nothing else can take a run's steers, and no port is
   opened on the host. A message is delivered at most once.
7. runner-local, fed a scripted transcript and status file, emits `message` events for assistant
   text in order with the hook's `tool` and `agent.status` events; `steer()` types the text and
   presses Enter (scripted tmux).
8. An older engine (no `steer` call) doesn't break a new host: the host stops polling and the run
   goes on.
9. `pnpm lint`, `pnpm typecheck` and `pnpm test` pass.
