# Handoff

Where things stand, for a fresh session. Read [`AGENTS.md`](../AGENTS.md) first.

## Where things stand (2026-11-15)
The core is a small workflow engine with plugins ([ADR 0660](adr/0660-the-core-is-a-small-workflow-engine-with-plugins.md),
[spec 70](specs/70-a-new-core.md)). All five milestones of spec 70 are built, and the old software
pipeline is deleted. An org defines workflows, projects and agents; items move through statuses;
agents run on the owner's runners; plugins add hooks, fields and cards; Chat builds workflows and
plugins from plain words; schedules make items on a clock. A project can have a GitHub repository,
and with the software plugin installed its runs push the item's branch and get a pull request.

## What is live
- `sf-engine` at `https://sf-engine.zerobsai.com` (`/health`), deployed from `main` on every merge.
- The website at `https://software-factory.zerobsai.com`: GitHub sign-in and the device login pages.
- The desktop app, canary channel: install once from
  `https://downloads.zerobsai.com/desktop/canary-macos-arm64-Software-Factory.zip` (unzip, move to
  `/Applications`); it updates itself.
- Runners on the owner's Macs, which update themselves to the deployed runner code.

## Try it
In the desktop app: sign in, open your org, start a chat ("Set up a workflow Draft → Review → Done
with an agent writing the drafts, and a project Blog on it"), then add an item to the project's
board. A runner of yours must be online (Team → Runners).

From a terminal, with the `sf` CLI (`local/cli`; `sf login --write` first):

```sh
sf ops                                  # every operation
sf call org.list '{}'                   # your org ids
sf call flow.project.list '{"orgId":"<org>"}'
sf call flow.item.create '{"orgId":"<org>","projectId":"<project>","title":"Launch post","body":"Announce it."}'
sf call flow.inbox.get '{"orgId":"<org>"}'
sf call flow.timeline.get '{"orgId":"<org>","itemId":"<item>"}'
```

Spec 70's "as built" sections have the full walk-throughs: a workflow from scratch, a gateway, a
plugin, an agent with the `factory` MCP server, and a trigger.

## Known gaps
- A chat reply takes as long as starting a Claude session on the runner: there is no long-lived
  session.
- A claim whose reply is lost isn't retried cleanly: the run stays claimed until its lease lapses
  (10 minutes) and then fails.
- Any member of the org can finish a status a person owns, or decide an item.
- No run reports a cost. In the default (tmux) session mode a run reports no token counts either;
  stream-json mode does.
- Desktop notifications can't be clicked through to the item.
- There is no operation to delete a project. The test projects from the proofs are still in the
  owner's Personal org.
- The phone app (outside this repo) still shows the old pipeline's screens; its sign-in operations
  are kept here.
- A plugin can't add a screen, give agents a tool or change how a card looks, and an agent can list
  gateways but not call one.

## Next
1. **Gateways in the gatekeeper shape**: one Worker per outside service, typed methods instead of
   raw HTTP, and connecting an account by signing in (OAuth). See
   [spec 70, "Next"](specs/70-a-new-core.md#next-gateways-in-the-gatekeeper-shape).
2. Spec 70's open question: how a plugin changes what the app shows.
