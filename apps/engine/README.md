# @software-factory/engine → Worker `sf-engine`

- **Operations** (ADR 0051): the platform's operations (`packages/core`) run here. `sf-app` calls
  the `EngineApi` RPC entrypoint through a service binding: `invoke(name, input, { actor, origin,
  idempotencyKey? })` → `{ ok: true, result } | { ok: false, error }`, and `describeOperations()`.
- **The client door** (`/client/v1/*` for the desktop app, `/cli/v1/*` for `sf`; `src/cli.ts`): the
  device logins, a call or a batch of reads as the person behind the token (the platform's
  operations, or the new core's `flow.*` through `packages/ops`), presence proofs, the version
  handshake, and the live socket held by the person's `ClientHub` Durable Object.
- **The new core** (`src/flow/*`, spec 70): flow runs on the runner channel (claim, heartbeat,
  token, events, hand-back, release), the MCP server a run's agent uses (`/flow/mcp`), and plugins'
  triggers (`/flow/triggers/<plugin>/<name>`).
- **Runner channel** (`/runner/v1/*`, ADR 0016, 0100, 0052): signed, idempotent (D1 store). The
  heartbeat and claim report the runner's state (`runner.heartbeat`, `runner.claim`); every job is
  a flow run.
- **GitHub webhook** (`/webhooks/github`, `src/webhooks.ts`): the App's installation events keep
  the org's installation record current.
- **GitHub App** (`src/github/app.ts`): installation lookups, the repositories an installation
  reaches, a branch's head, and one-repository installation tokens.
- **Cron** (every minute): outbox retries, the new core's lapsed runs, schedules and run-event
  prune, the channel store's prune; hourly, expired device codes and connect states.

Config: D1 `software-factory` (migrations from `packages/db`), the Worker Loader `LOADER`, vars
`GH_APP_ID`, `GH_APP_SLUG`, `GITHUB_FAKE` (tests/local only), secrets `RUNNER_CHANNEL_SECRET`,
`GH_APP_PRIVATE_KEY`, `GH_APP_WEBHOOK_SECRET` and `FLOW_GATEWAY_KEY` (synced by the deploy
workflow). Public host: `sf-engine.zerobsai.com` (the runner channel, the client door, the MCP
server, plugin triggers and `/health`).

Local: `pnpm dev` applies migrations to the local D1 and runs `wrangler dev`; set `GITHUB_FAKE=1`
and `RUNNER_CHANNEL_SECRET` in `.dev.vars` to run without the App.
