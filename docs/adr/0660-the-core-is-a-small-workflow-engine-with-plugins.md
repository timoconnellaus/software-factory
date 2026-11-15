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
specific to one kind of work should be a plugin. The owner also asked that the design stay simple:
the earlier work went wrong by designing for edge cases first. Multica (multica.ai) is the reference for the
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
5. **A workflow is not a plugin.** Workflows, statuses and owners are the base, set up per org.
   A workflow may later be saved as a template to start another project from.
6. **A plugin is something the base can't do, built by an agent on request.** A person says what
   they want in plain words; an agent with the plugin editor builds it. A plugin changes how the
   current org works. It can add a step a status can use, start work from an outside event, react
   when something happens, add a rule about when an item may move, add fields to items, change how
   a card or an item looks, add a screen, give agents a tool, and change what agents are told.
   Technically it is code loaded as a Cloudflare Dynamic Worker, as in grokbot-headless (its ADR
   0026, `docs/adr/0026-plugins.md` in that repo).
7. **Gateways are separate from plugins.** A gateway is the org's connection to one outside system
   (Gmail, GitHub, Slack), set up once, holding its credentials. Plugins and agents use a gateway
   by name; no plugin carries its own access to an outside system, so two plugins can share Gmail.
8. **Plugins are edited through an MCP server**, the plugin editor. An agent can change plugins
   if, and only if, that server is assigned to it. A change is live straight away, everywhere in
   the org.
9. **Kept simple on purpose (the owner, 2026-11-15).** There are no limits on what a plugin may
   do, no grants, and no approval of plugin edits: giving an agent the plugin editor means trusting
   it. When a plugin fails, the item stops with an error and can be retried. Approval of edits,
   limits, trying a change on one item first, sharing plugins between orgs and a marketplace can
   each come later, and none is designed now.
10. **Software development is a plugin.** Pull requests, checks, `factory/verify`, the merge queue
    and the babysitter leave the core, and GitHub becomes a gateway. Each is ported only when
    needed. An org with no software work in it must be fully usable.
11. **The layout** keeps the app's Slack-style sidebar: an org strip with an All orgs view, then
    one sidebar that never changes (Inbox, Work, Team, Auto, Plugins, then the projects, with
    Settings at the bottom). A section's own pages are tabs across the top. A project is a board
    with one column per status. An item opens as a panel on the right and can expand to a page.
12. **The item's timeline is made of rich cards.** It shows status changes and handoffs as
    one-line entries, and what an agent or person produced as a card: a plan with its steps, a
    pull request with its diff size and checks, a chart, a document preview. A decision that waits
    on a person is the last card, with its buttons. A plugin can add card kinds and change how
    cards look. The existing UI and its mockups (`docs/design/factory-ui/`, `.kim/mockups/`) are
    replaced by this design.

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
- An agent holding the plugin editor can change anything about how the org works. That is
  accepted: the answer is to be careful which agents get it.
- The policy rules in `AGENTS.md` (gates in code, not AI-configurable; self-modify goes to a
  human) describe the old core. They stop applying at cutover, when `AGENTS.md` is rewritten.
