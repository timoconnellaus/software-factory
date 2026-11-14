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
- **Plugin**: a manifest and a module, loaded as a Dynamic Worker.
- **Card**: a rich entry in an item's timeline (a plan, a pull request, a chart, a document), drawn
  by the host from a kind and data that the core or a plugin supplies.
- **Hook**: a named point where plugins run: an item enters or leaves a status, a run starts or
  ends, an action is about to happen.

## The packages
Each has one job, and no source file is over 400 lines.

| Package | Job | Taken from |
| --- | --- | --- |
| `packages/flow` | The model (zod schemas) and the reconciler. Pure: no D1, no Cloudflare. | `core/src/stages/reconcile.ts`, `workflow.ts` |
| `packages/ops` | `defineOperation`, the registry, `invoke()`, permissions, audit. | `core/src/operation.ts`, `registry.ts`, `invoke.ts` (1,179 lines, to be split) |
| `packages/store` | D1 access for items, workflows, runs and the thread. New tables, prefix `flow_`. | `packages/db` |
| `packages/plugins` | The manifest schema, the Dynamic Worker host, hook dispatch, grants. | grokbot-headless `plugin-descriptor.ts`, `plugin-worker-host.ts` |
| `packages/plugin-mcp` | The MCP server that lists, reads, writes and enables plugins. | new |
| `apps/engine` | The Worker: routes, cron, the runner channel. Calls the packages above. | the runner channel and auth as they are |
| `plugins/software` | GitHub, pull requests, verify, merge. | `connector-github`, `engine/src/github`, `core/src/verify` |

`packages/runner-contract`, `runner-local`, `harness-claude`, `local/runner-host`, `packages/ui`
and `apps/desktop` stay. The runner contract loses its fixed job stages: a job carries a brief and
the capabilities it needs.

## Milestones
Each ends with something that runs.

1. **An item moves through a workflow.** `flow`, `ops`, `store`. Operations for workflows, items
   and the thread. The reconciler assigns a person or queues a run on entering a status, and moves
   the item on done or rejected. Proof: a workflow "Draft → Review → Done", with an agent on Draft
   and a person on Review, runs end to end on a real runner, with no code that names either status.
2. **Plugins.** The Dynamic Worker host, hooks, grants, cards and the plugin MCP, with the optional
   approval on plugin edits. Proof: an agent with the plugin MCP writes a plugin whose hook posts
   a card to the timeline when an item enters a status; an agent without it can't; with the
   approval turned on, the edit waits for a person.
3. **The software plugin.** A pull-request panel, a check step, a merge action behind a person's
   decision. Proof: this repo's own work runs on the new core.
4. **The UI, redesigned.** New mockups first, then the desktop app's rail, sidebar, board, the item
   panel with its timeline of cards, and the run view, on the new operations.
5. **Cutover.** Move the data that matters, delete the old core, rewrite `AGENTS.md`, `CONTEXT.md`
   and `docs/architecture.md`.

## Rules
- A status that needs a person's decision is enforced by the engine. A plugin can't remove or
  answer it.
- A plugin failure never stops the engine: a hook that throws or times out is skipped and recorded,
  and a plugin that fails three times in a row is switched off.
- The Cloudflare cost rules in `AGENTS.md` apply. Each `flow_` table states its retention, and the
  reconciler's queries go in the query-plan guard.
- The old core takes fixes only.

## Open questions
1. Does a status allow more than one owner at once (parallel work), or is that a later plugin?
2. Does the old data move at cutover, or does the new core start empty?
3. Which card kinds ship with the core on day one (comment, plan, document, chart), and which come
   from the software plugin (pull request, checks)?

## Acceptance criteria (milestone 1)
1. A workflow is created, edited and read through operations, and is refused if a status points at
   a status that doesn't exist.
2. Moving an item into a status owned by an agent queues exactly one run with that status's brief.
3. Moving an item into a status owned by a person shows it in that person's inbox.
4. A status that needs a decision can't be left by an agent.
5. The same events replayed produce the same state.
6. No file in the new packages is over 400 lines, and CI fails if one is.
7. No new package imports `packages/core`.
