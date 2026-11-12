# Spec 44: Durable Objects are never held awake

**Status: specified, not built.** The coordinator schedules the build, because other sessions own
the code it touches and have open PRs in it (#73, #85, #90, the Work section).

**Read first:**
- [AGENTS.md, "Cloudflare cost"](../../AGENTS.md#cloudflare-cost), rules 5 and 6;
- ADR [0350](../adr/0350-how-the-planning-loop-is-wired.md) (PlanningHub);
- ADR [0400](../adr/0400-watch-and-steer-runs-from-the-dashboard.md) (the held steer call);
- ADR [0440](../adr/0440-a-web-terminal-relayed-through-a-durable-object-per-job.md) (TerminalRelay);
- spec [26](26-planning-loop-to-kim.md) (`planning.changed` on the ClientHub);
- spec [38](38-runner-updates-without-draining.md) (runner compat).

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
| `PlanningHub.stream()` (sf-app's Planning tab, SSE) | an open response and a 25 s `setInterval` keepalive | as long as the tab is open | the work item's PlanningHub |

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
Two parts. Part A changes only the engine and works with every runner already deployed. Part B
needs new runner code and, once runners have it, removes the per-job holds entirely.

### Part A: the waits move out of the Durable Objects (engine only)
A request held **in the Worker** is not billed for its wall time: Workers Standard bills CPU time,
and waiting on a timer or on I/O uses none. So the held channel calls stay as they are on the wire,
but each wait polls a cheap indexed read instead of holding a Durable Object.

- **`steerReply`** waits by re-reading the run's undelivered steers every **3 s** until one comes
  or the hold's 25 s run out.
  - The read is `SELECT 1 FROM core_run_steers WHERE run_id = ? AND delivered_at IS NULL LIMIT 1`,
    through `core_run_steers_run_idx`.
  - Then it calls `run.takeSteers` once. Since ADR 0590 that commits nothing when the run has none.
  - It doesn't call the PlanningHub at all.
- **`planningReply` (`planning.wait`)** re-evaluates every **3 s** (or at `recheckAt`, if sooner).
  It uses `planning.peek` (a read) and calls `planning.wait` only when the peek says news is due or
  the session must yield. It doesn't call the PlanningHub at all.
- **`terminalReply`** waits by re-reading every **3 s**. It asks whether a viewer is waiting and no
  host is connected.
  - **New column:** the relay records whether its host is connected in D1, as
    `core_runs.terminal_host_at` (set when a host socket opens, cleared when it closes: rare).
  - The Worker reads it together with the open attaches (`closed_at IS NULL`).
  - When a viewer is waiting, it calls `TerminalRelay.mint()`, a quick RPC that returns at once,
    for the host ticket.
- **`PlanningHub.waitForChange`**, **`TerminalRelay.waitForViewer`** and their timers are deleted.
  - `PlanningHub.notify()` and `wake()` stay for the SSE stream until Part C.
  - The outbox's `planning.changed` delivery stays; Part C retires the hub.
- **The cost after Part A:**
  - **Durable Objects:** 0 GB-s for a job that nothing happens to. The relay wakes only for a
    viewer or a host socket. The hub wakes only for the SSE stream, until Part C.
  - **D1, per running job:** at most 8 indexed point reads per 25 s hold, for each of the steer and
    terminal holds. That is about 55k reads a day, a few rows each. At $0.001 per million rows read
    (25 billion included), it costs nothing.
  - **D1 load:** about 0.6 queries a second per job, so 5 for eight jobs, each well under a
    millisecond.
- **The latency cost:** a steer or a viewer is noticed within 3 s instead of at once. Planning news
  is noticed within 3 s; its batch rule (15 s after the last answer) dominates anyway. 3 s is a
  named constant (`HELD_POLL_MS`) and can be tuned.

### Part B: one hibernatable socket per job (runner capability `job-line`)
Polling is cheap, but it still costs a few hundred thousand queries a day across a fleet. Part B
replaces the held calls with pushes.

- **The connection.** A runner host that declares the capability `job-line` opens one WebSocket
  per running job, to the job's TerminalRelay. The relay is already per job and already accepts
  host sockets with `acceptWebSocket`.
  - It connects with a one-use ticket from a new signed channel call, `jobs/<id>/line`, which is
    fenced like the others.
  - The relay keeps the socket hibernated and sets `setWebSocketAutoResponse("ping", "pong")` (it
    already does). The host pings every 30 s; auto-responses aren't billed.
- **The pushes.** The relay pushes three messages down the line, each a few bytes:
  - `{ t: "steer" }`, from the outbox's run-steer message (today `PlanningHub.wake`);
  - `{ t: "viewer" }`, when a viewer is admitted and no terminal host is connected;
  - `{ t: "planning" }`, from `planning.changed` for a planning job.
- **What the host does on a push.** It makes the existing signed call **without holding**
  (`waitMs: 0`):
  - `steers` for a steer;
  - `terminal` for a viewer, which answers with the host ticket at once;
  - for planning, the hook's local wait in `planning-relay.ts` wakes and calls `planning.wait` once.

  Fencing, the audit and the idempotency rules don't change.
- **A dropped line.** When the line drops, the host reconnects with backoff and makes each call
  once with `waitMs: 0`, so nothing that happened while it was down is missed.
- **The cost:**
  - **Durable Objects:** 0 GB-s while idle. One request to open each line, and one per message
    sent to the relay. Outgoing messages and auto-responded pings are free, and incoming messages
    count 20:1.
  - **D1:** no polling at all.

### Part C: Planning tabs on the ClientHub (website)
The desktop already hears `planning.changed` on its per-person ClientHub socket (spec 26), and
`notifyPlanningViewers` already sends it to everyone whose Planning view is open. The website moves
to the same socket.

- **The route.** sf-app serves `GET /api/live` as a WebSocket upgrade for the signed-in person. It
  forwards the upgrade to `EngineApi.clientSocket(userId)`, a new RPC that returns the ClientHub's
  `fetch` response, the same door the desktop uses, authenticated by the session.
- **The page.** `planning.tsx` replaces its `EventSource` with the socket, pings every 30 s, and
  re-reads `planning.get` on `planning.changed`. It falls back to its 15 s poll if the socket
  can't open.
- **What goes.** `PlanningHub.stream()`, its `setInterval` and `apps/app/src/server/planning-live.ts`
  are deleted. Once nothing calls the PlanningHub (after Part A and Part C), the class is deleted
  too, with a `deleted_classes` Durable Object migration.
- **The cost:** an open tab is 0 GB-s while idle. It wakes the ClientHub once per change, for a few
  milliseconds.

## Old runners while they're still out there (runner compat, spec 38)
- **Part A** needs no runner change. Every runner keeps its held calls, which are answered from the
  Worker instead of from a Durable Object. It ships first and removes the whole cost on its own.
- **Part B** is a capability.
  - A runner without `job-line` keeps the Part A held calls, and one with it stops making them.
  - `RUNNER_COMPAT` doesn't change for Part B. Once every runner that has heartbeated in 30 days
    declares `job-line`, the engine can stop answering held calls and raise the compat level, as
    spec 38 describes.
- **Part C** is website-only. Desktops already use the ClientHub.

## What changes where
| Package | Part A | Part B | Part C |
| --- | --- | --- | --- |
| `apps/engine` | `channel.ts`: the three holds poll in the Worker (`HELD_POLL_MS`); `planning-hub.ts`: `waitForChange` deleted; `terminal-relay.ts`: `waitForViewer` deleted, `mint()` exposed, host state written to D1 | relay: line sockets and the three pushes; channel: the `line` call; outbox: steer and planning pushes go to the relay | `rpc.ts`: `clientSocket`; `planning-hub.ts` deleted with its DO migration |
| `packages/db` | a migration: `core_runs.terminal_host_at` | — | — |
| `packages/runner-contract` | — | the `job-line` capability, `PATHS.line`, the line messages' schemas | — |
| `local/runner-host` | — | `job.ts` (steer loop), `terminal.ts` (held call) and `planning-relay.ts` (hook wait) use the line when the engine and the runner both have it | — |
| `packages/runner-local` | — | none: the adapter's `steer` and terminal bridge are unchanged | — |
| `apps/app` | — | — | `/api/live`, `planning.tsx` on the socket, `planning-live.ts` deleted |
| `apps/desktop` | — | — | none |

## Acceptance criteria
1. **No timer or held request in a Durable Object.** No DO class keeps a `setTimeout`,
   `setInterval` or held request to wait; a grep test in `apps/engine` fails if one comes back.
2. **No objects held by idle jobs.** With Part A deployed, a running job that nothing happens to
   holds no Durable Object in memory. Check it on the Durable Objects dashboard: duration for
   PlanningHub and TerminalRelay drops to near zero with jobs running.
3. **No lost or delayed messages.**
   - A steer reaches the runner, and a viewer gets a terminal, within `HELD_POLL_MS` + 1 s under
     Part A, and within 1 s under Part B.
   - The existing steer, terminal and planning-flow tests pass unchanged against both parts.
4. **Old runners keep working.** A runner without `job-line` keeps working throughout. That is
   tested with the current runner-host against the new engine.
5. **Idle Planning tabs cost nothing.** An open Planning tab on the website updates within a
   second of a change, and costs no Durable Object duration while idle.
6. **The guards cover the new reads.** The query-plan guard registers the three held-call polls.

## Build order
1. Part A, one PR.
2. Part C, one PR, after #85 and #90 have merged, since they touch `planning.tsx`.
3. Part B, two PRs: engine and contract first, then runner-host. Behind the capability, so the
   order of deploys doesn't matter.
