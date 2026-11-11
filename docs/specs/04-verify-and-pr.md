# Spec 04: Verify, review packet and PR

Read first: ADRs [0010](../adr/0010-gatekeepers-for-intake-and-outbound.md),
[0020](../adr/0020-verification-and-review-packet.md), [0025](../adr/0025-github-app-per-org.md),
[0018](../adr/0018-model-roles.md), [0034](../adr/0034-holdout-acceptance-tests.md),
[0036](../adr/0036-policy-from-the-default-branch.md),
[0037](../adr/0037-factory-verify-pinned-and-sha-bound.md),
[0039](../adr/0039-per-project-evidence-policy.md),
[0041](../adr/0041-in-app-review-packet-is-the-merge-gate.md),
[0046](../adr/0046-content-cut-from-v1.md); [spec 03](03-runner-contract-and-orca.md).

> Amended 2026-11-11 ([review decisions](../reviews/2026-11-11-review-decisions.md)): gatekeeper is now connector; holdout tests;
> `factory/verify` pinned to the App and bound to the head SHA, from CI the cloud can read; the
> evidence policy; merge happens in the app; `.factory/` diffs are self-modify; the content
> placeholder is removed (content is cut from v1). Part of R1 milestone (a).

## Goal
A built branch becomes a PR with a review packet, and the merge gate waits for the approver.

## Scope
- Verify stage: run the project's tests, lint and typecheck on the runner (as evidence); read CI
  check runs for the head SHA from GitHub (as the verdict); run an independent reviewer (role
  `review`, which must resolve to a different model or harness than `implement`, with a warning when
  it doesn't); run the **holdout acceptance tests**; check each acceptance criterion and attach
  evidence.
- Holdout tests: written with role `review` when the spec is approved, stored with the work item,
  never sent to the implementing run. A failure sends the item back to build with the test's name
  and message only.
- Review packet: stored per work item, sections from `.factory/` `reviewPacket.sections` (default:
  verdict row, what changed, criteria + evidence, holdout results, reviewer notes, risk flags, diff).
  Evidence is stored only as the project's evidence policy allows; the rest is marked "kept on
  runner". A diff touching `.factory/` adds a self-modify risk flag with an impact summary.
- GitHub connector (`packages/connector-webhook` inbound, outbound PR action): open the PR from
  `factory/<id>-<slug>`, post the `factory/verify` check for the head SHA from the review packet,
  receive check, push and merge events. A push to the PR re-runs verify for the new SHA.
- Project onboarding check: the repo has branch protection requiring `factory/verify` from the
  org's App, with `enforce_admins` on; a repo where that is unavailable is refused.
- Merge gate: `pr.merge` is risk class `merge`, so it always waits for an approver; it is decided
  in the app and the factory merges through the App.

## Out of scope
Screenshots (`browser` capability evidence comes with R2's live run work), deploy, preview
environments (ADR 0045), auto-merge, content work (ADR 0046).

## Acceptance criteria
1. A work item that passed build has a PR opened by the GitHub App, never by a user token.
2. The PR carries a `factory/verify` check from the org's App, for the head SHA, whose status
   matches the review packet verdict. A new push leaves the new head without a passing check until
   verify runs again.
3. A PR opened outside the factory (e.g. from a local session) gets a failing `factory/verify` check
   until it is attached to a work item and verified.
   *(Amended 2026-11-11, [spec 05](05-attach-a-pull-request.md), [ADR 0290](../adr/0290-an-outside-pr-is-attached-and-verified.md):
   attaching is `workItem.attachPr`, from the `/attach` page that the failing check's Details links
   to. The factory then verifies the PR's own head and takes it through the merge gate.)*
4. Each acceptance criterion in the review packet has met/unmet and a piece of evidence.
5. When `review` and `implement` resolve to the same model, the packet shows a warning.
6. Merging requires an approver's `pr.merge`; an agent's call returns `pending_approval`.
7. The full slice works end to end in one repo: CLI intake → triage → implement on `runner-orca` →
   verify → PR → merge by the approver, with every step in the audit journal.
8. Holdout test sources never appear in the implementing run's prompt, workspace or events (a
   test), and their results appear in the packet.
9. The verdict comes from GitHub check runs on the head SHA; a runner reporting green while CI is
   red gives a failing verdict.
10. A diff that touches `.factory/` is flagged and its merge is `self-modify`.
11. With an evidence policy that keeps transcripts on the runner, no transcript reaches D1 or R2.
