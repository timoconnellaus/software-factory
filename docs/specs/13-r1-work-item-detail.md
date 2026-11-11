# Spec 13 (R1): Work item detail

Read first: [`docs/ui-plan.md`](../ui-plan.md), mockup
[`work-item.html`](../../.kim/mockups/work-item.html), ADRs
[0006](../adr/0006-work-item-workflows.md), [0011](../adr/0011-audit-journal-is-the-metrics.md),
[0042](../adr/0042-one-question-object.md); specs [02](02-work-item-workflow.md),
[10](10-r1-sign-in-and-org-switcher.md).

> Amended 2026-11-11 ([review decisions](../reviews/2026-11-11-review-decisions.md)): criteria split by R1 milestone. Added: the triage
> skip reason, assumptions, and in milestone (c) a Questions tab with interview-session views and
> delegation to a guest.
>
> Amended 2026-11-11 ([spec wi-1](wi-1-let-s-also-make-it-so-work-items-can-hav.md), [ADR 0310](../adr/0310-work-item-attachments.md)): the
> sidebar has an Attachments section (thumbnails for images, size, uploader; add by picker,
> drag-and-drop or pasting anywhere on the page; remove with confirmation), and New work can stage
> attachments that are added once the item is created.

## Goal
One page shows where a work item is, how it got there, and what it is being checked against.

## Scope
- **(a)** Header: breadcrumb (Work / project / id), current stage badge, org · factory · project,
  title, "Requested by … · from <source> · runs on <runner>". Actions: Take over locally (shown only
  when the runner declares `ui-takeover`; it may link to instructions in R1), Cancel.
- **(a)** Stage steps: Intake › Triage › Spec › Build › Verify › Merge, from the project's pipeline,
  with the current one highlighted and done ones ticked. A skipped spec stage shows the triage reason.
- **(a)** Tabs: **Timeline** (from the audit journal: each stage with actor, duration, gate time and
  links), **Spec** (the living spec, with its assumptions marked), **Runs** (each run: runner,
  harness, run branch, duration, status), **Review packet** (spec 14).
- **(a)** Sidebar: acceptance criteria with checked state, and Details: autonomy policy, approvers,
  runner, agent time, your time.
- **(c)** **Questions** tab: the item's questions, filtered by interview-session view (planning,
  clarification, design review, decision). The owner can delegate a question to a guest
  (`question.delegate`), which creates a clarification view for them. "Accept remaining defaults"
  skips security & privacy and irreversible questions.

## Out of scope
Live run view and steering (R2), editing the spec in place, the full-screen planning canvas, mockup
option cards.

## Acceptance criteria
**Milestone (a): one user, one repo**
1. Every timeline entry comes from the audit journal; nothing on the page is stored separately.
2. The stage steps reflect the project's configured pipeline, not a hard-coded list.
3. "Your time" equals the summed open time of gates the viewer decided on this item.
4. Take over locally is hidden for runners without `ui-takeover`.
5. Cancel calls `workItem.cancel`, which stops the Workflow, and the timeline records it.
6. A skipped spec stage shows the reason triage logged.

**Milestone (b): orgs and multi-session**
7. A viewer without access to the item's org gets a not-found page, not an error with details.

**Milestone (c): domains, clarification, shared runners**
8. Delegating a question to a guest gives them a view with only that question and the mockups
   shared with it; their answer rolls up into the owner's planning view.
9. "Accept remaining defaults" never answers a security & privacy or irreversible question.
