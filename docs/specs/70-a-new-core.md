# Spec 70: A new core

Status: **proposed, 2026-11-15.** Read [ADR 0660](../adr/0660-the-core-is-a-small-workflow-engine-with-plugins.md)
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
