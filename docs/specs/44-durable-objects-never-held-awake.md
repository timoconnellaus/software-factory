# Spec 44: Durable Objects are never held awake

**Status: specified, not built.** The coordinator schedules the build after #73 and the planning
PRs land, because they touch the same files (`channel.ts`, `planning.ts`, `planning.tsx`,
`local/runner-host`).

**Read first:**
- [AGENTS.md, "Cloudflare cost"](../../AGENTS.md#cloudflare-cost), rules 1, 5, 6 and 9;
- ADR [0350](../adr/0350-how-the-planning-loop-is-wired.md) (PlanningHub);
- ADR [0393](../adr/0393-the-client-door-version-handshake.md) (the door's protocol handshake);
- ADR [0400](../adr/0400-watch-and-steer-runs-from-the-dashboard.md) (the held steer call);
- ADR [0440](../adr/0440-a-web-terminal-relayed-through-a-durable-object-per-job.md) (TerminalRelay);
- ADR [0590](../adr/0590-the-audit-journal-records-changes-not-machine-chatter.md) (changes-only audit);
- spec [26](26-planning-loop-to-kim.md) (`planning.changed` on the ClientHub);
- spec [38](38-runner-updates-without-draining.md) (runner compat);
- spec [60](60-mobile-app.md) (the phone).

This is finding 2 of the Cloudflare cost audit, and this block's (AQ) spec.

## Goal
No Durable Object stays in memory to wait. A running job and an open Planning tab cost nothing
while nothing happens. They wake only when something does: a steer, a viewer arriving, a planning
change.

## What holds objects awake today
A Durable Object is billed as 128 MB for every second it is active. A pending request, `setTimeout`
or `setInterval` keeps it from hibernating (the Durable Objects pricing page and its WebSockets
best-practices page, read 2026-11-12).

| Where | How it waits | How often | Object held |
| --- | --- | --- | --- |
| `channel.ts` `steerReply` → `PlanningHub.waitForChange` | an RPC with a `setTimeout`, re-armed for each hold | every 25 s (`STEER_WAIT_MAX_MS`), for every running job | the work item's PlanningHub |
| `channel.ts` `planningReply` (`planning.wait`) → `PlanningHub.waitForChange` | the same | every ≤ 50 s (`PLANNING_WAIT_MAX_MS`), for every planning session | the same PlanningHub |
| `channel.ts` `terminalReply` → `TerminalRelay.waitForViewer` | an RPC with a `setTimeout` loop | every 25 s (`TERMINAL_WAIT_MAX_MS`), for every running job | the job's TerminalRelay |
| `PlanningHub.stream()` (the website's Planning tab, SSE) | an open response and a 25 s `setInterval` keepalive | as long as the tab is open | the work item's PlanningHub |

### The cost
Each of the four waits above, while it lasts, holds one object at 128 MB:
- **Per object:** 0.125 GB × 86,400 s is **10,800 GB-s a day**.
- **Per running job:** two objects (its PlanningHub and its TerminalRelay), so **21,600 GB-s a day**.
- **The allowance:** 400,000 GB-s a month are included, so about **18.5 job-days a month** are free.
- **Beyond it:** $12.50 per million GB-s.
  - A job-day costs about **$0.27**.
  - Eight job slots busy all month (240 job-days) come to about 5.2M GB-s, so about **$60 a month**.
  - A Planning tab left open all month holds its hub: 324,000 GB-s, about **$4**, or most of the
    allowance on its own.
- **Requests:** each hold is one request ($0.15 per million), so they cost little. The duration is
  the cost.

## Design
Three parts:
- **Part A** changes only the engine and works with every runner already deployed.
- **Part B** needs new runner code. Once runners have it, it removes the per-job holds entirely.
- **Part C** moves the website's Planning tab onto the ClientHub socket.

### Two rules every part keeps
1. **A push only wakes; every read and every hand-over goes through the existing calls.**
   - A push carries no data, only "look now". What the host is handed comes from the same fenced
     operation as today: `run.takeSteers`, `run.terminal.host`, `planning.wait`.
   - So a fenced host is still refused: a stale fencing token fails `run.takeSteers` before anything
     is handed over, whether the call came from a hold, a push or the safety poll.
   - It is also why nothing can be missed or handed over twice:
     - delivery state lives in D1, not in the push. `run.takeSteers` sets `delivered_at` in its own
       batch, guarded on `delivered_at IS NULL`, so a steer is handed over at most once;
     - a lost push leaves the steer queued for the next call (the safety poll, below, or the next
       hold);
     - a duplicate push makes one more call that finds nothing.
2. **The fenced operation runs first.** Every held call starts with its operation, as today:
   - `steerReply` calls `run.takeSteers` before it waits;
   - `terminalReply` calls `run.terminal.host`;
   - `planningReply` calls `planning.wait`.

   Only then does it wait, and it ends the wait by calling the operation again. A host whose lease
   has moved on is refused at once and never waits.

### Part A: the waits move out of the Durable Objects (engine only)
A request held **in the Worker** is not billed for its wall time: Workers Standard bills CPU time,
and waiting on a timer or on I/O uses none. So the held channel calls stay as they are on the wire,
but each wait polls a cheap indexed read instead of holding a Durable Object. The poll interval is
one named constant, `HELD_POLL_MS` = 3 s.

#### A1. Steers
1. `steerReply` calls `run.takeSteers` (fenced). If it returns steers, or the hold is 0 ms, it
   answers at once.
2. Otherwise, every `HELD_POLL_MS` until the 25 s are up, it reads
   `SELECT 1 FROM core_run_steers WHERE run_id = ? AND delivered_at IS NULL LIMIT 1`. This needs a
   new partial index, `core_run_steers_undelivered_idx ON core_run_steers (run_id) WHERE
   delivered_at IS NULL`, which holds only queued steers.
3. On a hit it calls `run.takeSteers` once more and answers. When the time is up, it answers empty
   without another call. Since ADR 0590, an empty take commits nothing.

It doesn't call the PlanningHub.

#### A2. The terminal
The relay is the only thing that knows whether a host or a viewer is really connected. Its sockets
are closed by a deploy (the object restarts), and `webSocketClose` may not run then. A mark in D1
such as "host connected at" or an open attach would then stay set, so Part A doesn't trust D1 for
connection state. D1 only says whether it is worth asking the relay.
1. `terminalReply` calls `run.terminal.host` (fenced), as today.
2. Every `HELD_POLL_MS` it reads whether the run has an open attach:
   `SELECT 1 FROM core_run_terminal_attaches WHERE run_id = ? AND closed_at IS NULL LIMIT 1`. This
   needs a new partial index, `core_run_terminal_attaches_open_idx ON core_run_terminal_attaches
   (run_id) WHERE closed_at IS NULL`.
3. When there is one, it calls a new quick RPC, **`TerminalRelay.hostTicket()`**. It returns
   `{ ticket: string | null, viewers: number }` at once, from the relay's live sockets
   (`getWebSockets`):
   - a fresh host ticket when a viewer is connected and no host is;
   - null otherwise.
4. **A stale attach.** When `hostTicket()` reports 0 viewers for an attach older than
   `TERMINAL_TICKET_TTL_MS`, that attach was left open by a deploy or a crash: an admitted viewer
   must connect within the ticket's lifetime.
   - The channel closes it through a new fenced runner operation, `run.terminal.closeStale` (risk
     write, `audit: { changesOnly }`). It sets `closed_at` on the run's open attaches older than the
     TTL that the relay doesn't have.
   - So a stale row wakes the relay at most once, not every 3 s.
5. `TerminalRelay.waitForViewer` and its timer are deleted. `state()` stays for tests.

#### A3. Planning
`planning.peek` today says whether there is news, but not **when it is due**. The batch rule (15 s
after a person's last answer, at once after a chat message or when no question is left open, never
while paused) lives only in `planning.wait`. And `planning.wait` writes `agent_seen_at` on every
evaluation that isn't due, so a 3 s loop of `planning.wait` would write every 3 s. So:
1. **`planning.peek` works out when news is due.**
   - It takes the wait's `idleMs`.
   - It reads the news after the cursor with `created_at` (`core_planning_events` on
     `(work_item_id, id)`, at most 200 rows, as now) and the open questions' count.
   - It answers `dueAt` (the same `batchDue` that `planning.wait` uses, null while paused) beside
     `news`, `yield` and `ended`.
   - It stays a read: it writes nothing.
2. **`planning.wait` writes `agent_seen_at` only when it is stale.** Its waiting branch keeps that
   column fresh under the same `SEEN_REFRESH_MS` (30 s) rule as `markWorking`, so even a wait
   evaluated often writes at most every 30 s.
3. **`planningReply`:**
   1. It calls `planning.wait` once (fenced; it answers `due`, `yield` and `ended` as today).
   2. Then, every `HELD_POLL_MS`, it calls `planning.peek` with the same `idleMs`, a read.
   3. It calls `planning.wait` again only when `dueAt <= now`, `yield` or `ended`, or at the hold's
      end (≤ 50 s), and answers with that.
   - Writes per idle planning session: one per hold (at most every 30 s from the seen rule), not one
     every 3 s.
4. It doesn't call the PlanningHub. `PlanningHub.waitForChange` and its timer are deleted.
   `PlanningHub.notify()` and `wake()` stay for the SSE stream until Part C.

#### The cost after Part A
- **Durable Objects:** 0 GB-s for a job that nothing happens to.
  - The relay wakes only when a viewer attaches, for one `hostTicket()`, and for its sockets.
  - The hub wakes only for the SSE stream, until Part C.
- **D1, per running job:** at most 8 indexed point reads per 25 s hold, for each of the steer and
  terminal holds, on partial indexes that hold only queued steers and open attaches. That is about
  55k reads a day. At $0.001 per million rows read (25 billion included), it costs nothing.
- **D1 load:** about 0.6 queries a second per job, so about 5 for eight jobs, each well under a
  millisecond.
- **Latency:** a steer or a viewer is noticed within 3 s instead of at once. Planning news is
  noticed within 3 s, and its 15 s batch rule dominates anyway.

### Part B: one hibernatable socket per job (runner capability `job-line`)
Polling is cheap, but it still costs a few hundred thousand queries a day across a fleet. Part B
replaces the held calls with pushes.

- **The connection.** A runner host that declares the capability `job-line` opens one WebSocket
  per running job, to the job's TerminalRelay. The relay is already per job and already accepts
  sockets with `acceptWebSocket`.
  - It connects with a one-use ticket from a new signed channel call, `jobs/<id>/line`. The call is
    fenced like the others, and the socket is tagged `line`.
  - The relay keeps the socket hibernated and already sets `setWebSocketAutoResponse("ping",
    "pong")`. The host pings every 30 s, and auto-responses aren't billed.
- **The pushes.** The relay pushes three messages down the line, each a few bytes:
  - `{ t: "steer" }`, from the outbox's `run.steered` message (routing below);
  - `{ t: "viewer" }`, when `admit()` lets a viewer in and no terminal host is connected;
  - `{ t: "planning" }`, from `planning.changed` for a work item with a planning job.
- **What the host does on a push** (rule 1): it makes the existing signed call **without holding**
  (`waitMs: 0`):
  - `steers` for a steer, which runs `run.takeSteers` (fenced);
  - `terminal` for a viewer, which runs `run.terminal.host` (fenced) and answers with a host
    ticket at once;
  - for planning, the hook's local wait in `planning-relay.ts` wakes and calls `planning.wait`
    once.

  Fencing, the audit and the idempotency rules don't change.
- **Routing `run.steered`.** The outbox message today carries only `workItemId`, but the relay is
  keyed by job.
  - `run.steer` and `run.takeover` already load the run, so the message gains `jobId` (an additive
    field in `OutboxMessage`). Delivery sends `{ t: "steer" }` to `terminalRelay(jobId)`.
  - A message queued before that deploy has no `jobId`. Delivery looks the job up once:
    `SELECT job_id FROM core_runs WHERE work_item_id = ? AND status IN (…active) ORDER BY run_no
    DESC LIMIT 1`, on `UNIQUE (work_item_id, run_no)`.
  - `planning.changed` is routed the same way, to the planning job's relay when the work item has
    an active planning run.
- **How the host knows the engine has the line.** The heartbeat's answer gains an optional
  `engine: { capabilities: ["job-line"] }` (additive, so it isn't a compat change).
  - A host uses the line only when both it and the engine declare `job-line`. Otherwise it keeps
    the Part A held calls.
  - If `jobs/<id>/line` answers 404 or `unavailable` (an engine rolled back), the host goes back to
    held calls for that job and asks again after its next heartbeat.
- **A dropped or half-open line.**
  - **Dropped:** when the line drops, the host reconnects with backoff. It makes each call once with
    `waitMs: 0` as soon as it is back, so nothing that happened while it was down is missed.
  - **Half-open:** a socket can be half-open, so no close ever comes. The host treats a ping
    without a pong within 10 s as a drop.
  - **Safety poll:** the host also makes each call once with `waitMs: 0` every **5 minutes** while
    the line is up. A push lost to a half-open socket that still answers pings is then noticed
    within 5 minutes, not never. That is 3 calls per job per 5 minutes, about 860 a day, with no
    writes when nothing is due (ADR 0590).
- **The cost:**
  - **Durable Objects:** 0 GB-s while idle. One request to open each line, and one per message
    sent to the relay. Outgoing messages and auto-responded pings are free, and incoming messages
    count 20:1.
  - **D1:** no polling, apart from the safety poll.

### Part C: Planning tabs on the ClientHub (website)
The desktop already hears `planning.changed` on its per-person ClientHub socket (spec 26), and
`notifyPlanningViewers` already sends it to everyone whose Planning view is open. The website moves
to the same socket.

- **The route.** sf-app serves `GET /api/live` as a WebSocket upgrade for the signed-in person. It
  forwards the upgrade to `EngineApi.clientSocket(userId, sessionId)`, a new RPC that returns the
  ClientHub's `fetch` response. The socket is tagged with the session and its expiry.
- **Sign-out.**
  - Signing out (or the session being revoked) emits a `session.revoked` outbox message, like
    `device.revoked` (ADR 0541). Its delivery calls `ClientHub.closeSession(sessionId)`, which
    closes that session's sockets at once.
  - The hub also checks a socket's expiry before each push it sends, so an expired session's
    socket is closed on its next push, not left open.
  - A closed socket on the page falls back to the 15 s poll, which fails with 401 and sends the
    page to sign-in.
- **The page.** `planning.tsx` replaces its `EventSource` with the socket, pings every 30 s, and
  re-reads `planning.get` on `planning.changed`. It falls back to its 15 s poll if the socket can't
  open.
- **What goes.** `PlanningHub.stream()`, its `setInterval` and `apps/app/src/server/planning-live.ts`
  are deleted. Once nothing calls the PlanningHub (after Part A and Part C), the class is deleted
  too, with a `deleted_classes` Durable Object migration.
- **The cost:** an open tab is 0 GB-s while idle. It wakes the ClientHub once per change, for a few
  milliseconds.

## Every client while this rolls out
- **Old runners still polling (runner compat, spec 38).**
  - Part A needs no runner change. Every runner keeps its held calls, which are now answered from
    the Worker. Part A ships first and removes the whole cost on its own.
  - Part B is a capability that both sides must declare. A runner without `job-line`, or any runner
    against an engine without it, keeps the Part A held calls.
  - `RUNNER_COMPAT` doesn't change. Once every runner that has heartbeated in 30 days declares
    `job-line`, the engine may stop answering held calls by raising the compat level, as spec 38
    describes. That is a separate decision.
- **Old desktop builds (the door's protocol handshake, ADR 0393).**
  - The desktop already uses the ClientHub through the door's `live` socket, and this spec changes
    nothing on the door or on what the socket sends. So `DOOR_PROTOCOL` doesn't change, and no
    build is refused.
  - The ClientHub's new `closeSession` and the tags for website sockets apply only to sockets
    opened through `/api/live`. Desktop sockets are tagged by device as today.
- **The phone (spec 60).**
  - The phone connects through the same door with a `mobile` token, and its live socket is the
    same ClientHub. It needs nothing from this spec.
  - Spec 60's Planning screens poll `planning.get` every 3 s while open. They should listen for
    `planning.changed` on the live socket instead, the way the desktop does, with a slow poll as a
    fallback. That is a change for spec 60's own PRs, noted there. Until then, the phone's polling
    costs D1 reads, not Durable Object time.

## What changes where
| PR | Package | Change |
| --- | --- | --- |
| 1 | `apps/engine` | `channel.ts`: `steerReply` and `terminalReply` poll in the Worker (`HELD_POLL_MS`); `terminal-relay.ts`: `hostTicket()`, `waitForViewer` deleted |
| 1 | `packages/core` | `run.terminal.closeStale` |
| 1 | `packages/db` | a migration: `core_run_steers_undelivered_idx`, `core_run_terminal_attaches_open_idx` |
| 2 | `packages/core` | `planning.peek` answers `dueAt` (takes `idleMs`); `planning.wait`'s waiting branch writes `agent_seen_at` only when stale |
| 2 | `apps/engine` | `planningReply` loops on `planning.peek`; `PlanningHub.waitForChange` deleted |
| 3 | `apps/app` | `/api/live`, `planning.tsx` on the socket, `planning-live.ts` deleted |
| 3 | `apps/engine` | `EngineApi.clientSocket`, `ClientHub.closeSession`, `session.revoked`; `PlanningHub` deleted with its DO migration |
| 4 | `packages/runner-contract` | the `job-line` capability, `PATHS.line`, the line messages' schemas, the heartbeat's `engine.capabilities` |
| 4 | `apps/engine` | relay line sockets and the three pushes; the `line` channel call; `run.steered` carries `jobId`, routed to the relay; an ADR (block AQ, 0591) |
| 5 | `local/runner-host` | `job.ts` (steer loop), `terminal.ts` (held call) and `planning-relay.ts` (hook wait) use the line when both sides have it; reconnect, the ping deadline and the 5-minute safety poll |
| — | `packages/runner-local`, `apps/desktop` | none |

## Acceptance criteria
1. **No timer or held request in a Durable Object.** No DO class keeps a `setTimeout`,
   `setInterval` or held request to wait. A grep test in `apps/engine` fails if one comes back.
2. **No objects held by idle jobs.** With Part A deployed, a running job that nothing happens to
   holds no Durable Object in memory. Check it on the Durable Objects dashboard: duration for
   PlanningHub and TerminalRelay drops to near zero with jobs running.
3. **Fencing holds.** A host with a stale fencing token is refused by `steers`, `terminal` and the
   planning calls whether it holds, is pushed or polls. Each is tested.
4. **No lost or duplicated messages.**
   - A steer reaches the runner, and a viewer gets a terminal, within `HELD_POLL_MS` + 1 s under
     Part A, and within 1 s under Part B.
   - A steer is handed over exactly once when a push is duplicated or lost (the safety poll then
     takes it).
   - The existing steer, terminal and planning-flow tests pass unchanged against both parts.
5. **Planning writes stay rare.** An idle planning session under Part A writes at most once per
   30 s, tested by counting statements over a minute's hold.
6. **No stale connection state.** After the relay restarts (a deploy), an attach left open is
   closed within one poll, and a waiting host is not handed a ticket for a viewer who is gone.
7. **Old clients keep working.**
   - A runner without `job-line`, and a `job-line` runner against an engine without it, keep
     working. Both are tested with the current runner-host against the new engine.
   - Desktop builds at every protocol the door serves are unaffected.
8. **Idle Planning tabs cost nothing, and sign-out closes their socket.** An open website Planning
   tab updates within a second of a change, costs no Durable Object duration while idle, and its
   socket closes when the person signs out.
9. **The guards cover the new reads.** The query-plan guard registers the steer, terminal and
   planning polls and `run.steered`'s job lookup.

## PR breakdown
1. **Steers and the terminal** (Part A1 and A2): engine, core and a migration. It removes the per-job
   hold cost on its own.
2. **Planning** (Part A3): `planning.peek`'s `dueAt`, the seen rule and `planningReply`'s loop.
3. **The website** (Part C): `/api/live`, sign-out, `planning.tsx` on the socket, PlanningHub
   deleted. It comes after #85 and #90, which touch `planning.tsx`.
4. **The runner socket: contract and engine, with an ADR** (Part B, engine side): the capability,
   the line call and sockets, the pushes, `run.steered` routed by job, and the heartbeat's
   `engine.capabilities`. It sits behind the capability, so it is inert until PR 5 ships.
5. **The runner host** (Part B, host side): the line, reconnect, the ping deadline and the safety
   poll. Deploy order doesn't matter: each side uses the line only when both declare it.
