# ADR 0400: Watch and steer runs from the dashboard

Status: accepted, 2026-11-12. Plan:
[`.kim/plans/2026-11-11-run-agents-on-hosts-without-orca.md`](../../.kim/plans/2026-11-11-run-agents-on-hosts-without-orca.md)
(piece 2). Spec [31](../specs/31-watch-and-steer-runs.md). Builds on [0100](0100-runner-contract.md),
[0350](0350-how-the-planning-loop-is-wired.md) and [0380](0380-runner-local-tmux-and-hook-status.md).

## Context
Since piece 1 a run is Claude Code's TUI in a tmux session on the owner's machine, and the only way to
watch or steer it is `tmux attach` on that machine. The dashboard shows runs as a table row. People
want to see a run as it goes (what the agent says, which tools it calls, the terminal) and send it a
message, from the work item page, without opening a port on the host or giving the cloud any new
standing authority.

## Decision
1. **Steering is an operation.** `run.steer { workItemId, runId, text }` (human, `member`, risk
   `write`) queues one message in `core_run_steers` and is journalled like every operation. Only the
   **owner of the run's runner** may steer: typing runs code on their machine with their model
   credential (ADR 0023, 0038). Everyone else who can read the work item watches read-only. The run
   must be active and its runner must declare the new **`steer`** capability.
2. **Steer text is person-supplied text.** The operation and the host both sanitise it the way
   attachment text is (`sanitiseUntrusted`: no control or bidi characters, no `untrusted-data`
   tags), flatten it to one line (a newline typed into the TUI would submit early), and cap it at
   2,000 characters. It is not wrapped in an untrusted-data block: it is the runner owner's own
   instruction, the same as typing at the attached terminal. Nothing in it reaches policy,
   permissions or gates: the harness settings were fixed at launch (ADR 0270) and gates are code.
3. **Delivery is a held poll on the runner channel**, `POST /runner/v1/jobs/<id>/steer`, like
   `planning.wait` (ADR 0350). The host keeps one call open per running job that can steer; sf-engine
   runs `run.takeSteers` (runner, fenced), and when nothing is queued it holds the call on the work
   item's hub (the PlanningHub Durable Object) until `run.steer`'s outbox message wakes it, or ~25 s
   pass. The host then calls `adapter.steer(session, text)`. Why not the heartbeat's existing `steer`
   command: heartbeats come every ~20 s per runner, so a message would wait up to 20 s, and making
   heartbeats faster costs every runner, all the time. Why not a short poll: a call every few
   seconds per job, each audited, for messages that rarely come. The held call delivers at once and
   costs one request per ~25 s per running job. It is outbound only, signed, scoped by the job and
   its fencing token, and not stored (each poll is new). Taking a message marks it delivered:
   delivery is at most once, so a message is never typed twice. A host whose engine doesn't know the
   call (404) stops polling.
4. **Watching reads run events.** Runner events gain a `message` type (`role`, `text` ≤ 8,000) and
   `log` events an optional `screen: true` (the visible screen, as opposed to lines that scrolled off).
   runner-local tails the Claude transcript (the path the status hook reports) and emits each
   assistant text as a `message`; the core stays runner-neutral and stores events as before.
   `run.live { workItemId, runId?, afterSeq? }` (member, read) returns the run, its events after a
   cursor (newest 300 when there is none), its steers and whether the viewer may steer. The work
   item page polls it every 2 s while the run is active. Polling, not a stream: each event flush would
   otherwise go through the outbox and a Durable Object, and a poll costs only while someone watches.
5. **Additive wire changes, no contract bump.** The new event type, the optional `screen` field, the
   `steer` capability and the new job call are additive. A runner only sends them after it has
   updated to the engine's deployed commit (ADR 0360), and the engine deploys first.

## Consequences
- A person watches a run's transcript and terminal on the work item page, and the runner's owner
  can steer it, with no inbound port and no new token. Each steer is a journal row, plus its
  `core_run_steers` row with who sent it and when the host took it.
- A message queued after the session ends, or while the host can't reach the engine, is shown as
  not delivered. A host that takes a message and crashes before typing it loses that message (at
  most once, by design).
- The transcript is assistant text and tool calls, not a chat: plan piece 8 (a stream-json session
  mode with a chat UI) emits the same `message` events from structured output and sends steers the
  same way, so the operation, the table and the events carry over.
- The web terminal (piece 6) replaces the polled terminal log with a live relay; until then the
  terminal view is the `log` events (scrolled-off lines plus a screen every ~10 s).

## Amended, 2026-11-13 (spec 44, part A)
The held call no longer waits inside a Durable Object. It waits in the Worker, which is billed for
CPU and not wall time, and re-checks every `HELD_POLL_MS` (3 s) with one indexed read on a partial
index that is empty while nothing is due:
- the steer call reads `core_run_steers_undelivered_idx`;
- the terminal call reads `core_run_terminal_attaches_open_idx`, and asks the job's TerminalRelay
  for a host ticket (`hostTicket()`, answered at once) only when an attach is open. An attach the
  relay holds no viewer for, older than a ticket lives, is closed by `run.terminal.closeStale`.

The fenced operation still runs first, and delivery state stays in D1. A steer or a viewer is
noticed within 3 s instead of at once. `TerminalRelay.waitForViewer` and the hub wait for steers are
gone. Spec 44 (block AQ, migration 0367).
