# Spec 12 (R1): Inbox

Read first: [`docs/ui-plan.md`](../ui-plan.md), mockup
[`home-inbox.html`](../../.kim/mockups/home-inbox.html), ADRs
[0007](../adr/0007-human-gates-are-pending-actions.md),
[0031](../adr/0031-dashboard-stack-and-inbox-first.md),
[0040](../adr/0040-web-push-and-wip-backpressure.md), [0042](../adr/0042-one-question-object.md);
specs [02](02-work-item-workflow.md), [10](10-r1-sign-in-and-org-switcher.md),
[15](15-r1-notifications-backpressure-and-metrics.md).

> Amended 2026-11-11 ([review decisions](../reviews/2026-11-11-review-decisions.md)): criteria split by R1 milestone. Added: cards grouped by
> project, a runner health line, WIP-limit holds, deep-link targets for web push, and questions as
> Question objects routed by domain in milestone (c).

## Goal
The home page shows everything waiting on the signed-in person, and lets them decide most of it
without leaving the page.

## Scope
- **(a)** Home (`/`) is the Inbox. Header: "N items waiting on you · N running · N shipped this
  week", plus the early-metrics strip (spec 15).
- **(a)** Cards for open gates and questions assigned to the signed-in user, **grouped by project**:
  - **Spec approval**: title, source, criteria count, size (and the triage reason if it was a
    skip decision), touched areas. Approve spec, Read spec, Request changes.
  - **Ready to merge**: checks, criteria, holdout results, reviewer verdict, screenshots count. Open
    review packet, Merge, Send back.
  - **Question**: the question with its default and suggested answers as buttons, plus Reply….
- **(a)** Each card has a stable URL (`/?item=<id>`) that web push deep-links to; opening it scrolls
  to and highlights the card.
- **(a)** A project held back by its WIP limit shows "N builds waiting on review" in its group.
- **(a)** **Runner health line**: one line under the Running section listing each of the user's
  runners with a status dot (online, busy n/cap, rate-limited until T, offline since T).
- **(a)** Cards that need the person get the ring style from the design system; status uses dots.
- **(a)** **Running** section: slots in use, and each running item with its stage, project, runner
  and age. Local sessions show as "local · <user>".
- **(a)** Search (⌘K) over work items.
- **(b)** Scope follows the org switcher (All factories by default); each card shows its account and
  org.
- **(c)** Question and spec-approval cards are routed by decision domain to the domain owner (or the
  backup owner after a timeout); spec approval shows one card per domain.

## Out of scope
Bulk approve, the work board (R2), the Runners page (R2), the full planning canvas.

## Acceptance criteria
**Milestone (a): one user, one repo**
1. Each open gate and question assigned to the user appears exactly once, in its project's group;
   gates for other approvers do not.
2. Approve spec, Request changes, Merge, Send back and answering a question each call one operation
   and the card leaves the inbox when it succeeds.
3. Deciding the same gate twice (two tabs) is idempotent: the second attempt reports it was already
   decided.
4. Merge from the inbox is refused for anyone who isn't an approver on that project.
5. The counts in the header match the cards and the Running section.
6. Opening a card's deep link highlights that card, or shows "already decided" if it has gone.
7. The runner health line shows a rate-limited runner with its "until" time and an offline runner
   with the time it was last seen.
8. Layout matches the mockup at desktop width and stays usable at phone width.

**Milestone (b): orgs and multi-session**
9. In "All factories", each card shows its account and org, and its action runs under that session.

**Milestone (c): domains, clarification, shared runners**
10. A question in a domain goes only to that domain's owner; with no owner declared it goes to the
    project approver.
11. A spec touching two domains shows two approval cards, and the spec gate opens only when both
    are approved.
