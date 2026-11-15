# Architecture

What the parts are and how a request moves through them. Words are in
[`CONTEXT.md`](../CONTEXT.md); the decision is [ADR 0660](adr/0660-the-core-is-a-small-workflow-engine-with-plugins.md).

## The parts

```
 desktop app ──┐ client door /client/v1                       website (sf-app): sign-in only
 sf CLI ───────┤ cli door    /cli/v1                               │ EngineApi RPC
               ▼                                                   ▼
 ┌──────────────────────────── sf-engine (Worker) ─────────────────────────────────┐
 │  flow.* ──► packages/ops ──► packages/plugins ──► packages/flow (apply)          │
 │                │                 │  hooks in Dynamic Workers (LOADER)           │
 │                │                 │  ctx.gateway(name) ──► outside systems       │
 │                ▼                 ▼                                              │
 │           packages/store ──► D1 software-factory (flow_* and core_*)            │
 │  other ops ──► packages/core invoke() (sign-in, orgs, devices, runners, GitHub)  │
 │  /flow/mcp (factory MCP server)    /flow/triggers/…    minute cron              │
 │  /runner/v1/* runner channel: heartbeat, claim, token, events, handback, release │
 └────────────────────────────────────────▲────────────────────────────────────────┘
                                          │ signed, outbound from the runner
                     runner host (sf-runner) ──► harness-claude ──► Claude Code
```

| Part | Where | What it does |
| --- | --- | --- |
| Kernel | `packages/flow` | The model (zod) and `apply(workflow, state, event)`: an item's next state and the effects to carry out. Pure: no D1, no Cloudflare. |
| Store | `packages/store` | The `flow_*` tables: items and their timeline, runs and leases, plugins, gateways, chats, schedules. One step of an item is one D1 batch. |
| Operations | `packages/ops` | The `flow.*` operations: zod input, a handler, `read` or `write`. The one permission rule: the caller is a member of the org and everything named is in it. |
| Plugin host | `packages/plugins` | Loads plugins as Dynamic Workers, runs their hooks around every item event, serves their `ctx`, makes gateway calls. |
| Platform | `packages/core` | What the workflow engine stands on: sign-in, orgs, the doors' tokens and devices, runners, the GitHub App connection. Its operations go through `invoke()` and the audit journal. |
| Engine | `apps/engine` (`sf-engine`) | Routes, the runner channel, the MCP server, triggers, the cron. |
| Website | `apps/app` (`sf-app`) | GitHub sign-in, the pages that approve device logins, and the GitHub App's Setup URL. Nothing else. |
| Desktop app | `apps/desktop` | The daily app (macOS): the org strip, sidebar, boards, items, Chat, Team, Auto, Plugins, Settings. It also runs this Mac's runner. |
| CLI | `local/cli` (`sf`) | `sf login`, `sf ops`, `sf call <op> <json>`. |
| Runner | `local/runner-host`, `packages/runner-local`, `packages/harness-claude`, `packages/runner-contract` | Claims runs and runs Claude Code on the owner's machine. |

## A request
1. The desktop app calls `flow.item.move` through the client door with its token. The engine finds
   the person behind the token and hands any `flow.` call to `call()` in `packages/ops`; other calls
   go to `invoke()` in `packages/core`.
2. `call()` validates the input and checks scope (`packages/ops/src/scope.ts`), then runs the
   handler.
3. Every item event goes through one function in `packages/plugins/src/steps.ts`: the plugins'
   `leaving` hooks if the item would leave its status (worked out with the pure kernel first), then
   the event through `packages/store` (`apply()`, then the new state, the timeline entries and the
   effects in one batch), then `runEnded` and `entered`, then any moves the plugins asked for, the
   same way.
4. An effect `run.start` queues a run for the status's agent; `inbox.add` and `decision.ask` show
   the item in the inbox. A plugin that throws, times out (10 s) or answers wrongly stops the item
   with `Plugin "<name>" failed: …`; `flow.item.retry` runs the status again.

## Plugins and gateways
A plugin is one ES module in `flow_plugins`, loaded through the Worker Loader binding with no
network of its own (`globalOutbound: null`) and an empty `env`. Its `ctx` (comment, card, setField,
move, createItem, gateway, item) runs back in the engine. Outside systems are reached only through
`ctx.gateway(name).fetch(path, init)`: the engine joins the gateway's base URL and the path, adds the
decrypted secret as a bearer token or a named header, and makes the request. The built-in `github`
gateway calls the GitHub REST API for the item's project's repository with a one-repository App
token. A plugin's `trigger` hook runs from `POST /flow/triggers/<pluginId>/<name>?key=<key>`.

Gateways will be rebuilt as one Worker per outside service with typed methods and an OAuth sign-in
([spec 70, "Next"](specs/70-a-new-core.md#next-gateways-in-the-gatekeeper-shape)).

## Runs and the runner channel
The runner host calls the engine; the engine never calls it. Every call is signed with the runner's
key (`/runner/v1/*`).
- **Heartbeat**, about every 20 s: the runner's manifest and capacity, and the runs it holds with
  their fencing tokens. It renews each run's 10-minute lease and answers cancel commands and the
  version the runner should update to.
- **Claim**: the oldest queued run the runner may serve (of items and chats its owner created, or of
  any in an org it is shared into), given a lease and a fencing token, as a `flow` job whose id is
  the run's (`frun_…`).
- **Token** (only with a repository): a fresh one-repository GitHub App token that may push the
  item's branch. Never cached.
- **Events**: what the session did (the agent's text, tool calls, tool results in stream-json mode),
  stored as the run's steps for the run view.
- **Handback**: `{ outcome: "done" | "rejected", summary }`, plus the branch and head if it pushed.
  An item's run steps the item (with `runEnded` and `entered`); a chat's run adds the reply.
- **Release** ends the job; a release with the run still open fails it. The cron fails runs whose
  lease lapsed.

**Without a repository** the runner host gives the session an empty directory, removed on release.
**With one** (a project with a repository) it makes a git worktree of the owner's checkout on the
item's branch `factory/flow-<key>-<number>`, and after the session commits what is left and pushes
that branch. The software plugin then opens the pull request.

## Chat
A chat is with a model the person picks. Each message queues a run with no item, which a runner
claims like any other. Its prompt (`apps/engine/src/flow/chat-prompt.ts`) is a short fixed text,
the conversation so far and the new message; it always gets the `factory` MCP server, acting as the
chat's creator. The reply is the run's summary. Each change the run makes through the MCP server is
recorded so the chat can show what it made.

## The MCP server
`POST /flow/mcp`, streamable HTTP, named `factory`. A claimed run whose agent has `"factory"` in
its `mcp` (and every chat run) gets a bearer token valid while the run is claimed. Tools:
`flow_ops`, `flow_call` (any `flow.*` operation, as the run's agent in its org), `plugin_guide`,
`plugin_list`, `plugin_read`, `plugin_save`, `plugin_delete`, `gateway_list`.

## The cron
Every minute (`apps/engine/src/index.ts`): outbox retries, runs whose lease lapsed (10 a tick),
run events past retention, due schedules (20 a tick), and the channel store's prune. Hourly:
expired device codes and GitHub connect states.

## D1 tables
One database, `software-factory`; migrations in `packages/db/migrations`.

| Group | Tables | Retention |
| --- | --- | --- |
| Workflows | `flow_workflows`, `flow_projects`, `flow_agents` | Kept while the org uses them; nothing deletes one yet. |
| Items | `flow_items`, `flow_events` (the timeline) | Kept as the org's record of its work; nothing prunes them yet. |
| Runs | `flow_runs` | Kept with its item or chat; nothing prunes runs yet. |
| | `flow_run_events` | Deleted 30 days after the run finished, by the minute cron (`pruneRunEvents`). |
| Plugins and gateways | `flow_plugins`, `flow_gateways` | Kept until `flow.plugin.delete` / `flow.gateway.delete`. |
| Chat | `flow_chats`, `flow_chat_messages` | Kept until `flow.chat.delete`. |
| Schedules | `flow_schedules` | Kept until `flow.schedule.delete`. |
| Sign-in and orgs | `core_user`, `core_session`, `core_account`, `core_verification`, `core_organization`, `core_member`, `core_invitation` | Better Auth's own. |
| Doors and devices | `core_cli_tokens`, `core_desktop_devices` | Kept (a revoke marks the row). |
| | `core_desktop_auth_requests`, `core_presence_challenges`, `core_mobile_nonces`, `core_pair_offers` | Deleted a day past expiry, every minute. |
| | `core_pair_code_tries` | Deleted after a day, every minute. |
| | `core_cli_device_codes` | Deleted a day past expiry, hourly. |
| Runners | `core_runners`, `core_runner_shares` | Kept. |
| | `core_runner_device_codes` | Deleted a day past expiry, hourly. |
| | `core_channel_requests` (the channel's idempotency store) | Deleted after a day. |
| GitHub | `core_github_installations` | Kept; the App's webhook keeps it current. |
| | `core_github_connect_states` | Deleted a day past expiry, hourly. |
| Platform | `core_audit` | Append-only, kept; written only when a platform operation changes state. |
| | `core_outbox` | A row is deleted once delivered. |
| | `core_batch_guard` | Empty after every batch. |
| | `core_meta` | One row: the schema version. |

## Bindings
| Worker | Binding | For |
| --- | --- | --- |
| `sf-engine` | `DB` (D1 `software-factory`) | Everything; applies the migrations. |
| | `LOADER` (Worker Loader) | Plugins as Dynamic Workers. |
| | `CLIENT_HUB` (Durable Object `ClientHub`) | One per person: the desktop app's live socket. |
| | `MOBILE_NONCE_LIMIT` (rate limit) | The phone sign-in's unsigned nonce call. |
| | cron `* * * * *` | The minute cron above. |
| `sf-app` | `DB` | Better Auth's tables. |
| | `ENGINE` (service `sf-engine`, entrypoint `EngineApi`) | Every operation the website calls. |

Secrets and vars are listed in [`deploying.md`](deploying.md).
