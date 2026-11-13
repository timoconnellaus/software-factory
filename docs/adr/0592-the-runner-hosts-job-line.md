# ADR 0592: The runner host's job line

Status: accepted, 2026-11-13. Block AQ. Spec [44](../specs/44-durable-objects-never-held-awake.md)
part B. Builds on [ADR 0400](0400-watch-and-steer-runs-from-the-dashboard.md) (steers),
[0440](0440-a-web-terminal-relayed-through-a-durable-object-per-job.md) (the TerminalRelay) and
[0350](0350-how-the-planning-loop-is-wired.md) (planning), and on spec 44 part A, where the held
calls wait in the Worker.

## Context
After part A, no Durable Object is held awake by a waiting runner host. The host still holds three
calls per running job: steers, the terminal, and a planning job's wait. Each re-asks every 25 to
50 s, and sf-engine polls a partial index every 3 s for each one. That costs little per job, but it
adds up to a few hundred thousand D1 queries a day across a fleet, and a steer or a viewer waits up
to 3 s to be noticed.

## Decision
1. **One hibernatable WebSocket per running job, to the job's TerminalRelay.** The relay is already
   one Durable Object per job and already accepts sockets. A host that declares the capability
   `job-line` asks for the line with a new signed channel call, `jobs/<id>/line`.
   - The call is fenced like the others: it runs `run.terminal.host` (the runner's own live job,
     its current token).
   - It answers a one-use ticket URL, `/terminal/v1/jobs/<id>/line?ticket=…`.
   - The relay accepts the socket with `acceptWebSocket` and the tag `line`. A host that reconnects
     replaces its previous line (close code 4000).
   - The relay's `setWebSocketAutoResponse("ping", "pong")` answers the host's pings without waking
     the object, so an idle line costs nothing.
2. **The relay pushes wakes only, never data** (spec 44 rule 1): `{ t: "steer" | "viewer" |
   "planning" }`.
   - `steer`: `run.steer` and `run.takeover` queue `run.steered` with the run's `jobId`, and the
     outbox's delivery calls `terminalRelay(jobId).push("steer")`. A message queued before `jobId`
     existed is routed to the work item's newest active run, on UNIQUE (work_item_id, run_no).
   - `viewer`: a viewer connects and no terminal host is connected, or the host leaves while
     viewers remain.
   - `planning`: `planning.changed` for a work item with an active planning run is pushed to that
     job's line.

   On a push the host makes its existing fenced call without holding (`waitMs: 0`): `steers`,
   `terminal`, or its hook's `planning.wait`. Delivery state stays in D1, so a lost push leaves the
   work for the next call and a duplicate push makes one call that finds nothing. A fenced host is
   refused by that call, whatever woke it.
3. **Both sides must declare it.** The heartbeat's answer gains `engine: { capabilities:
   ["job-line"] }`, which is additive, so it is not a compat change. A host uses the line only when
   it and the engine both declare `job-line`. If `line` answers 404 or `unavailable` (an engine
   rolled back), the host goes back to held calls for that job until its next heartbeat. A runner
   without `job-line` keeps the part A held calls, so `RUNNER_COMPAT` doesn't change.
4. **The host's side** (`local/runner-host`, spec 44 PR 5):
   - It pings every 30 s (`LINE_PING_MS`). A ping with no pong within 10 s
     (`LINE_PONG_DEADLINE_MS`) counts as a half-open line, and the host reconnects with backoff.
   - On every (re)connect it makes each call once with `waitMs: 0`, so nothing that happened while
     the line was down is missed.
   - Every 5 minutes it makes each call once anyway (`LINE_SAFETY_POLL_MS`). A push lost to a
     half-open socket that still answers pings is then noticed within 5 minutes, not never.

## Cost
- **Durable Objects:** 0 GB-s while idle. Each line costs one request to open. Each push is one
  request to the relay; outgoing messages and auto-responded pings are free.
- **Requests and D1, per idle running job:**
  - **Held calls (part A):** about 288 calls an hour (steers and the terminal at 25 s each), each
    polling a partial index every 3 s.
  - **The line (part B):** the safety poll alone, 3 calls per 5 minutes, about 36 an hour. Those
    calls write nothing when nothing is due (ADR 0590).
- **Per steer, viewer or planning change:** one extra relay request (the push).

## Not decided here
- **Stopping the held calls for good.** Once every runner that has heartbeated in 30 days declares
  `job-line`, the engine may stop answering held calls by raising `RUNNER_COMPAT` (spec 38). That is
  a separate decision.

## Amended, 2026-11-13: steers are acked by the host
A held steer call whose host had gone (its request signal not seen to abort) could take a steer
nobody received. So a host that acks gets steers as offers:
- Its every `steers` call sends `ack`: the ids it received since the last call, possibly none.
  Sending the field at all opts in; an older host never sends it and is handed steers as before.
- `run.takeSteers` delivers what is acked (`delivered_at`, and the planning chat message's), then
  offers queued steers that are not on offer, for 60 s (`core_run_steers.offered_until`, migration
  0369). An offer nobody acks lapses and the steer is offered again.
- The host drops a steer it already has, by id, and acks it again.
- The channel's poll skips steers on offer. It logs one line when a held call's request signal
  aborts, so `wrangler tail` on the deployed engine shows whether `enable_request_signal` works.
