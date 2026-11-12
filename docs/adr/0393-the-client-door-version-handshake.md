# ADR 0393: The client door's version handshake is a protocol number

Status: accepted, 2026-11-12. Spec [40](../specs/40-desktop-app.md) (M4).

## Context
The desktop app updates itself ([ADR 0390](0390-the-desktop-app-is-the-daily-ui.md)), but an
installed copy can lag: it was off, the person postponed *Restart to update*, or it runs from a
folder it can't replace itself in. The engine deploys on every merge, so a change to the client door
can reach an old app before the app catches up. Spec 40 asks for a handshake that can answer
`update_required`.

The app's own version isn't a good key: canary is `0.1.<run>` and stable is the tag, so the two
channels don't order against each other, and a local build is `0.0.1`.

## Decision
1. **The app names a door protocol, not its version.** Every request from the desktop app to
   `/client/v1` (the calls, the sign-in and the live socket) carries `x-sf-client: desktop` and
   `x-sf-client-protocol: <n>`. `n` is `DOOR_PROTOCOL` in `apps/desktop/src/bun/protocol.ts`, bumped
   in the change that makes the app depend on something new in the door. A request without the
   header is protocol 0 (builds from before the handshake).
2. **The engine keeps a floor.** `DESKTOP_MIN_PROTOCOL` (an sf-engine var in `wrangler.jsonc`,
   empty = 0 = serve every build) is the oldest protocol the door still serves. A desktop sign-in or a
   desktop token's request below it gets **426** `{ code: "update_required", minProtocol }`, before
   anything runs. CLI tokens are not checked: the CLI ships with the repo. The check is in **one
   place**, `versionGate` at the top of `handleCli` (`apps/engine/src/cli.ts`), before any route:
   every route and socket a desktop token reaches gets it, including ones added later (the terminal
   socket, spec 42). A WebSocket client must send the protocol headers on its upgrade request.
   A floor above `DESKTOP_PROTOCOL_LATEST` (the newest protocol the engine knows, bumped with
   `DOOR_PROTOCOL`) is a mistake that would refuse every build, sign-in included, so it is ignored
   and logged, not enforced.
3. **The app updates.** The door client throws `UpdateRequiredError`, which asks the updater to check
   now (at most once every 10 minutes, however many requests are refused), and the view shows an
   **Update required** screen in place of everything else, signed in or not: *Restart to update*
   when a verified update is staged (waiting for, or naming, the runner's jobs), otherwise the
   download link and *Try again*. The updater talks only to the download bucket, never the door,
   so a wrong floor can't stop an app from updating.
4. **Raising the floor is a deploy change made in a PR**, like the other engine vars, and is done only
   when older builds must stop. Keeping the door backward-compatible stays the default.

## Consequences
- An app too old to know the handshake (protocol 0) still gets a clear 426 message, and its updater
  still runs on its own 6-hour timer.
- Dev builds never update themselves, so a dev build below the floor stays refused until it's
  rebuilt; a local dev engine leaves the floor empty.
- The floor isn't a factory policy: it doesn't change what anyone may do, only which builds may ask.
- **Recovery from a wrong floor.** If `DESKTOP_MIN_PROTOCOL` is set above what shipped builds speak
  (but not above `DESKTOP_PROTOCOL_LATEST`, which is ignored), every such build, sign-in included,
  sees *Update required*. Fix it on the engine, not the app: set the var back to `""` in
  `apps/engine/wrangler.jsonc` and deploy (a PR, as usual), or, faster, roll sf-engine back to the
  previous version (`wrangler rollback` from `apps/engine`, or the dashboard's Deployments tab).
  The apps then recover with *Try again*; nothing on the Macs needs changing.
