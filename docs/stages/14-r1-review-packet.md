# Stage 14 (R1): Review packet

Read first: [`docs/ui-plan.md`](../ui-plan.md), mockup
[`review-packet.html`](../../.kim/mockups/review-packet.html), ADRs
[0020](../adr/0020-verification-and-review-packet.md),
[0008](../adr/0008-autonomy-presets-and-floor.md); stages [04](04-verify-and-pr.md),
[13](13-r1-work-item-detail.md).

## Goal
An approver can decide a merge from one page, trusting the evidence without reading the whole diff.

## Scope
- Page at `/work/<id>/review` and as the Review packet tab on work item detail.
- Header: status ("Ready to merge"), org · project · requester · runner, title, PR number, diff
  size, approver and which rule makes them the approver (e.g. "project floor: client repos").
  Actions: Send back, View diff, Merge.
- Sections, rendered in the order `.factory/` `reviewPacket.sections` lists them; any section not
  listed is not shown:
  verdict row (checks, criteria, reviewer verdict, risk), what changed, acceptance criteria with
  evidence, reviewer notes (marked as independent, different model), visual evidence, risk flags,
  inline diff (collapsed), deploy preview link.
- Merge footer: why merge needs this person (floor or preset), and the merge method.

## Out of scope
Commenting on lines, partial approval, deploy.

## Acceptance criteria
1. Sections follow the project's `reviewPacket.sections` order; a section left out of the config is
   not rendered.
2. Every acceptance criterion shows met/unmet and at least one evidence link or note.
3. Merge calls `pr.merge`; for a non-approver it is disabled and the server refuses it anyway.
4. Send back requires a note and returns the work item to build with that note on the timeline.
5. The reviewer section says which model role reviewed and warns when it matched the implementer.
6. The page renders from the stored review packet; it makes no live GitHub calls on load.
