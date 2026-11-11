# Stage 13 (R1): Work item detail

Read first: [`docs/ui-plan.md`](../ui-plan.md), mockup
[`work-item.html`](../../.kim/mockups/work-item.html), ADRs
[0006](../adr/0006-work-item-workflows.md), [0011](../adr/0011-audit-journal-is-the-metrics.md);
stages [02](02-work-item-workflow.md), [10](10-r1-sign-in-and-org-switcher.md).

## Goal
One page shows where a work item is, how it got there, and what it is being checked against.

## Scope
- Header: breadcrumb (Work / project / id), current stage badge, org · factory · project, title,
  "Requested by … · from <source> · runs on <runner>". Actions: Take over locally (shown only when
  the runner declares `ui-takeover`; it may link to instructions in R1), Cancel.
- Stage steps: Intake › Triage › Spec › Build › Verify › Merge, from the project's pipeline, with
  the current one highlighted and done ones ticked.
- Tabs: **Timeline** (from the audit journal: each stage with actor, duration, gate time and
  links), **Spec** (the living spec), **Runs** (each run: runner, harness, branch, duration, status),
  **Review packet** (stage 14).
- Sidebar: acceptance criteria with checked state, and Details: policy preset, approvers, runner,
  agent time, your time.

## Out of scope
Live run view and steering (R2), editing the spec in place (planning UI comes later).

## Acceptance criteria
1. Every timeline entry comes from the audit journal; nothing on the page is stored separately.
2. The stage steps reflect the project's configured pipeline, not a hard-coded list.
3. "Your time" equals the summed open time of gates the viewer decided on this item.
4. Take over locally is hidden for runners without `ui-takeover`.
5. Cancel calls `workItem.cancel`, which stops the Workflow, and the timeline records it.
6. A viewer without access to the item's org gets a not-found page, not an error with details.
