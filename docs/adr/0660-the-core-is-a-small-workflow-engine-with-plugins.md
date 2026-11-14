# ADR 0660: The core is rewritten as a small workflow engine with plugins

Status: proposed, 2026-11-15 (the owner's direction; spec [70](../specs/70-a-new-core.md) says how).
Supersedes [ADR 0510](0510-workflows-are-ordered-stages-of-stage-types.md) and the model in spec 52.
Amends [ADR 0005](0005-hybrid-coordinator.md), [0006](0006-work-item-workflows.md) and
[0008](0008-autonomy-presets-and-floor.md).

## Context
The project set out to be a factory that could run any workflow. What got built is one software
pipeline: `apps/engine/src/workflow/work-item.ts` is 2,708 lines at Workflow version 17 and
hard-codes triage → spec → build → verify → merge. Merge queues, the babysitter, red-main repair,
flakes, incidents and review packets all live in `packages/core` (73.8k lines), which knows one
outside service, GitHub. Spec 52 loosened this with stage types, but kept seven built-in types, two
fixed phases and no loadable plugins, and its reconciler only runs in shadow.

The owner's direction on 2026-11-15: it should be possible to build any workflow, and what is
specific to one kind of work should be a plugin. Multica (multica.ai) is the reference for the
model and the layout; grokbot-headless is the reference for plugins on Cloudflare.

## Decision
1. **A new core, built beside the old one.** The old core is frozen (fixes only) and deleted at
   cutover. Code that still makes sense is moved across, not rewritten.
2. **The model is statuses with owners.** A workflow is an ordered list of statuses the org
   defines. Each status has an owner (an agent with a brief, a person, or nobody), a "when done,
   move to" and an "if rejected, send back to". An item is in one status. Entering a status owned
   by an agent starts a run; entering one owned by a person puts it in their inbox. There are no
   built-in stage names, phases or stage types.
3. **The engine is a reconciler.** A pure function takes an item's snapshot and its workflow and
   returns the next action. It is driven by events, not by a replayed Cloudflare Workflow, so there
   are no workflow versions. `packages/core/src/stages/reconcile.ts` is the starting point.
4. **Small modules.** The core is split into packages with one job each, and no source file is over
   400 lines. CI checks the limit.
5. **Plugins are Dynamic Workers.** A plugin is a manifest and one module, loaded as a Cloudflare
   Dynamic Worker, as in grokbot-headless (its ADR 0026, `docs/adr/0026-plugins.md` in that repo).
   A plugin can add step kinds, hooks on the engine's events, triggers, connectors to outside
   systems, operations, and panels drawn by the host. It gets only the grants its manifest names.
6. **Plugins are edited through an MCP server.** There is one plugin MCP server (list, read, write,
   enable). An agent can change plugins if, and only if, that server is assigned to it. Assigning
   it is a person's action. An approval can be added to the flow: the org can set plugin edits to
   wait for a person's decision before they go live. It is off unless someone turns it on, and the
   engine never requires it.
7. **Gates stay in the core.** A status can require a person's decision, and the engine enforces
   it. A plugin can add a gate or a check; it cannot remove or answer one. This is the one rule
   kept from "policy is enforced in code", and it is what makes decision 6 safe enough to be simple.
8. **Software development is the first plugin.** GitHub, pull requests, `factory/verify`, the merge
   queue and the babysitter leave the core. Each is ported only when the new core needs it.
9. **The layout follows Multica's**, without copying it: a rail (Inbox, Work, Team, Chat, Auto), a
   section sidebar, a board with one column per status, and a run view. An item opens as a panel
   on the right of the board.
10. **The item's timeline is made of rich cards.** The timeline shows status changes and handoffs
    as one-line entries, and what an agent or person produced as a card: a plan with its steps, a
    pull request with its diff size and checks, a chart, a document preview. A card is drawn by
    the host from components the app ships; a plugin supplies the card's kind and data, never its
    own markup. Cards are the main way a plugin shows up in the UI. The existing UI and its
    mockups (`docs/design/factory-ui/`, `.kim/mockups/`) are redesigned around this.

## What is kept from the old core
The operations registry and `invoke()` (ADR 0003, 0004), the runner contract and channel, jobs,
runs and leases, the audit journal, orgs and sign-in, questions, kill switches, versioned config,
the desktop shell, and the Cloudflare cost rules in `AGENTS.md`.

## Consequences
- Specs 50, 52 and 53 and the open pipeline PRs (#152, #203) are on hold. Their code is a source to
  take from, not a base to build on.
- "No ambient authority", "runners are adapters", "code asks for a model role" and "model
  credentials stay with the runner's owner" hold unchanged.
- "Nothing reaches main except through `factory/verify` and the merge gate" becomes a rule of the
  software plugin, not of the core. This repo keeps it until cutover.
- `AGENTS.md`, `CONTEXT.md` and `docs/architecture.md` are rewritten at cutover, not before, so
  they stay true of what runs.
- An agent holding the plugin MCP can change what the engine does on every event. That is accepted:
  the answer is to be careful which agents get it.
