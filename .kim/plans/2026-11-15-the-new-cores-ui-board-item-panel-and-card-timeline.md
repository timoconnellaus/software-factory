# The new core's UI and plugins

**Goal:** agree the screens and what a plugin is for the new core (ADR 0660, spec 70).

## Decided: the app
- **Sections:** Inbox, Work, Chat, Team, Auto, Plugins, Settings.
- **Sidebar:** the Slack style the app has now. An org strip with an All orgs view, then one sidebar that never changes (sections, then projects). A section's own pages are tabs across the top.
- **Item:** a panel on the right of the board that can expand to a full page. One timeline replaces the five tabs: one-line events, and rich cards for what was produced.
- **A decision** is the last card in the timeline, with its buttons; a "Waiting on you" strip jumps to it.
- **A run** opens as a modal with a time bar and step list.
- **Workflow editor:** statuses as a row of boxes; a tab on the project, and a list in Settings.
- **All orgs:** what needs you, what is working now, each org's counts.
- **Look:** light and quiet, with a dark mode from the same tokens.

## Decided: plugins
- **A workflow is not a plugin.** Workflows are the base. A workflow may become a template later.
- **A plugin is something the base can't do, built by an agent on request.** You say what you want in Chat; the agent builds it while it builds your workflow.
- **What a plugin can do:** add steps, start work from outside, react to events, add rules, add fields, change how cards and items look, add screens, give agents tools, change what agents are told.
- **Gateways are separate.** A gateway is the org's connection to one outside system, set up once and shared by plugins and agents.
- **Kept simple:** a change is live straight away, everywhere in the org. No limits on plugins, no approval. A plugin that fails stops the item with an error, and it can be retried.
- **Later, not now:** sharing plugins between orgs, a marketplace, approvals, limits.

## Open
- Whether the Chat, Plugins and agent screens are right.

## Next
- Save the mockups and this plan to the repo and add them to the design PR (#206).
- Start milestone 1 of spec 70.
