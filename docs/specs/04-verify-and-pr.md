# Stage 4: Verify, review packet and PR

Read first: ADRs [0010](../adr/0010-gatekeepers-for-intake-and-outbound.md),
[0020](../adr/0020-verification-and-review-packet.md), [0025](../adr/0025-github-app-per-org.md),
[0018](../adr/0018-model-roles.md); [stage 3](03-runner-contract-and-orca.md).

## Goal
A built branch becomes a PR with a review packet, and the merge gate waits for the approver.

## Scope
- Verify stage: run the project's tests, lint and typecheck on the runner; check CI; run an
  independent reviewer (role `review`, which must resolve to a different model or harness than
  `implement`, with a warning when it doesn't); check each acceptance criterion and attach evidence.
- Review packet: stored per work item, sections from `.factory/` `reviewPacket.sections` (default:
  verdict row, what changed, criteria + evidence, reviewer notes, risk flags, diff).
- GitHub App gatekeeper (`packages/gatekeeper-webhook` inbound, outbound PR action): open the PR,
  post the `factory/verify` check from the review packet, receive check and merge events.
- Merge gate: `pr.merge` is risk class `merge`, so it always waits for an approver.
- Content placeholder: a stage can produce a draft artifact instead of a PR (shape only).

## Out of scope
Screenshots (`browser` capability evidence comes with R2's live run work), deploy, auto-merge.

## Acceptance criteria
1. A work item that passed build has a PR opened by the GitHub App, never by a user token.
2. The PR carries a `factory/verify` check whose status matches the review packet verdict.
3. A PR opened outside the factory (e.g. from a local session) gets a failing `factory/verify` check
   until it is attached to a work item and verified.
4. Each acceptance criterion in the review packet has met/unmet and a piece of evidence.
5. When `review` and `implement` resolve to the same model, the packet shows a warning.
6. Merging requires an approver's `pr.merge`; an agent's call returns `pending_approval`.
7. The full slice works end to end in one repo: CLI intake → triage → implement on `runner-orca` →
   verify → PR → merge by the approver, with every step in the audit journal.
