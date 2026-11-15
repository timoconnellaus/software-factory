# Spec 70: A new core

Status: **being built.** Milestones 1 and 2 are built and were proved on the deployed engine and a real runner on 2026-11-15. Read [ADR 0660](../adr/0660-the-core-is-a-small-workflow-engine-with-plugins.md)
first. This spec is the plan; each milestone gets its own short spec when it starts.

## The goal
A person defines a workflow as a list of statuses with owners, and an item moves through it, with
agents and people each doing their part. Nothing in the core knows what kind of work it is.

## Words
- **Item**: a unit of work with a title, a body, a thread and one status.
- **Workflow**: an ordered list of statuses, defined by the org, chosen by a project.
- **Status**: a column on the board. It has an owner, a brief (for an agent), "when done, move to",
  "if rejected, send back to", and optionally "needs a person's decision".
- **Owner**: an agent, a person, or nobody.
- **Run**: one execution of an agent on an item, on a runner.
- **Plugin**: something the base can't do, built by an agent on request and live at once. It can
  add steps, reactions, rules, fields, card kinds, looks, screens and agent tools.
- **Gateway**: the org's connection to one outside system (Gmail, GitHub, Slack), set up once and
  used by plugins and agents by name.
- **Plugin editor**: the MCP server through which an agent changes plugins.
- **Card**: a rich entry in an item's timeline (a plan, a pull request, a chart, a document).

## The packages
Each has one job, and no source file is over 400 lines.

| Package | Job | Taken from |
| --- | --- | --- |
| `packages/flow` | The model (zod schemas) and the reconciler. Pure: no D1, no Cloudflare. | `core/src/stages/reconcile.ts`, `workflow.ts` |
| `packages/ops` | `defineOperation`, the registry, `invoke()`, permissions, audit. | `core/src/operation.ts`, `registry.ts`, `invoke.ts` (1,179 lines, to be split) |
| `packages/store` | D1 access for items, workflows, runs and the thread. New tables, prefix `flow_`. | `packages/db` |
| `packages/plugins` | Loading a plugin as a Dynamic Worker and calling it at each point it hooks into. | grokbot-headless `plugin-worker-host.ts` |
| `packages/plugin-editor` | The MCP server that lists, reads and writes plugins. | new |
| `packages/gateways` | An org's connections to outside systems, and the call a plugin or agent makes through one. | `connector-github`, `connector-webhook` |
| `apps/engine` | The Worker: routes, cron, the runner channel. Calls the packages above. | the runner channel and auth as they are |
| `plugins/software` | Pull requests, checks, merge, over the GitHub gateway. | `engine/src/github`, `core/src/verify` |

`packages/runner-contract`, `runner-local`, `harness-claude`, `local/runner-host`, `packages/ui`
and `apps/desktop` stay. The runner contract loses its fixed job stages: a job carries a brief and
the capabilities it needs.

## Milestones
Each ends with something that runs.

1. **An item moves through a workflow.** `flow`, `ops`, `store`. Operations for workflows, items
   and the thread. The reconciler assigns a person or queues a run on entering a status, and moves
   the item on done or rejected. Proof: a workflow "Draft → Review → Done", with an agent on Draft
   and a person on Review, runs end to end on a real runner, with no code that names either status.
2. **Plugins and gateways.** The Dynamic Worker host, the plugin editor, and one gateway. Proof:
   an agent with the plugin editor is asked in plain words for "when an item reaches Published,
   post it and put the link on the item", builds it, and it works on the next item; an agent
   without the plugin editor can't change it.
3. **The software plugin.** A pull-request panel, a check step, a merge action behind a person's
   decision. Proof: this repo's own work runs on the new core.
4. **The UI, redesigned.** New mockups first, then the desktop app's rail, sidebar, board, the item
   panel with its timeline of cards, and the run view, on the new operations.
5. **Cutover.** Move the data that matters, delete the old core, rewrite `AGENTS.md`, `CONTEXT.md`
   and `docs/architecture.md`.

### Milestone 1: as built (2026-11-15)
- `packages/flow`: the model and the reconciler. `packages/store`: the `flow_*` tables
  (migration 0430), the kernel's effects, runs with leases and fencing tokens; the board, inbox and
  timeline are capped (500, 100 per list, the newest 500) with a `truncated` flag.
- `packages/ops`: 22 operations, all `flow.*` (workflows, projects, agents, items, the board,
  timeline, inbox and runs). The one permission rule: the caller is a member of the org, and
  everything named is in it.
- `apps/engine`: a `flow.` call on the client door (`/client/v1/call`, `/cli/v1/call`, reads in
  `batch`) runs in `packages/ops` in the door's usual envelope, and `ops` lists them. On the
  runner channel a claim offers a queued flow run first (to a runner its creator owns, or one
  shared into its org, with a free light slot), as a `flow` job with no repository whose id is the
  run's (`frun_…`); its heartbeat renews the run's lease, its hand-back finishes or fails the run,
  and the minute cron fails runs whose lease lapsed.

To try it with the `sf` CLI (`sf login --write` first; `sf call <op> '<input-json>'`):

```sh
sf call org.list '{}'   # your org ids
sf call flow.agent.create '{"orgId":"<org>","name":"Writer","instructions":"Write short, plain posts."}'
sf call flow.workflow.create '{"orgId":"<org>","name":"Draft, review, done","statuses":[
  {"id":"draft","name":"Draft","owner":{"kind":"agent","agentId":"<agent>"},"brief":"Draft the post."},
  {"id":"review","name":"Review","owner":{"kind":"person","userId":"<you>"}},
  {"id":"done","name":"Done","owner":{"kind":"none"}}]}'
sf call flow.project.create '{"orgId":"<org>","name":"Blog","key":"BLG","workflowId":"<workflow>"}'
sf call flow.item.create '{"orgId":"<org>","projectId":"<project>","title":"Launch post","body":"Announce it."}'
# A runner of yours claims it and hands back; then:
sf call flow.inbox.get '{"orgId":"<org>"}'
sf call flow.item.finish '{"orgId":"<org>","itemId":"<item>","outcome":"done"}'
sf call flow.timeline.get '{"orgId":"<org>","itemId":"<item>"}'
```

`sf ops` lists every operation; `sf call` also takes the input as `@file` or `-` (stdin).

### Milestone 2: as built (2026-11-15, the cloud half)
- **Plugins as Dynamic Workers** ([`packages/plugins`](../../packages/plugins)). A plugin is one
  ES module in `flow_plugins` (migration 0431). The engine loads it through its Worker Loader
  binding (`LOADER`), keyed by its org and its code's hash, with `globalOutbound: null`; its `ctx`
  is an RpcTarget the host passes with each hook call. Hooks: `entered`, `leaving` (may refuse),
  `runEnded`, `trigger`. `ctx`: `comment`, `card`, `setField`, `move`, `createItem`,
  `gateway(name).fetch`, `item`. One function in front of every item event (the `flow.item.*`
  operations, a run's hand-back and failure, the lease sweep, plugins' own moves): `leaving` (from
  the pure kernel, before writing), the event, then `runEnded` and `entered`. A failure (throw,
  10-second timeout, bad return) records the plugin's `last_error` and stops the item with
  `Plugin "<name>" failed: <message>`; `flow.item.retry` runs the status, and its `entered` hooks,
  again.
- **Fields and cards.** `flow_items.fields`; what a plugin declares is read when it is saved, so
  `flow.board.get` and `flow.item.get` add `declaredFields` without loading a worker. `card` is a
  new timeline entry kind.
- **Gateways** (`flow_gateways`): a base URL, auth (`none`, `bearer`, or a named header) and a
  secret sealed with AES-GCM under the engine's `FLOW_GATEWAY_KEY`, never returned by a read.
- **Triggers.** `POST /flow/triggers/<pluginId>/<name>?key=<key>` runs that plugin's `on.trigger`
  with the JSON body (at most 256 KiB). The key is made when the plugin is first saved.
- **The engine's MCP server**, "factory", at `POST /flow/mcp` (streamable HTTP, JSON responses).
  A flow run whose agent has `"factory"` in `flow_agents.mcp` gets a bearer token when it is
  claimed (only its hash is stored, on the run), carried in the job's new optional `mcpServers`;
  it works while the run is claimed. Tools: `flow_ops`, `flow_call` (any `flow.*` operation as the
  run's agent, in its org), `plugin_guide`, `plugin_list`, `plugin_read`, `plugin_save` (refused
  with the load error unless the module loads), `plugin_delete`, `gateway_list`.
- **The runner side** (plain mode only; container and sprites refuse no-repo jobs): the harness writes a flow job's
  `mcpServers` as HTTP servers to `<runDir>/mcp.json` (0600, denied to Read, removed with the run dir
  on release), passes it with `--mcp-config` as a planning session's server is, and allows exactly
  `mcp__<name>__*` per named server. The token is in no settings file, launch record, argv or event.
- **Operations**: `flow.plugin.list | get | save | delete | setEnabled`,
  `flow.gateway.list | save | delete`, `flow.item.setField`; `flow.agent.create | update` take
  `mcp`. Deploying needs the Workers Paid plan (Dynamic Workers) and the `FLOW_GATEWAY_KEY` secret
  ([deploying.md](../deploying.md)).
- **Not built in this milestone**: a plugin's screens, tools it gives agents, and changes to an
  agent's brief; approval of edits, limits, versions, trying a change on one item first.

To try it with `sf call` (after milestone 1's setup above):

```sh
# A gateway to the blog (its secret is stored encrypted and never shown again).
sf call flow.gateway.save '{"orgId":"<org>","name":"blog","baseUrl":"https://blog.example/api",
  "auth":{"kind":"bearer"},"secret":"<token>"}'
# A plugin: when an item reaches Done, post it and put the link on the item.
sf call flow.plugin.save @plugin.json   # {"orgId":"<org>","name":"publish","request":"…","code":"export default { … }"}
sf call flow.plugin.list '{"orgId":"<org>"}'
sf call flow.item.move '{"orgId":"<org>","itemId":"<item>","to":"done"}'
sf call flow.timeline.get '{"orgId":"<org>","itemId":"<item>"}'   # the plugin's card
# Give an agent the engine's MCP server, so its runs can build workflows and plugins.
sf call flow.agent.update '{"orgId":"<org>","agentId":"<agent>","name":"Builder",
  "instructions":"Set up what the person asks for.","mcp":["factory"]}'
# A trigger: flow.plugin.get shows its triggerPath.
curl -X POST "https://sf-engine.zerobsai.com/flow/triggers/<pluginId>/email?key=<key>" -d '{"subject":"Help"}'
```

### Chat: as built (2026-11-15)
- **Tables** (migration 0433): `flow_chats` and `flow_chat_messages` (`person`, `agent`, `did`),
  kept as the chat's record until `flow.chat.delete`. `flow_runs` was rebuilt: a run has an
  `item_id` or a `chat_id`, never both. A chat run has `status_id` '', `stay` = the seq of the
  message it answers, and that message as its `brief`.
- **Operations**: `flow.chat.create | send | list | get | delete` and `flow.agent.ensureBuilder`
  (the org's agent with the `factory` server, or a new "Builder"). `create` refuses an agent
  without the Plugin editor; `send` is refused while the last run is queued or claimed. `get`
  answers the messages, `working`, and `made` (the workflows and plugins its `did` rows name).
- **A chat run** is claimed and handed back on the same channel path as an item's run. It differs
  in three places: its prompt (`flow/chat-prompt.ts`: what the app is, the conversation so far
  capped at 24,000 characters, the new message, and a summary that is the reply), its end
  (`endChatRun` in the store adds the agent's message; no item is stepped and no plugin hook runs),
  and the MCP server, which acts for the chat's creator and adds a `did` row for each successful
  change (`flow/did.ts`). A failed or lapsed run leaves a plain agent message; sending again retries.
- **The app**: Chat (`?chat=`), with recent chats in a switcher in the header, the conversation on
  the left and what it made on the right; it polls `flow.chat.get` every 3 seconds only while a run
  is in flight. The Plugins screen's "Say what you want the app to do…" starts a chat.

### Chat with a model: as built (2026-11-15, amends the above)
The owner: "chat should just be directly with a model … where I choose the model and effort". A
chat no longer talks to an agent.
- **Tables** (migration 0437): `flow_chats` gains `model` and `effort` (null: the runner's
  default) and its `agent_id` is nullable (rebuilt; chats from before keep theirs, unused).
  `flow_agents` gains `model` and `effort`. A chat run stores `agent_id` '' in `flow_runs`. Replies
  are still stored with role `agent`; the API calls them `assistant`, and a reply's `data` names
  the model that wrote it (`{ model }`).
- **Choices** (`packages/ops/src/models.ts`, the one place): Claude Code's own `--model` aliases
  (`opus`, `sonnet`, `haiku`, `fable`) and `--effort` levels (`low`, `medium`, `high`, `xhigh`,
  `max`), answered by `flow.chat.options` with labels and the defaults for a new chat. Aliases,
  never model ids.
- **Operations**: `flow.chat.create { text, model?, effort? }`, `flow.chat.send { chatId, text,
  model?, effort? }` (a model or effort sent is the chat's from that message on), `get` and `list`
  with both; `get` adds `workingRunId`, and `made` lists items and projects created in the chat
  besides the workflows, plugins, agents and gateways it changed. `flow.agent.ensureBuilder` and
  the Plugin-editor check are gone. `flow.agent.create | update` take `model` and `effort`.
- **The job**: a chat run always gets the `factory` MCP server; `harness.model` carries the alias
  and `harness.effort` (new, optional, flow jobs only) the level, the chat's or, for an item's run,
  its agent's. The harness passes `--model` and, for a flow job with a known level, `--effort`.
  Nothing chosen: neither flag, so the CLI's default.
- **The prompt** has no agent instructions: a short fixed text (a chat in the owner's workflow
  app; what the app is; act with the `factory` tools when asked or clearly wanted, say what it did,
  ask before anything large or destructive), the conversation, the message, and a footer whose
  summary is the reply in Markdown.
- **The app**: an ordinary assistant chat. Model and effort pickers beside the send button (the
  last choice is a new chat's default, kept per Mac); replies as Markdown under the model's name;
  the run's events read every 2 seconds while it works, shown as plain steps ("Creating an item in
  Notes", "Thinking…") that fold into "Did N things"; the side pane only once the chat made
  something. Team → an agent has Model and Effort pickers.

### Auto (schedules): as built (2026-11-15)
- A schedule (`flow_schedules`, migration 0435) makes an item in a project on a clock: every hour
  at a minute, every day, weekdays, or one day a week at a time, in one IANA time zone (the
  creator's, by default). The item goes through its project's workflow like any other, created as
  the schedule's creator with the plugins' `entered` hooks. Nothing else: no cron expressions, no
  run-only mode, no auto-pause, no webhooks (plugins have triggers).
- The minute cron fires at most 20 due schedules a tick (`flow_schedules_due_idx`), moving each
  `next_at` on with a conditional update before it makes the item, so two ticks can't both fire
  it and a broken one fails once a period. A failure is kept as `last_error`.
- Operations: `flow.schedule.list | save | delete | runNow`. The desktop app's Auto screen lists
  them; its Triggers tab lists each plugin that defines a trigger with a
  copyable URL (`flow.plugin.list` gives `triggerPath` for those).

### Milestone 4: the run view, as built (2026-11-15)
- **What is stored.** The channel's `events` call for a flow run now stores what the runner sends
  (`flow_run_events`, migration 0434), normalised to three kinds: `note` (the assistant's
  `message`), `tool` (name, a short label from its input, the input, its id when the session
  gives one) and `result` (a `tool.result`: output, isError). Logs, status changes, job states,
  the person's messages and the session's start and end are dropped. Each text is capped at 4,000
  characters, a label at 120, and a run at 2,000 events (the rest dropped, the run marked
  truncated). Keyed by the runner's own per-job seq: a replay stores nothing twice. One D1 batch
  per call, no audit row; accepted after the hand-back, since the host flushes its last then.
- **What the runner sends.** A tmux session (the default) sends the assistant's text and each
  tool call (from the PreToolUse hook), but no tool results and no usage, so its steps have no
  duration and its run no tokens. A stream-json session also sends `tool.result` and, per turn,
  token counts (input, output, cache read, cache write), which are summed into `flow_runs.tokens`.
  No runner sends cost: `cost_usd` is there and stays null. No runner sends thinking.
- **Retention.** A run's events are deleted 30 days after it finished, by the minute cron
  (`pruneRunEvents`: the oldest due run through `flow_runs_events_due_idx`, 500 rows a round, at
  most 4 rounds a tick). The run row and its totals are kept.
- **Operations.** `flow.run.get` adds the totals (durationMs, steps, tokens, costUsd), what started
  it (`startedBy`: "entering <status>"), agentName, runnerName, eventsTruncated, eventsRemoved, and
  doesn't assume the run has an item. `flow.run.events { runId, after? }` returns at most 500
  events after a seq, with `truncated` and `done`. `flow.run.list` rows carry steps, tokens and
  costUsd. `flow.inbox.get` adds `done`: the last 30 items the person finished or decided
  (`flow_events_person_done_idx`, a partial index on the timeline's own JSON). `flow.gateway.save`
  takes `gatewayId` to change or rename one; `flow.gateway.delete` takes `gatewayId` or `name`.
- **Left out** (keep it simple): a live stream, search or filters in a run, steering or typing
  into a session, a terminal, and the mockup's "Produced" line (nothing reports it yet).

## The design
Agreed with the owner on 2026-11-15 (plan: `.kim/plans/2026-11-15-the-new-cores-ui-board-item-panel-and-card-timeline.md`).
[`docs/design/base-and-plugins.md`](../design/base-and-plugins.md) says in plain words what the
base does and what a plugin adds. The mockups, in `.kim/mockups/`, replace `docs/design/factory-ui/`
and the older files beside them:

| Screen | File |
| --- | --- |
| The board and the item panel (software and content examples) | `board-and-item-panel.html`, `board-dark.html` |
| The sidebar and a section's tabs | `sidebar-c-sections-projects-and-tabs-on-top.html` |
| The item as a full page | `item-as-a-full-page.html` |
| A run | `run.html` |
| The workflow editor | `workflow-editor.html` |
| Inbox | `inbox.html` |
| Chat, where workflows and plugins are built | `chat-build-a-workflow-and-a-plugin.html` |
| Team: an agent | `team-an-agent.html` |
| Plugins and gateways | `plugins.html`, `gateways.html` |
| Auto | `auto-schedules.html` |
| All orgs | `all-orgs.html` |

## Milestone 1, proved (2026-11-15)
On the deployed engine, through the `sf` CLI: an agent "Writer", a workflow "Draft, review, done"
(Draft owned by the agent, Review by a person, Done by nobody), a project and an item "A
lighthouse". The M5's runner updated itself to the new code, claimed the run 16 seconds after the
item was created, ran Claude in a folder with no repository, and handed back its text 17 seconds
later. The item moved to Review and appeared in the person's inbox; the person finished it and it
moved to Done. The timeline shows each move and the agent's text. No code names either status.

Known gaps, left on purpose: a claim whose reply is lost isn't retried cleanly; any org member can
finish a person's status; a run's events aren't stored, so the run view has nothing to show yet
(stored since migration 0434: see "the run view, as built" above).

## Milestone 2, proved (2026-11-15)
On the deployed engine: an agent "Builder" with the `factory` MCP server, a workflow "Ask, check"
(Ask owned by Builder, Check by a person), and an item whose body asked, in plain words, for a
plugin that adds a "Ready to check" card whenever an item enters Check. The M5's runner claimed the
run; Builder read the plugin guide, wrote the plugin "Welcome card" and saved it through the MCP
server, 31 seconds after the claim. When its run ended the item moved to Check, the new plugin's
`entered` hook ran in a Dynamic Worker, and the card appeared on the item's timeline.

Also on that day: the old app's screens were removed from the desktop app at the owner's request,
ahead of milestone 5. The old core's server code is still in place.

## Rules
- Keep it simple. No limits on plugins, no grants, no approval flows, and no handling of edge
  cases until the owner asks for one.
- A plugin that fails stops the item with an error. The item can be retried.
- The Cloudflare cost rules in `AGENTS.md` apply. Each `flow_` table states its retention, and the
  reconciler's queries go in the query-plan guard.
- The old core takes fixes only.

## Open questions
1. How a plugin changes what the app shows (a card's look, a new screen): what it hands the app.
2. Does the old data move at cutover, or does the new core start empty?

## Acceptance criteria (milestone 1)
1. A workflow is created, edited and read through operations, and is refused if a status points at
   a status that doesn't exist.
2. Moving an item into a status owned by an agent queues exactly one run with that status's brief.
3. Moving an item into a status owned by a person shows it in that person's inbox.
4. An item in a status that needs a person's decision waits until that person decides.
5. The same events replayed produce the same state.
6. No file in the new packages is over 400 lines, and CI fails if one is.
7. No new package imports `packages/core`.
