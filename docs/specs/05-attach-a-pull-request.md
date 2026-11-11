# Spec 05: Attach an outside pull request to a work item

Read first:
- ADRs [0020](../adr/0020-verification-and-review-packet.md), [0021](../adr/0021-governed-local-sessions.md),
  [0037](../adr/0037-factory-verify-pinned-and-sha-bound.md), [0053](../adr/0053-workflow-versioning.md),
  [0231](../adr/0231-verify-verdict-and-the-github-connector.md) and
  [0280](../adr/0280-protect-main-with-a-generated-ruleset.md);
- [spec 04](04-verify-and-pr.md), criterion 3.

Decision record: [ADR 0290](../adr/0290-an-outside-pr-is-attached-and-verified.md).

## Goal
A PR opened outside the factory, for example by a local session or a person, can be attached to a
work item. The factory then verifies it and takes it through the merge gate, so it reaches `main`
through `factory/verify` like everything else, with no bootstrap exception.

Today `factory/verify` tells an outside PR to "attach it to a work item", but nothing can. Every
local-session PR so far (#20, #22, #24, #25) has been merged with `factory/verify` red.

## Scope
- **The `workItem.attachPr { projectId, prNumber }` operation**
  - Actors: human. Permission: member. Risk: write. Idempotent: attaching an attached PR returns
    the existing item with `outcome: "attached"`.
  - Refused for:
    - a fork PR (the head repo isn't the project's repo);
    - a closed or merged PR;
    - a PR whose head branch is a factory branch (`factory/*`);
    - a project with no valid policy (fail closed).
  - It creates a work item with:
    - `kind = 'attached'` (migration from block L widens the CHECK);
    - `source = 'pr'` and dedupe key `github:<owner>/<repo>#<n>`;
    - the PR's title and body;
    - `branch` = the PR's head ref, `pr_number`, `pr_url` and `head_sha` = the PR's head;
    - the caller as requester.

    It then starts the Workflow.
- **The Workflow's attached path**, for `kind === 'attached'`. Other kinds' steps stay exactly as
  they are (ADR 0053: a new path, or a version bump; choose and record why).
  1. Triage runs as usual, to draft acceptance criteria from the PR's title, body and diff. Its
     size is logged. The spec stage is skipped with the reason "attached PR: built outside the
     factory", and so is build: the factory never pushes to the PR's branch, and `branch.ensure`
     and `branch.advance` aren't called.
  2. The verify loop on the PR's head:
     - the verify job (the runner fetches the PR branch at `head_sha`), then `waitForCi`, then
       `reviewPacket.record`;
     - **pass:** the merge gate (`pr.merge`). `pr.open` returns the existing PR.
     - **fail, or sent back at the merge gate:** the item waits, with the status reason "verify
       found problems: push a fix to the PR" or the send-back note, for the PR's head to change,
       then verifies again.
     - **the head changes while the merge gate is pending:** the pending action is withdrawn and
       the new head is verified.

     There's no build retry limit, since nothing is built. The gate timeout and escalation are
     as usual.
- **`verify.refresh`**: on `pull_request synchronize` for an attached item, it records the new
  `head_sha` and wakes the Workflow with a `pr-head-<item>` event. An attached PR that is closed
  without merging cancels its item.
- **The check's link**: the "Not attached to a factory work item" check gets a `detailsUrl` to
  `sf-app` `/attach?repo=<owner>/<repo>&pr=<n>`.
- **The app's `/attach` page**: the PR's title, author, branch and head, the project it maps to, and
  one button, **Attach and verify**. It then goes to the work item. New work also lists the
  project's open unattached PRs (`github.openPullRequests { projectId }`), each with Attach.

## Out of scope
- Fork PRs.
- Building on, or pushing to, an attached PR's branch.
- Attaching automatically on PR open (a later policy option).
- MCP and CLI surfaces (later; the operation is the API).

## Acceptance criteria
1. `workItem.attachPr` on an open same-repo PR creates one work item (kind `attached`, PR number,
   head SHA, the PR's branch) and starts its Workflow. A second call returns the same item. Fork,
   closed and `factory/*` PRs are refused with a reason.
2. The attached item's timeline shows triage, then spec and build skipped with the reason, then
   verify on the PR's head SHA. No push to the PR's branch happens; a test asserts no
   `branch.ensure` or `branch.advance`.
3. With green CI and a passing packet, `factory/verify` on the PR's head turns green, and the merge
   gate's approval merges the PR through `pr.merge`.
4. A failing verify leaves `factory/verify` red with the packet's reasons, and the item waits. A new
   push to the PR re-runs verify on the new head, and the old head's check stays red (ADR 0037).
5. A push while the merge gate is pending withdraws the pending merge and re-verifies. Approving
   the stale gate can't merge the old head.
6. The unattached check links to `/attach?repo=…&pr=…`. The page attaches the PR in one click for a
   member, and refuses a non-member.
7. Closing an attached PR without merging cancels its work item.
8. Change-kind and incident-kind Workflows behave exactly as before (the existing workflow tests
   pass unchanged).
