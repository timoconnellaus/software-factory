# Spec 11 (R1): New work

Read first: [`docs/ui-plan.md`](../ui-plan.md), mockup
[`new-work.html`](../../.kim/mockups/new-work.html), ADRs
[0023](../adr/0023-runners-owned-by-users-and-requester-routing.md),
[0015](../adr/0015-scheduler-runtime-pool-and-capabilities.md),
[0038](../adr/0038-runner-sharing-is-an-owner-allowlist.md),
[0040](../adr/0040-web-push-and-wip-backpressure.md); specs
[02](02-work-item-workflow.md) and [10](10-r1-sign-in-and-org-switcher.md).

> Amended 2026-11-11 ([review decisions](../reviews/2026-11-11-review-decisions.md)): criteria split by R1 milestone. Runners are owner-only
> unless the owner allowlists them; the preview shows WIP backpressure.

## Goal
A person describes work like they would to a colleague and sends it to the factory in one step.

## Scope
- **(a)** `+ New work` in the sidebar opens the page. A free-text box, a project picker, Attach, and
  **Send to factory** (⌘↵).
- **(a)** A one-line routing preview: "Runs on <runner> · <harness> · <gate summary>". **Details**
  expands to requester, runner (owner, free slots, fallback), harness and reviewer roles, and gates.
  When the project is at its WIP limit the preview says the build will wait for review.
- **(a)** The preview comes from a read operation (`workItem.previewRouting`), the same logic the
  scheduler uses.
- **(a)** Sending calls `workItem.create` with actor `human` and the signed-in user as requester,
  then opens the work item detail.
- **(a)** A footer hint lists the other intake routes (`@factory` in Slack/Linear, a GitHub label, a
  local Claude session).
- **(b)** The project picker is scoped to the current org/factory from the switcher.
- **(c)** **Change runner…** picks another eligible runner, including runners shared into the project
  through their owner's allowlist. Sharing itself is `runner.share` / `runner.unshare` (owner only),
  reached from the runner host CLI in R1; the Runners page is R2.

## Out of scope
Attachments beyond plain files, templates, editing after send, the Runners page (R2).

## Acceptance criteria
**Milestone (a): one user, one repo**
1. Sending a description creates one work item with the signed-in user as requester and opens its
   detail page.
2. The collapsed preview fits on one line; Details shows requester, runner, harness, reviewer role
   and gates as in the mockup.
3. The preview and the scheduler agree: a test feeds the same inputs to both and gets the same
   runner, including the WIP-limit case.
4. ⌘↵ sends; an empty description cannot be sent.
5. The page calls operations only; no direct D1 access from UI code.

**Milestone (b): orgs and multi-session**
6. The project picker lists only projects in the org/factory selected in the switcher, and sending
   runs under that org's session.

**Milestone (c): domains, clarification, shared runners**
7. Changing the runner only offers runners with the needed capabilities that the project's
   `.factory/` allows and whose owner's allowlist covers the project.
8. Only a runner's owner can share or unshare it; anyone else's call is refused and audited.
