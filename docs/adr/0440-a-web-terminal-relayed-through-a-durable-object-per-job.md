# ADR 0440: A web terminal relayed through a Durable Object per job

Status: accepted, 2026-11-12. Plan:
[`.kim/plans/2026-11-11-run-agents-on-hosts-without-orca.md`](../../.kim/plans/2026-11-11-run-agents-on-hosts-without-orca.md)
(piece 6). Spec [35](../specs/35-web-terminal.md). Builds on [0016](0016-signed-runner-channel.md),
[0380](0380-runner-local-tmux-and-hook-status.md), [0400](0400-watch-and-steer-runs-from-the-dashboard.md),
[0051](0051-operations-rpc-on-the-engine.md), [0023](0023-runners-owned-by-users-and-requester-routing.md)
and [0038](0038-runner-sharing-is-an-owner-allowlist.md).

## Context
Since piece 2 the Live tab shows a run's transcript and a polled terminal log (screens every ~10 s),
and the runner's owner can steer with one-line messages. To really step in (answer a menu, press
Escape, scroll a diff) a person still has to `tmux attach` on the host. The owner wants the job's real
tmux pane in the browser: they type, others in the org watch, every attach is on the record. The host
must stay outbound-only with no standing token, and the same relay must serve a cloud sandbox (piece
7), where the daemon is inside a box the factory made.

## Decision
1. **A Durable Object per job relays the bytes** (`TerminalRelay` in sf-engine, keyed by the job id).
   The host connects to it outbound over a WebSocket; browsers connect to the same object through
   sf-app. No port opens on the host, and a sandbox's daemon does exactly what a Mac's does. The
   object uses the hibernation API (`acceptWebSocket`, tags, attachments, a ping auto-response), so
   an idle relay costs nothing, and keeps nothing but its sockets and its tickets.
2. **The host learns of a viewer on the signed channel, and connects with a one-use ticket.** While
   a job's session runs, the host keeps one held `terminal` call open (`POST
   /runner/v1/jobs/<id>/terminal`), like the `steer` call (ADR 0400): signed, scoped by the job and
   its fencing token (`run.terminal.host`, fenced), not stored. sf-engine holds it on the job's relay;
   when a viewer is waiting and no host is connected, the relay mints a random ticket (one use,
   60 s) and the call answers with the socket URL carrying it. The ticket is the only credential the
   socket needs and it dies with its first use; the runner key never leaves the host and no token
   outlives a connection. A WebSocket upgrade can't carry the channel's request signature (the body
   hash and the idempotency key mean nothing for a socket), so the signed call vouches for the
   ticket instead. A separate call rather than a field on `steer`'s answer: an adapter may have one
   without the other, and the relay can answer it directly without the outbox.
3. **The browser attaches through an operation.** sf-app's `/api/work/<id>/runs/<run>/terminal`
   checks the session and a same-origin `Origin` (a WebSocket is not covered by CORS), and calls
   `EngineApi.terminalAttach` as the person. That runs `run.terminal.attach` (human, member, `write`):
   it decides the mode and records the attach (who, when, `type` or `watch`) in
   `core_run_terminal_attaches` with its audit row; the relay closes it with `run.terminal.detach`
   when the socket goes. The relay then mints a viewer ticket bound to that attach, and sf-app opens
   the viewer socket through the service binding (`EngineApi.fetch`, not routed on the public
   hostname) and hands the upgrade to the browser.
4. **Only the runner's owner types; the relay enforces it.** `type` is given only to the owner of
   the run's runner (ADR 0023, 0038: it is their machine and their model credential), the same rule
   as `run.steer`. The mode is fixed in the ticket and in the socket's attachment; the relay forwards
   input and resizes only from `type` sockets and closes a `watch` socket that sends either (1008). A
   watcher's page never sends them; that is a courtesy, not the control.
5. **The host bridges tmux with a control-mode client, not a PTY.** runner-local runs `tmux -L
   software-factory -C attach -t =sf-<jobId>` over plain pipes. Output comes as `%output` lines (octal
   escapes decoded to bytes), input goes in as `send-keys -H` (hex: nothing the browser sends can
   become a tmux command), the size is `refresh-client -C <cols>x<rows>`, and a redraw is
   `capture-pane -p -e` plus the cursor position, answered in order with the output stream. Why not
   `tmux attach` under a PTY: node-pty is a native module (a compiler and rebuilds on each Node
   update, on Mac and Linux), and `script(1)` differs between BSD and util-linux and can't be resized
   from outside. Control mode is tmux's own API for this (iTerm2 uses it), needs only tmux ≥ 3.2
   (already required, ADR 0380), behaves the same on both platforms and is testable with a real tmux.
   A control client only resizes the pane when asked, so a watch-only bridge leaves the pane alone.
6. **The bridge runs only while someone watches.** It starts when the host's socket opens, the relay
   asks it to redraw when a viewer joins, and the relay tells the host to stop (and closes its socket)
   when the last viewer leaves. When the session ends the host reports it, the relay tells the
   viewers and closes them, and the held call ends with the job.
7. **Bytes are bounded.** At most 8 viewers per job; input messages over 4,096 characters and output
   frames over 64 KiB are dropped by the relay. The host coalesces output into frames of at most
   32 KiB, and while its socket's buffer is over 1 MiB it drops output and redraws once the buffer is
   under 256 KiB: a slow link sees a jump, never an unbounded queue. Workers have no `bufferedAmount`
   to read on the relay's side, so the host is where backpressure lives.
8. **Additive wire changes, no contract bump.** The `terminal` capability, the job call and
   `run.live`'s `terminal` field are new; an older host never asks, and a new host whose engine
   answers the call with 404 stops asking. As with ADR 0400 the engine deploys first, and a runner
   declares `terminal` only after it has updated to the engine's commit (ADR 0360).

Amended 2026-11-12 (ADR 0530): the client door is a second way in for viewers. Desktop tokens attach
at `GET /client/v1/terminal/<item>/<run>`, through the same `run.terminal.attach` and relay ticket as
sf-app's route (shared in `terminal-attach.ts`).

## Consequences
- A person sees the job's real screen in the Live tab; the owner can type into it, everyone else
  watches, and every attach is two rows (the attach and its audit), closed when the socket goes.
- Each running job that can bridge a terminal holds one more channel call (~one request per 25 s),
  like `steer`. A bridge costs nothing while nobody watches.
- The owner typing in the browser resizes the pane (tmux's `window-size latest`), so the polled
  screen logs and an owner attached by `tmux attach` follow the browser's size until they type or
  resize themselves.
- A viewer sees the visible screen, not scrollback. A ticket in the socket URL can show up in logs,
  but it is one-use and expires in a minute.
- Piece 7 (sandboxes) implements `openTerminal` in the sandbox's daemon and reuses the call, the
  relay and the page unchanged. Piece 8 (the chat UI) is a different view on the same Live tab.

> Amended 2026-11-12 (spec [43](../specs/43-runners-under-load.md), incident #11): tmux 3.6a
> (and 3.5a, per a Fedora crash report) can SIGSEGV in `control_discard()`. In 3.6a's `control.c` that
> function is reached only from `control_check_age()`, when a control client without `pause-after` falls
> more than `CONTROL_MAXIMUM_AGE` behind reading a pane's output. tmux then marks the client "too far
> behind" and discards its queued output. A slow or stalled bridge (a host under load, a closed client
> that still has output queued) is exposed to it. So the bridge now attaches with `-f pause-after=60`:
> a lagging client gets the pane paused (`%pause`) instead, which the bridge continues
> (`refresh-client -A '%N:continue'`) and redraws, and output arrives as `%extended-output`. The
> bridge also sends `detach-client` before closing its input, so tmux ends the client on its own terms.
> The 8 crash reports in a day came from short-lived servers that `terminal.test.ts` started inside
> factory jobs (sockets `sf-term-test-<pid>`). Those tests now skip when `SOFTWARE_FACTORY_RUN=1`.

> Note 2026-11-12 (spec 43): with `pause-after=60`, a viewer that falls a minute behind loses the
> output since the pause and sees a redraw of the current screen instead. The job's logs
> (`capture-pane`) are unaffected.
