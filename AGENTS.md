# AGENTS.md

A small workflow app: an org defines workflows as lists of statuses, each owned by an agent, a
person or nobody, and items move through them on a board. Agents run on the owner's own machines
(runners) and plugins, built by an agent from plain words, add what the base can't do. The cloud
half runs on Cloudflare; the daily app is a macOS desktop app.

## Start here
- [`docs/architecture.md`](docs/architecture.md): the parts and how a request flows.
- [`CONTEXT.md`](CONTEXT.md): the words. Use them.
- [ADR 0660](docs/adr/0660-the-core-is-a-small-workflow-engine-with-plugins.md) and
  [spec 70](docs/specs/70-a-new-core.md): why the core is what it is, and what was built.
- [`docs/design/base-and-plugins.md`](docs/design/base-and-plugins.md): the base, plugins and
  gateways in plain words.
- [`docs/handoff.md`](docs/handoff.md): where things stand and what is next.

ADRs before 0660 and specs before 70 describe the old software factory, deleted on 2026-11-15.
They are history, not a description of the code.

## Working rules

**Keep it simple.** Build what the owner asked for and nothing around it: no limits, grants,
approvals, roles or policy machinery, and no handling of edge cases nobody has hit. The first
version of this project failed by designing for edge cases first and grew too big to change.

**The base knows nothing about any kind of work.** `packages/flow`, `packages/store`,
`packages/ops` and `packages/plugins` name no status, no service and no kind of work. The guard
`scripts/checks/guards.test.ts` fails if any of them imports `packages/core`, or if any of them or
`apps/engine/src/flow` has a source file over 400 lines. Split a file before it gets there.

**Base, plugin or gateway.** If every kind of work needs it (items, statuses, owners, runs, the
timeline, the inbox, schedules), it is the base. If only some kinds of work need it, it is a
plugin. If it is a connection to an outside system, it is a gateway. Pull requests are a plugin
(`plugins/software/plugin.js`), not base code.

**Plugins are edited through the MCP server, and a save is live at once.** A plugin is one ES
module stored in D1 and run as a Dynamic Worker. An agent changes plugins through the engine's
`factory` MCP server; Chat always has it. A save takes effect for the whole org on the next event.
A plugin that fails stops the item with its error, and the item can be retried.

**Model credentials stay on the runner.** The cloud holds no model key or subscription and never
calls a model. So every agent's turn, a chat reply included, is a run claimed by a runner its owner
connected, and nothing happens while no runner is online. Code names Claude Code aliases (`opus`,
`sonnet`, `haiku`, `fable`) from `packages/ops/src/models.ts`, never a model id; the guard checks.

**Runners are adapters.** The engine knows the runner contract (`packages/runner-contract`), not
any runner. `packages/core`, `packages/db`, `packages/runner-contract` and `apps/*` never import a
runner adapter; the guard checks.

**The app and the server keep one contract, checked by tests.** Every `flow.*` operation the
desktop app calls is typed in `packages/client/src/flow*.ts` and listed in
`packages/client/src/flow-contract.ts` (`FLOW_RESPONSES`, `FLOW_REQUESTS`), with an answer in the
desktop's fixture door (`apps/desktop/screenshots/fixtures.ts`). Three tests hold it:
`packages/client/test/flow-contract.test.ts` (each operation exists and each input parses),
`apps/engine/test/flow-contract.test.ts` (each real answer parses) and
`apps/desktop/test/flow-fixtures-contract.test.ts` (each fixture answer parses). A new operation the
app calls goes in all three places.

**Every feature lives in the desktop app.** The website (`apps/app`) is sign-in and the pages
device logins and the GitHub connection need, nothing else.

**A significant decision gets a short ADR** (`docs/adr/NNNN-title.md`, the next number after the
highest). When a decision changes, add a dated note to the old ADR; never delete one. Keep
`docs/architecture.md` and `CONTEXT.md` true when you change what they describe.

**Migrations** are numbered one at a time: the next number above the highest in
`packages/db/migrations`, and `SCHEMA_VERSION` in `packages/db/src/index.ts` equals it. If `main`
took your number before you merge, renumber yours.

**One shared Mac.** Run the tests you touched, cap concurrency (`pnpm test --concurrency=2`), use
your own port for a dev server, and never stop a process you didn't start. Files that conflict
often: the op maps and contract lists above, `SCHEMA_VERSION`, the screenshot fixtures in
`apps/desktop/screenshots/`, and `pnpm-lock.yaml` (run `pnpm i` after merging).

## Cloudflare cost
D1 bills every row a query reads and every row (and index entry) a write touches, deletes included;
a database stops taking writes at 10 GB. A Durable Object is billed for every second it is awake.
Each rule is checkable in review. Code comments cite them by number, so keep the numbers.
1. A query on a poll, heartbeat, claim, cron or socket path has its `EXPLAIN QUERY PLAN` checked
   against the migrated schema: no SCAN of a growing table, and no temp B-tree sort in a query that
   reads one unless `SORT_ALLOWED` in `apps/engine/test/query-plans.ts` says why the sorted rows are
   few. Register a new hot path as a scenario in `HOT_PATHS` in
   `apps/engine/test/query-plans.test.ts`.
2. Cron and polled queries filter on the leading columns of an index, and that index covers their
   `ORDER BY`. A growing table's query has a LIMIT; no `COUNT(*)` or `OFFSET` paging on one. A capped
   list says so (`truncated`).
3. Every new table states its retention in its migration and gets a bounded prune in the minute
   cron (`apps/engine/src/index.ts`), or says why it is kept.
4. Every index names, in its migration, the query that reads it. Drop an index nothing reads.
5. A Durable Object never holds a request, `setTimeout` or `setInterval` to wait. Use hibernatable
   WebSockets (`acceptWebSocket`) or alarms, and stop re-arming an alarm when there is nothing to do.
   The one Durable Object is `ClientHub` (`apps/engine/src/client-hub.ts`).
6. Every Durable Object that accepts sockets sets `setWebSocketAutoResponse` for its ping.
7. One cron tick or request makes at most about 200 D1 queries (the cap is 1,000). Check rows in
   batches with `json_each(?)`, and carry a cursor between ticks for anything unbounded.
8. No D1 query inside a loop over another query's rows unless the loop is bounded to 10 or fewer;
   join instead.
9. The runner channel's idempotency store (`core_channel_requests`) is only for calls that aren't
   naturally idempotent. A call left out of it (`isUnstoredPath` in
   `packages/runner-contract/src/protocol.ts`: heartbeat, claim, token) must be harmless to replay.
10. Expensive clients (the GitHub App, imported keys) are built once per isolate, not per call.
11. Each wrangler config sets `observability.head_sampling_rate` and `limits.cpu_ms`, with the
    reason for the value beside it.
12. Machine-frequency platform operations (heartbeat, claim, device-login polls) write no audit row
    unless state changed (`audit: { changesOnly }`, ADR 0590), and a runner's audit `input` is its
    digest. `flow.*` operations and a run's events write no audit row.

## Tooling
- pnpm, Turborepo, Node 24 (`.nvmrc`). On the shared Mac, put
  `$HOME/.nvm/versions/node/v24.21.0/bin` first on `PATH`.
- Before pushing: `pnpm lint`, `pnpm typecheck`, `pnpm test --concurrency=2` (or the packages you
  touched, `pnpm --filter <package> test`), and `node --test "scripts/*/*.test.ts"`.
- Biome formats and lints (`pnpm format` fixes). Don't add ESLint or Prettier.
- The UI is shadcn/ui from `packages/ui`. Use its components, not native `<select>`,
  `<input type="checkbox">`, `<details>` or hand-styled buttons; add a missing one there.
- Tests run in workerd via `@cloudflare/vitest-plugin`, except where they drive the machine or the
  window: `local/*`, `packages/runner-local`, `packages/harness-claude` and `apps/desktop` run on
  Node. Prefer integration tests against real bindings over mocks.
- To see the desktop app's screens with real data, `node apps/desktop/screenshots/live.mjs shots`
  (or `run <script>`): read-only unless `--write`, images outside the repo (`apps/desktop/README.md`).
- TypeScript strict. No `any` without a comment saying why.
- Generate Worker `Env` types with `pnpm types` (`wrangler types`). Don't hand-write them.
- `spikes/` is outside the workspace and Biome. Spikes are throwaway.

## Git
- Work on a branch and open a pull request against `main`. Merge commits only; never rebase or
  force-push.
- Merge your own pull request once CI (`ci`) is green. A merge to `main` deploys; nobody else uses
  the system yet, so that is fine.
- The repo is public. Never commit secrets, account ids or `.dev.vars`.
