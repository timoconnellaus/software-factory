# ADR 0056: Runners connect by device login

Status: accepted, 2026-11-11 (onboarding, branch `onboarding-connect-github`). Builds on
[ADR 0016](0016-signed-runner-channel.md) and [ADR 0100](0100-runner-contract.md).

## Context
Pairing a runner meant registering it in Setup, copying a runner id and a key shown once, and piping
the key to `sf-runner pair --key-stdin`. Incident 3 of
[2026-11-11-bootstrap](../incidents/2026-11-11-bootstrap.md) was that copy going wrong. The OAuth
device flow (`gh auth login`, `wrangler login`) is the familiar shape.

## Decision
- `sf-runner login` posts to `POST /runner/v1/device/start { name? }` (unsigned) and gets a
  **device code** (its secret), a **user code** (`XXXX-XXXX`, no vowels or look-alikes), the
  approval link (`/runners/connect?code=…` on the app), an expiry (10 minutes) and a poll interval
  (5 s). It prints the code and link (and opens the link on macOS), then polls
  `POST /runner/v1/device/poll { deviceCode }`.
- A person opens the link, signed in, checks the code matches their terminal, names the runner and
  approves (`runner.approveDevice`, human only). That registers a runner they own. Deny is
  `runner.denyDevice`.
- The next poll gets `approved` with the runner id and its channel key, **once**: the code becomes
  `consumed` in the same batch (a guard makes a concurrent second poll fail), later polls get
  `expired`. Pending codes past their expiry can't be approved. A code another person already
  decided is refused; `runner.deviceLookup` shows the runner only to whoever decided it.
- The device code is stored only as its SHA-256; the key is never stored (it is derived from
  `RUNNER_CHANNEL_SECRET`, ADR 0016) and is redacted from audit rows, as are device codes.
- The unsigned calls run as `{ type: "runner", id: "device-login" }` (`DEVICE_LOGIN_ACTOR`), which
  no signed runner can be (runner ids are `r_…`); both operations refuse any other actor.
- The CLI saves `runner.json` (0600 in a 0700 directory), proves the key with one signed heartbeat,
  and runs `install` (Node ≥ 24 is checked before asking for a code, and the absolute Node path is
  pinned, incident 4). `pair --key-stdin` stays as a fallback, behind "Pair with a key instead" in
  Setup.

## Consequences
- Nothing about a runner is copied by hand; the Setup checklist's runner step is one command.
- The start endpoint is unauthenticated and writes a row per call. No rate limit yet: open question
  (Cloudflare's rate limiting binding is the likely answer).
- Each poll writes an audit row (at most ~120 per login).
