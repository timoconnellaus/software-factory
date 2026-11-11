# ADR 0290: An outside PR is attached to a work item and verified

Status: accepted, 2026-11-11 (branch `attach-pr`, [spec 05](../specs/05-attach-a-pull-request.md)).
Amends [ADR 0021](0021-governed-local-sessions.md) and [spec 04](../specs/04-verify-and-pr.md)
criterion 3. Builds on [ADR 0037](0037-factory-verify-pinned-and-sha-bound.md),
[0053](0053-workflow-versioning.md) and [0231](0231-verify-verdict-and-the-github-connector.md).

## Context
`factory/verify` fails every PR the factory didn't open, with "attach it to a work item", but
nothing could attach one. So every PR from a local session (#20, #22, #24, #25) was merged with
`factory/verify` red, as a bootstrap exception the owner approved each time. Once `main` is protected
([ADR 0280](0280-protect-main-with-a-generated-ruleset.md)) those PRs couldn't merge at all.
ADR 0021's principle ("local sessions can do anything locally, but nothing reaches main except
through the factory gate") needs a way in for work that was built outside the factory.

## Decision
- **`workItem.attachPr { projectId, prNumber }`** (human, member, write) creates a work item of the
  new kind **`attached`** for an open PR from the project's own repo into its default branch. Its
  branch is the PR's head ref, and it carries the PR's number, URL and head SHA. Its source is
  `pr`, its intake dedupe key `github:<owner>/<repo>#<n>`, its title and body the PR's, and the
  caller is the requester. It then starts the Workflow. Attaching again returns the live item
  (`outcome: "attached"`). An earlier item for the PR that was cancelled, failed or rejected gives
  the key up to a new one.
- **Refused:** a fork (head repo ≠ the project's repo), a closed or merged PR, a factory branch
  (`factory/*`, which the factory opened and already owns), a PR into another branch (only the
  default branch has the merge gate; this refusal is an addition to spec 05), and a project with
  no valid policy (fail closed, as `workItem.create`).
- **Migration 0080** rebuilds `core_work_items` to widen its `kind` CHECK to
  `('change', 'incident', 'attached')` (SQLite can't alter a CHECK), with foreign keys deferred, and
  adds an index on `(project_id, pr_number)`.
- **A kind-gated path, not a version bump.** `run()` reads the item (`meta: item`, which was
  already v1's and v2's first step after `meta: version`, so it is read once and the order is
  unchanged) and sends `attached` items to `runAttached`. Change and incident items run exactly the
  code and steps they ran before. ADR 0053 asks for a new version when a running instance's step
  sequence would change. Here no running instance changes: an attached instance can only start
  after this deploy, and no change or incident instance ever reaches the new path.
  `WORKFLOW_VERSION` stays 2 and is recorded on attached items as on any other. A version bump would
  have made every new change item a "v3" for no change in its steps, and kept a copy of `runV1`
  around until v2 drained.
- **The attached path:** triage on a runner (the checkout is the PR's branch; the prompt asks for
  criteria from the PR's title, body and diff; the size is recorded). Then spec and build are
  skipped with the reason "attached PR: built outside the factory". `workItem.triage` records that
  decision for an attached item whatever its size. The factory never pushes to the PR's branch:
  no `branch.ensure`, `branch.advance` or build job. Then a verify loop on the PR's head:
  `pr.open` (returns the PR), the verify job at `head_sha`, `waitForCi`, `reviewPacket.record`.
  - **Pass:** the merge gate (`pr.merge`, `self-modify` when the diff touches `.factory/`). Gate
    timeouts and escalation are as usual.
  - **Fail, or sent back:** `workItem.awaitHead` puts the item in `waiting` with the reason
    ("verify found problems: push a fix to the PR", or "Sent back at review: <note>"). The Workflow
    then waits for `pr-head-<item>` and verifies again once the head has moved. Each wake re-reads
    the head, so a repeated or early event costs nothing, and a 12-hour timeout re-reads it in case
    a webhook was lost. There is no build retry limit, since nothing is built. A verify *run*
    failing (the runner, not the PR) still counts against the retry limit and opens an incident.
  - **The head moves while the merge gate is pending:** `verify.refresh` withdraws the pending
    merge (status `rejected`, decision `withdrawn`) and sends its approval event with decision
    `withdrawn`. The Workflow then verifies the new head. Approving the withdrawn gate is a
    conflict, and `pr.merge` refuses a head that moved (as before, and GitHub's merge is SHA-bound).
    An approval that races the push comes back as a refused apply; the attached path handles it
    as a send-back, where the factory's other paths would end the item.
- **`verify.refresh`** on a `pull_request` event for an attached item whose head moved checks the
  PR on GitHub (so a late delivery for an older push can't move it back), records the new
  `head_sha`, puts a waiting item back to running, withdraws the merge gate and sends
  `pr-head-<item>`. On `pull_request closed` without a merge it cancels the attached item, with
  the same writes as `workItem.cancel` (now `cancelWorkItem`). A factory item's PR closing is still
  left to its Workflow. A commit that is no longer an item's head keeps the check its own packet
  gives it (ADR 0037), found through `core_verify_checks.work_item_id`. It no longer reads as "Not
  attached".
- **The unattached check links to the app:** `detailsUrl` = `sf-app` `/attach?repo=<owner>/<repo>&pr=<n>`.
  The page (`workItem.previewAttach`) shows the PR's title, author, branch and head, the project it
  maps to, and **Attach and verify**, then goes to the work item. A non-member is refused by the
  operations' `member` permission. New work lists the project's open unattached PRs
  (`github.openPullRequests`), each with Attach.
- **A send-back of an attached PR opens no factory incident.** The factory didn't build it, so
  review sending it back is review of a person's work, not a factory failure.

## Consequences
- Every PR, whatever its source, now has a way to reach `main` through `factory/verify` and the
  merge gate. This PR is the last bootstrap exception: it is the one PR that can't be attached
  before attaching exists.
- The factory verifies work it didn't build against criteria triage drafted from the PR itself, so
  the bar is "the PR does what it says, CI is green, and an independent reviewer agrees". It is not
  checked against a spec someone approved beforehand.
- Attached items wait on people (a push or a decision) for as long as the PR stays open. Closing
  the PR, or `workItem.cancel`, ends them.
- `GitHubService` gains `getPullRequest` and `listOpenPullRequests`. They use the existing
  `pull_requests` permission, so the App needs no new permissions or events.
- Not built: attaching automatically when a PR opens (a later policy option), MCP and CLI surfaces,
  and fork PRs.
