# ADR 0500: The client door carries the web terminal

Status: accepted, 2026-11-12. Spec [42](../specs/42-desktop-terminal.md). Builds on
[0440](0440-a-web-terminal-relayed-through-a-durable-object-per-job.md),
[0391](0391-the-client-door-desktop-devices-and-presence.md),
[0390](0390-the-desktop-app-is-the-daily-ui.md) and
[0400](0400-watch-and-steer-runs-from-the-dashboard.md).

## Context
The web terminal (ADR 0440) reaches a browser only through sf-app: its socket route checks the
session cookie and a same-origin `Origin`, runs `run.terminal.attach` through the service binding and
proxies the relay's viewer socket, which isn't on sf-engine's public hostname. The desktop app has no
cookie and talks only to the client door on sf-engine, so its Open terminal could only show the tmux
command to run on the runner's Mac. The owner wants the button to open the terminal.

## Decision
1. **The door gains one streaming route**, `GET /client/v1/terminal/<workItemId>/<runId>` (a WebSocket
   upgrade), beside `live`. It is the same path as sf-app's: authenticate (here the bearer token,
   desktop kind only), `run.terminal.attach` as the person on the `desktop` surface with the device id,
   a one-use viewer ticket from the job's relay, and the relay's viewer socket handed back as the
   upgrade. The attach is shared code (`terminal-attach.ts`), so the two doors can't drift. Who may
   type stays in the operation and the relay (ADR 0440 §4): nothing about the desktop changes it.
2. **The token stays in the main process.** Bun's WebSocket sends the token in `Authorization`, as the
   live socket does (spec 40 M2b). The view gets the stream over the RPC (open, send, close, and
   events with output as base64), never a URL, a ticket or the token.
3. **The terminal view is shared, not copied.** The framework-free client and the xterm.js view move to
   `packages/client`, which both apps already use. The view takes a `connect()` that returns a socket,
   so sf-app passes a browser WebSocket and the desktop passes the RPC's. `packages/client` holds its
   only React file because `packages/ui` can't depend on it (client already imports ui's types).
4. **Only desktop tokens.** A CLI token is refused (`forbidden`): the CLI has no terminal view, and a
   read-scoped token must not open a `write`-risk attach.

## Consequences
- Each open desktop terminal is one more socket from the main process to sf-engine; the main process
  caps them at four and closes them on sign-out.
- A refused attach comes back as an HTTP status before the upgrade, which a WebSocket client can't
  read, so the view asks `run.live` first and shows its `terminal.reason` in one line; a failed upgrade
  after that shows a generic line.
- The relay journals the close with `run.terminal.detach` on the `app` surface whichever door opened
  it; the attach's own audit row records `desktop` and the device.
