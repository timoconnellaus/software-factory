# Stage 11 (R1): New work

Read first: [`docs/ui-plan.md`](../ui-plan.md), mockup
[`new-work.html`](../../.kim/mockups/new-work.html), ADRs
[0023](../adr/0023-runners-owned-by-users-and-requester-routing.md),
[0015](../adr/0015-scheduler-runtime-pool-and-capabilities.md); stages
[02](02-work-item-workflow.md) and [10](10-r1-sign-in-and-org-switcher.md).

## Goal
A person describes work like they would to a colleague and sends it to the factory in one step.

## Scope
- `+ New work` in the sidebar opens the page. A free-text box, a project picker (scoped to the
  current org/factory), Attach, and **Send to factory** (⌘↵).
- A one-line routing preview: "Runs on <runner> · <harness> · <gate summary>". **Details** expands
  to requester, runner (owner, free slots, fallback), harness and reviewer roles, and gates.
  **Change runner…** picks another eligible runner.
- The preview comes from a read operation (`workItem.previewRouting`), the same logic the scheduler
  uses.
- Sending calls `workItem.create` with actor `human` and the signed-in user as requester, then opens
  the work item detail.
- A footer hint lists the other intake routes (`@factory` in Slack/Linear, a GitHub label, a local
  Claude session).

## Out of scope
Attachments beyond plain files, templates, editing after send.

## Acceptance criteria
1. Sending a description creates one work item with the signed-in user as requester and opens its
   detail page.
2. The collapsed preview fits on one line; Details shows requester, runner, harness, reviewer role
   and gates as in the mockup.
3. The preview and the scheduler agree: a test feeds the same inputs to both and gets the same runner.
4. Changing the runner only offers runners with the needed capabilities that the project's
   `.factory/` allows.
5. ⌘↵ sends; an empty description cannot be sent.
6. The page calls operations only; no direct D1 access from UI code.
