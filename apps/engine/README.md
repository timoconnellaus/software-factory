# @software-factory/engine → Worker `sf-engine`

- **Operations** (ADR 0051): every operation runs here. `sf-app` calls the `EngineApi` RPC
  entrypoint through a service binding: `invoke(name, input, { actor, origin, idempotencyKey? })`
  → `{ ok: true, result } | { ok: false, error }`, and `describeOperations()`.
- **Work-item Workflow** (`src/workflow/work-item.ts`, ADR 0110, 0053): triage → (spec gate) →
  build → verify → merge gate, with send-back loops, kill-switch parking and versioned step names.
- **Runner channel** (`/runner/v1/*`, ADR 0016, 0100, 0052): signed, idempotent (D1 store), each
  call one operation as the runner.
- **TerminalRelay** (`src/terminal-relay.ts`, spec 35, ADR 0440): one Durable Object per job
  relaying its web terminal over hibernatable WebSockets. The runner host connects to
  `/terminal/v1/jobs/<id>/host` with a one-use ticket from the channel's held `terminal` call;
  viewers reach `/terminal/v1/jobs/<id>/view` only through the binding (`EngineApi.terminalAttach`
  runs `run.terminal.attach`, then `EngineApi.fetch` opens the socket). Keys and resizes are
  forwarded only from the runner's owner; at most 8 viewers.
- **GitHub App** (`src/github/app.ts`): job tokens and the control plane's branch/PR/merge calls.
- **Cron** (every minute): outbox retries, failing runs whose lease lapsed, pruning the channel store.

Config: D1 `software-factory` (migrations from `packages/db`), Workflow `sf-work-item`, vars
`GH_APP_ID`, `FACTORY_FLOOR`, `GITHUB_FAKE` (tests/local only), secrets `RUNNER_CHANNEL_SECRET` and
`GH_APP_PRIVATE_KEY` (synced by the deploy workflow). Public host: `sf-engine.zerobsai.com` (the
runner channel, the runner host's web terminal socket and `/health` only).

Local: `pnpm dev` applies migrations to the local D1 and runs `wrangler dev`; set `GITHUB_FAKE=1`
and `RUNNER_CHANNEL_SECRET` in `.dev.vars` to run without the App.
