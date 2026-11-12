# Spec 42: Open terminal opens the session's terminal in the desktop app

**Read first**: spec [35](35-web-terminal.md) and [ADR 0440](../adr/0440-a-web-terminal-relayed-through-a-durable-object-per-job.md)
(the web terminal and its relay), spec [40](40-desktop-app.md) and ADRs
[0390](../adr/0390-the-desktop-app-is-the-daily-ui.md), [0391](../adr/0391-the-client-door-desktop-devices-and-presence.md)
(the desktop app and its client door), spec [41](41-desktop-shell-and-look.md) (Open terminal's place,
later slice 8), [ADR 0400](../adr/0400-watch-and-steer-runs-from-the-dashboard.md) (who may type), and
[ADR 0530](../adr/0530-the-client-door-carries-the-web-terminal.md).

## Goal
In the desktop app, pressing **Open terminal** on a work item opens that session's live terminal
inside the app: build, verify, triage and planning sessions alike. No command to copy. The runner's
owner types (which takes the session over, as typing in a `tmux attach` does); everyone else watches.

## Scope
- **The door** (`sf-engine`, `apps/engine/src/cli.ts`): `GET /client/v1/terminal/<workItemId>/<runId>`
  (WebSocket upgrade), for a **desktop** token only. It authenticates the bearer token like every door
  call, then does exactly what sf-app's socket route does (spec 35): `run.terminal.attach` as the
  person on the `desktop` surface (with the device id, so the audit row names the device), a viewer
  ticket from the job's TerminalRelay, and the relay's viewer socket, returned as the upgrade. A
  refusal answers the operation's status and `{ error, code }` (as `call` does), before any upgrade.
  The attach logic moves out of `EngineApi.terminalAttach` into `terminal-attach.ts`, which both use.
  `/cli/v1` (the CLI) refuses it: the CLI's terminal is out of scope (spec 35).
- **The main process** (`apps/desktop/src/bun/terminal.ts`): opens that socket with the token in the
  `Authorization` header (as `live.ts` does; the token never reaches the view or a URL) and relays it
  over the RPC: the view asks `terminalOpen { workItemId, runId }` (ids checked against their
  patterns) and gets a handle; `terminalSend { id, data }` sends one text frame (capped at the relay's
  input size plus framing); `terminalClose { id }` closes it. The main process pushes
  `terminalEvent { id, kind: "open" | "text" | "bytes" | "close", … }` (binary frames as base64). At
  most four sockets at a time; signing out closes them all.
- **The shared terminal** (`packages/client`):
  - `web-terminal.ts`: the framework-free `TerminalClient` from sf-app (frames → writes and a status
    line, the owner's keys and size out), moved here unchanged; sf-app's `lib/web-terminal.ts`
    re-exports it.
  - `web-terminal-view.tsx`: the xterm.js view sf-app's Live tab used, now taking a `connect()` that
    returns a `ViewerSocket`. sf-app passes a browser WebSocket to its own route; the desktop passes a
    socket over the RPC. It follows the app's light or dark theme.
- **The desktop view**:
  - **Open terminal** shows whenever the work item (or, on the Plan tab, its planning session) has a
    live run. Pressing it opens the terminal **in place**: a panel over the lower part of the page
    (the item's page area; the whole window below the session bar in planning focus), resizable by
    its top edge, with **Expand** to fill the window and **Close**. Esc or the button closes it; the
    session keeps running.
  - The status line says plainly who may type: "You can type: typing takes the session over" for the
    runner's owner, "Watching read-only: only the runner's owner can type" for everyone else.
  - **Fallback**: only when the terminal can't be reached, one line saying why (`run.live`'s
    `terminal.reason`: the run ended, or the runner can't share its terminal; or the runner hasn't
    connected within 20 s: it may be offline), and a small **Attach from a terminal instead** link that
    shows the takeover hint (the tmux command) with Copy.
  - The component (`TerminalPanel`) is self-contained, so the item side panel (spec 41's later
    slices) can host it unchanged.

## Out of scope
- The item side panel itself, and the Live tab's transcript in the desktop (spec 41 slice 7).
- Letting someone other than the runner's owner type (ADR 0400, 0440 stand).
- The CLI's terminal.

## Acceptance criteria
1. On a running session, its runner's owner presses Open terminal in the desktop app and sees the live
   screen within a few seconds, types into it, and the pane follows the panel's size.
2. Another member sees the same screen read-only; the relay still enforces it (the desktop sends no
   input for a watcher, and a watch socket that sends input is closed with 1008).
3. The door's socket runs `run.terminal.attach` as the token's person on the `desktop` surface with the
   device id; a missing or revoked token is refused `401` before any upgrade; a CLI token is refused
   `403`; an ended run is `409`, a runner without `terminal` `503`, someone outside the org `403` or `404` (as `call` answers
   for them).
4. The token never reaches the view: the RPC's terminal messages carry no token field (the RPC test
   checks), and the token is sent only in the socket's `Authorization` header.
5. The terminal opens in place, resizes, expands to the window, and closes with Esc or the button
   without stopping the session.
6. When the terminal can't be reached, one line says why and the tmux command is behind "Attach from a
   terminal instead".
7. `pnpm lint`, `pnpm typecheck` and the touched packages' tests pass.

## As built
- **Esc** closes the terminal, except while the keyboard is in a terminal you can type into. There
  Esc goes to the session, because it is Claude Code's interrupt. Click outside the terminal, or use
  Close. A watcher's Esc always closes it. The dock's handler runs first, in the capture phase, so
  Esc in planning focus closes the terminal before it leaves focus.
- **Where it opens**: over the lower 45% of the page area (`#main`), and in planning focus between
  the session bar and the status bar. It is resizable by its top edge. Expand fills the window,
  leaving the status bar.
- **A bug fixed in runner-local's bridge** (`packages/runner-local/src/terminal.ts`): a redraw sends
  `capture-pane …; display-message …` as one command line, and tmux answers it with two blocks. The
  bridge read only the first, so the cursor went to 1;1, and the second block answered the next
  command. Text typed after a redraw overwrote the top of the screen, on the website too. The
  bridge now waits for both blocks. The real-tmux test checks the cursor.
- **Screenshots** (`docs/screenshots/desktop-terminal/`) come from
  `node apps/desktop/screenshots/terminal.mjs`. It serves the real view with the fixture door, and
  its relay bridges a real tmux pane through runner-local's control-mode bridge. That pane is on
  its own `sf-shot` socket, never the factory's. Typing goes in through Chrome.
