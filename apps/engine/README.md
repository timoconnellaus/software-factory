# @software-factory/engine → Worker `sf-engine`

- **Operations** (ADR 0051): every operation runs here. `sf-app` calls the `EngineApi` RPC
  entrypoint through a service binding: `invoke(name, input, { actor, origin, idempotencyKey? })`
  → `{ ok: true, result } | { ok: false, error }`, and `describeOperations()`.
- **Work-item Workflow** (`src/workflow/work-item.ts`, ADR 0110, 0053): triage → (spec gate) →
  build → verify → merge gate, with send-back loops, kill-switch parking and versioned step names.
- **Runner channel** (`/runner/v1/*`, ADR 0016, 0100, 0052): signed, idempotent (D1 store), each
  call one operation as the runner.
- **GitHub App** (`src/github/app.ts`): job tokens and the control plane's branch/PR/merge calls.
- **Cron** (every minute): outbox retries, failing runs whose lease lapsed, pruning the channel store.

Config: D1 `software-factory` (migrations from `packages/db`), Workflow `sf-work-item`, vars
`GH_APP_ID`, `FACTORY_FLOOR`, `GITHUB_FAKE` (tests/local only), secrets `RUNNER_CHANNEL_SECRET` and
`GH_APP_PRIVATE_KEY` (synced by the deploy workflow). Public host: `sf-engine.zerobsai.com` (the
runner channel and `/health` only).

Local: `pnpm dev` applies migrations to the local D1 and runs `wrangler dev`; set `GITHUB_FAKE=1`
and `RUNNER_CHANNEL_SECRET` in `.dev.vars` to run without the App.
