# Stage 12 (R1): Inbox

Read first: [`docs/ui-plan.md`](../ui-plan.md), mockup
[`home-inbox.html`](../../.kim/mockups/home-inbox.html), ADRs
[0007](../adr/0007-human-gates-are-pending-actions.md),
[0031](../adr/0031-dashboard-stack-and-inbox-first.md); stages [02](02-work-item-workflow.md),
[10](10-r1-sign-in-and-org-switcher.md).

## Goal
The home page shows everything waiting on the signed-in person, and lets them decide most of it
without leaving the page.

## Scope
- Home (`/`) is the Inbox. Header: "N items waiting on you · N running · N shipped this week".
- Cards for open gates where the signed-in user is the approver (or the decision domain's owner):
  - **Spec approval**: title, source, criteria count, size, touched areas. Approve spec, Read spec,
    Request changes.
  - **Ready to merge**: checks, criteria, reviewer verdict, screenshots count. Open review packet,
    Merge, Send back.
  - **Question**: the agent's question with suggested answers as buttons, plus Reply….
- Cards that need the person get the ring style from the design system; status uses dots.
- **Running** section: slots in use, and each running item with its stage, project, runner and age.
  Local sessions show as "local · <user>".
- Search (⌘K) over work items.
- Scope follows the org switcher (All factories by default).

## Out of scope
Bulk approve, the work board (R2), push notifications (no app yet; the outbox already records the
events).

## Acceptance criteria
1. Each open gate assigned to the user appears exactly once; gates for other approvers do not.
2. Approve spec, Request changes, Merge, Send back and answering a question each call one operation
   and the card leaves the inbox when it succeeds.
3. Deciding the same gate twice (two tabs) is idempotent: the second attempt reports it was already
   decided.
4. Merge from the inbox is refused for anyone who isn't an approver on that project.
5. In "All factories", each card shows its account and org, and its action runs under that session.
6. The counts in the header match the cards and the Running section.
7. Layout matches the mockup at desktop width and stays usable at phone width.
