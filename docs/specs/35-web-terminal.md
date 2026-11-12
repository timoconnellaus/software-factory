# Spec 35: A web terminal in the dashboard

Read first: the plan ([`.kim/plans/2026-11-11-run-agents-on-hosts-without-orca.md`](../../.kim/plans/2026-11-11-run-agents-on-hosts-without-orca.md)),
ADRs [0440](../adr/0440-a-web-terminal-relayed-through-a-durable-object-per-job.md),
[0400](../adr/0400-watch-and-steer-runs-from-the-dashboard.md), [0380](../adr/0380-runner-local-tmux-and-hook-status.md),
[0016](../adr/0016-signed-runner-channel.md), [0051](../adr/0051-operations-rpc-on-the-engine.md),
[0023](../adr/0023-runners-owned-by-users-and-requester-routing.md) and
[0038](../adr/0038-runner-sharing-is-an-owner-allowlist.md); specs [30](30-runner-local-without-orca.md)
and [31](31-watch-and-steer-runs.md); `apps/engine/src/channel.ts`, `packages/runner-local`,
`local/runner-host` and the Live tab (`apps/app/src/components/live-run-view.tsx`).

This is piece 6 of 8 in the plan. Accounts (3), containers (4), Sprites (7) and the chat UI (8) have
their own specs.

## Goal
On a running job's Live tab, a person opens the job's real tmux pane in the browser. The runner's
owner can type into it; everyone else in the org watches read-only. Every attach is journalled. The
host only connects outbound and holds no standing token, and the relay works the same for a cloud
sandbox later.

## Scope
- **Runner contract** (additive, no `CONTRACT_VERSION` bump):
  - a **`terminal`** capability: the adapter can bridge the live session's terminal
    (`RunnerAdapter.openTerminal?`);
  - `openTerminal(session, { size, onOutput, onSize, onExit })` → `{ write, resize, redraw, close }`:
    raw output bytes out, the pane's size, keystrokes in, a full redraw on request;
  - a held job call **`terminal`** (`POST /runner/v1/jobs/<id>/terminal`, `{ fencingToken, waitMs? }`
    → `{ connect: { url } | null }`), not stored, answered with a one-use socket URL when someone is
    watching; `ControlPlaneClient.terminal?`;
  - the relay's frames and limits (`terminal.ts`): `TerminalSize` (clamped to 20–400 × 5–200), the
    host's, the relay's and the viewer's JSON control messages, binary output frames,
    `TERMINAL_MAX_VIEWERS` (8), `TERMINAL_INPUT_MAX` (4,096 characters), `TERMINAL_FRAME_MAX`
    (64 KiB), `TERMINAL_TICKET_TTL_MS` (60 s).
- **Core** (`packages/core`), migration **0210** (`core_run_terminal_attaches`: id, run, work item,
  user, mode, opened, closed):
  - `run.terminal.attach { workItemId, runId }`: human, `member`, risk `write`. Mode `type` for the
    owner of the run's runner, `watch` for everyone else. Refuses (`conflict`) an ended run and
    (`unavailable`) a runner whose manifest lacks `terminal`. Records the attach.
  - `run.terminal.detach { workItemId, attachId }`: human, `member`, risk `write`; stamps `closed_at`
    on the caller's own attach (the relay calls it when the socket closes).
  - `run.terminal.host { jobId, fencingToken }`: runner, fenced, read. The run for a live job of this
    runner (refuses another runner's job and an ended run).
  - `run.live` gains `terminal: { allowed, mode, reason }` for the viewer.
- **Engine** (`apps/engine`):
  - a **TerminalRelay** Durable Object per job (`TERMINAL_RELAY`, migration tag `v3-terminal-relay`),
    with hibernatable WebSockets: one host socket and up to 8 viewer sockets. It mints one-use
    tickets (60 s), forwards output to every viewer, forwards input and resizes only from `type`
    viewers (a `watch` viewer that sends either is closed with 1008), asks the host for a redraw when
    a viewer joins, tells the host to stop when the last viewer leaves, closes viewers when the host
    reports the session ended, drops frames over the caps, and journals each close with
    `run.terminal.detach`;
  - the channel's `terminal` call: `run.terminal.host`, then waits on the job's relay until a viewer
    is waiting and no host is connected (answering with a fresh host ticket) or ~25 s pass;
  - the host socket `GET /terminal/v1/jobs/<id>/host?ticket=…` on the public hostname;
  - `EngineApi.terminalAttach(workItemId, runId, options)`: `run.terminal.attach` as the person, then
    a viewer ticket from the relay; `EngineApi.fetch` serves the viewer socket
    `/terminal/v1/jobs/<id>/view?ticket=…`, reachable only through the service binding.
- **App** (`apps/app`):
  - `GET /api/work/<id>/runs/<run>/terminal` (WebSocket): signed-in, same-origin `Origin` only,
    `terminalAttach` as the person, then the engine's viewer socket proxied through the binding;
  - the Live tab gets a **Web terminal** view next to Transcript and Terminal while the run is active
    and the runner declares `terminal`: xterm.js, "You can type" or "Watching read-only", resized to
    the pane for watchers and fitted (and the pane resized to it) for the owner; disconnected when the
    tab is left or the run ends.
- **runner-local**: declares `terminal`. `openTerminal` attaches a **tmux control-mode client**
  (`tmux -L software-factory -C attach -t =sf-<jobId>`, plain pipes, no PTY) and:
  - decodes `%output` for the job's pane into bytes;
  - types with `send-keys -H` (hex, so nothing in the input is a tmux command);
  - resizes with `refresh-client -C <cols>x<rows>` (only when asked; a watch-only bridge never sets a
    size, so it doesn't change the pane);
  - redraws from `capture-pane -p -e` and the cursor position, in order with the output stream;
  - reports the pane's size, and `onExit` on `%exit` or the client's exit.
- **Runner host**: once the session has started, a job whose adapter declares `terminal` keeps one
  `terminal` call open. When it answers with a URL the host opens the WebSocket, starts the bridge,
  relays frames both ways, and stops the bridge when the relay closes, the job ends or the call is
  fenced. Output is coalesced into frames of at most 32 KiB; while the socket's buffer is over
  1 MiB output is dropped, and once it drains below 256 KiB the host sends a redraw. A 404 (an older
  engine) stops the loop.
- **Docs**: `CONTEXT.md` (Web terminal, Terminal relay, `terminal` capability),
  `docs/architecture.md`, the runner-contract, runner-local, runner-host and engine READMEs.

## Out of scope
- The chat UI and stream-json sessions (piece 8), containers (4), accounts (3), Sprites (7). The host
  side is generic: a sandbox's daemon implements `openTerminal` and uses the same loop.
- Scrollback beyond the visible screen in the web terminal (tmux keeps it; a person can scroll in a
  `tmux attach`).
- Letting someone other than the runner's owner type, or handing typing over.
- A web terminal in the desktop app (spec 40) or the CLI.

## Acceptance criteria
1. On a running build, the runner's owner opens Web terminal on the Live tab and sees the live
   Claude Code screen within a few seconds, types into it (Claude receives it), and the pane resizes
   to the browser.
2. Another member of the org opens the same run's Web terminal and sees the same screen update live,
   read-only: the page sends no input, and the relay closes a watch-only socket that sends input or a
   resize anyway. Typing is never forwarded to the host from a watcher.
3. Every attach is an operation: `run.terminal.attach` is in the registry with zod schemas, a
   description, a permission and a risk class, each attach has an audit row and a
   `core_run_terminal_attaches` row naming who, when and the mode, and its close is stamped.
4. An ended run, or a runner without `terminal`, is refused (`conflict`, `unavailable`); a person
   outside the org can't attach (`forbidden`/`not_found`); a ninth viewer is refused.
5. The host connects only outbound: it learns of a viewer over the signed channel's held `terminal`
   call, scoped by the job and its fencing token (a stale token is refused), and the socket needs a
   ticket the relay minted for that job, which works once and expires after 60 s.
6. The bridge runs only while someone watches: it starts when the host connects, and stops when the
   last viewer leaves or the session ends; the viewers are told the session ended.
7. Bytes are bounded: at most 8 viewers, input messages over 4,096 characters and output frames over
   64 KiB are dropped by the relay, and the host drops output while its socket is backed up and
   redraws once it drains.
8. The runner-local bridge, on a real tmux, streams a session's output, types input (including
   control characters) with `send-keys -H`, resizes the pane, redraws the screen, and reports exit.
9. An older engine (no `terminal` call) doesn't break a new host: the host stops asking and the run
   goes on.
10. `pnpm lint`, `pnpm typecheck` and `pnpm test` pass.

> Note 2026-11-12 (spec [43](43-runners-under-load.md)): the bridge attaches with `-f pause-after=60`
> and reads `%extended-output` and `%pause`, which avoids tmux 3.5a/3.6a's `control_discard` crash path
> (ADR 0440's dated note). It detaches before closing. The real-tmux tests in `terminal.test.ts` skip
> inside factory jobs (`SOFTWARE_FACTORY_RUN=1`; `SF_TMUX_CONTROL_TESTS=1` runs them anyway).
