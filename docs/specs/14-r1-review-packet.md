# Spec 14 (R1): Review packet

Read first: [`docs/ui-plan.md`](../ui-plan.md), mockup
[`review-packet.html`](../../.kim/mockups/review-packet.html), ADRs
[0020](../adr/0020-verification-and-review-packet.md),
[0008](../adr/0008-autonomy-presets-and-floor.md), [0034](../adr/0034-holdout-acceptance-tests.md),
[0039](../adr/0039-per-project-evidence-policy.md),
[0041](../adr/0041-in-app-review-packet-is-the-merge-gate.md); specs [04](04-verify-and-pr.md),
[13](13-r1-work-item-detail.md).

> Amended 2026-11-11 ([review decisions](../reviews/2026-11-11-review-decisions.md)): the packet in the app is the merge gate and links to the
> GitHub PR; it shows holdout results, respects the evidence policy and records "opened full diff?".
> Criteria split by R1 milestone.

## Goal
An approver can decide a merge from one page, trusting the evidence without reading the whole diff.

## Scope
- **(a)** Page at `/work/<id>/review` and as the Review packet tab on work item detail. It is the
  merge gate: Merge here calls `pr.merge` and the factory merges through the App.
- **(a)** Header: status ("Ready to merge"), org · project · requester · runner, title, PR number
  **linked to the GitHub PR** (for line comments), diff size, approver and which rule makes them the
  approver (e.g. "project floor: client repos"). Actions: Send back, View diff, Merge.
- **(a)** Sections, rendered in the order `.factory/` `reviewPacket.sections` lists them; any
  section not listed is not shown: verdict row (checks, criteria, holdout results, reviewer verdict,
  risk), what changed, acceptance criteria with evidence, holdout tests, reviewer notes (marked as
  independent, different model), visual evidence, risk flags, inline diff (collapsed). The deploy
  preview link stays hidden until previews exist (ADR 0045).
- **(a)** Evidence the project's evidence policy keeps on the runner shows as "kept on runner" with
  where to find it.
- **(a)** **"Opened full diff?"**: the packet records whether the approver expanded the inline diff
  or opened the GitHub PR before deciding, as part of the gate decision (spec 15 reports it).
- **(a)** Merge footer: why merge needs this person (floor or autonomy policy), and the merge method.
- **(c)** Domain-split approvals: when the spec touched several decision domains, the footer lists
  which domain owners have signed off.

## Out of scope
Commenting on lines (that is the linked GitHub PR), partial approval, deploy, preview environments.

## Acceptance criteria
**Milestone (a): one user, one repo**
1. Sections follow the project's `reviewPacket.sections` order; a section left out of the config is
   not rendered.
2. Every acceptance criterion shows met/unmet and at least one evidence link or note.
3. Merge calls `pr.merge`; for a non-approver it is disabled and the server refuses it anyway.
4. Send back requires a note and returns the work item to build with that note on the timeline.
5. The reviewer section says which model role reviewed and warns when it matched the implementer.
6. The page renders from the stored review packet; it makes no live GitHub calls on load.
7. The PR number links to the GitHub PR.
8. Every merge or send-back records whether the full diff was opened first.
9. Evidence the evidence policy keeps on the runner is never fetched or rendered, only referenced.

**Milestone (b): orgs and multi-session**
10. The approver rule shown is resolved within the item's org, and Merge runs under that org's
    session.

**Milestone (c): domains, clarification, shared runners**
11. With domain-split approval, Merge stays disabled until every touched domain has signed off.
