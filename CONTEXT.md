# Context: the words

The vocabulary of the code and the docs. Use these words, and only these, for these things.

## Work
- **Org**: who owns everything else: projects, workflows, agents, plugins, gateways, schedules.
  Everyone gets a Personal org at first sign-in; a person can be a member of several
  (`core_organization`, `core_member`).
- **Project**: a board of items in an org. It has a key (`BLG`) that numbers its items (`BLG-12`)
  and follows one workflow (`flow_projects`).
- **Item**: a unit of work: a title, a body, plugin fields, a timeline, and exactly one status
  (`flow_items`).
- **Workflow**: an ordered list of statuses, defined per org and chosen by a project. It is part of
  the base, not a plugin (`flow_workflows`, `packages/flow/src/model.ts`).
- **Status**: one column on the board. It has an owner, a brief for an agent owner, where the item
  goes when done (default: the next status) and when rejected (default: the one before), and
  whether leaving it needs a person's decision.
- **Owner**: who a status hands the item to: an agent (a run starts), a person (it goes in their
  inbox) or nobody (it waits until someone moves it).
- **Agent**: a named set of instructions, with a model, an effort level and the MCP servers its runs
  get (`flow_agents`). It runs only on a runner.
- **Run**: one execution of an agent on an item's status, or of a chat's reply, on a runner
  (`flow_runs`): queued, claimed (with a lease), then done, failed or cancelled. Its steps are its
  run events (`flow_run_events`).
- **Timeline**: everything that happened to an item, oldest first: moves, effects, comments and
  cards (`flow_events`).
- **Card**: a rich timeline entry a plugin adds: a kind, a title, and optional subtitle, rows,
  checks, bars and a link (a pull request, a document, a chart).
- **Field**: a value on an item that a plugin declares (`text`, `number` or `date`) and sets; the
  board and the item show it.
- **Decision**: a person's approve or reject on an item in a status that needs one
  (`flow.item.decide`). It is the last card on the timeline until made.
- **Inbox**: what waits on people, across a person's orgs: items in statuses the person owns, items
  waiting for a decision, items an agent is working on, and what the person recently finished.
- **Chat**: a conversation with a model the person picks (and an effort level). Each reply is a run
  on a runner with the `factory` MCP server, so a chat can set up workflows, projects, items and
  plugins (`flow_chats`, `flow_chat_messages`).
- **Schedule**: makes an item in a project on a clock (hourly, daily, weekdays or weekly, in one
  time zone). The Auto screen lists them (`flow_schedules`).

## Plugins and gateways
- **Plugin**: something the base can't do, built by an agent from plain words: one ES module of an
  org, run as a Cloudflare Dynamic Worker with no network of its own (`flow_plugins`,
  `packages/plugins`). It declares fields and hooks.
- **Hook**: a plugin function the base calls around an item event: `entered` (after an item enters
  a status), `leaving` (before it leaves one; may refuse), `runEnded` (after an agent's run) and
  `trigger` (an outside event).
- **Trigger**: a plugin's public URL, `POST /flow/triggers/<pluginId>/<name>?key=<key>`, that runs
  its `trigger` hook with the request's JSON body.
- **Gateway**: the org's named connection to one outside system: a base URL, how to authenticate
  and a stored secret (`flow_gateways`). A plugin calls it by name (`ctx.gateway("blog").fetch`) and
  never holds the secret. `github` is built in for every org that connected GitHub.
- **The `factory` MCP server** (the plugin editor): the engine's MCP server at `/flow/mcp`. With it a
  run can call any `flow.*` operation and list, read, save and delete plugins. A chat's runs always
  get it; an item's run gets it if its agent has `"factory"` in its `mcp`.

## Runners
- **Runner**: a machine its owner connected to run agents (`core_runners`). It serves runs of its
  owner's items, and of orgs it is shared into (`core_runner_shares`).
- **Runner host**: the daemon on that machine, `sf-runner` (`local/runner-host`). It heartbeats,
  claims runs, starts the harness, sends events and hands back over the signed runner channel.
- **Harness**: how Claude Code runs there (`packages/harness-claude`): its settings, sandbox, deny
  rules and launch, with no owner credentials.
- **Flow job**: a run as the runner contract carries it (`JOB_STAGES` is `["flow"]`): a prompt, the
  model and effort, MCP servers, a lease's fencing token, and a repository and branch if the
  project has one.
- **Repository on a project**: a GitHub repository the org's GitHub App installation reaches, set
  with `flow.project.setRepository`. A run of such a project works in a checkout of it.
- **The item's branch**: `factory/flow-<key>-<number>`, made by the item's first run on a project
  with a repository and reused by its later runs. The runner host pushes it with a one-repository
  token.

## Sign-in and devices
- **Door**: how a client reaches the engine with a token: the desktop app through the client door
  (`/client/v1`), the `sf` CLI through `/cli/v1`. The website is not a door: it calls the engine over
  a service binding.
- **Device key**: the desktop app's key, in the Secure Enclave on a signed build, that its sign-in
  is bound to.
- **Presence proof**: a message the device key signs after Touch ID. Today only pairing a phone
  (`mobile.pairOffer`) and turning on a device's approvals (`device.update`) need one.

## Words we no longer use
They appear in ADRs before 0660 and specs before 70, which describe the old factory.

| Old word | Now |
| --- | --- |
| work item | item |
| stage, stage type | status |
| spec gate, review packet, merge gate, `factory/verify`, merge queue, babysitter | gone; pull requests are the software plugin |
| foreman | gone; the workflow says who owns each status |
| policy, autonomy policy, floor, dark factory mode | gone |
| autopilot | schedule |
| connector | gateway |
| Setup screen | gone; the desktop app's Settings, Team › Runners (connect a runner, its Claude account) and a project's Settings tab |
