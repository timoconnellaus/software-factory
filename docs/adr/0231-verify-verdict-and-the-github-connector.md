# ADR 0231: The verify verdict, `factory/verify` and the GitHub App connector

Status: accepted, 2026-11-11 (V1 step 4). Implements [ADR 0020](0020-verification-and-review-packet.md),
[ADR 0037](0037-factory-verify-pinned-and-sha-bound.md), items 1 and 4 of
[ADR 0052](0052-job-tokens-and-branch-confinement.md) and the connector side of
[ADR 0036](0036-policy-from-the-default-branch.md); [spec 04](../specs/04-verify-and-pr.md).

## Context
V1-1 left the verify verdict to the runner's report, the PR opening after verify (so CI, which runs
on `pull_request`, never ran on the head before the verdict), and no webhook. ADR 0037 wants the
verdict from CI the cloud can read, bound to the head SHA, re-evaluated on every push.

## Decision
- **The verdict** (`reviewPacket.record`) passes only when CI on the head SHA is green as GitHub
  reports it (every check run except the factory's own; none at all is `missing`, never green) **and**
  the packet is complete: every acceptance criterion met with non-empty evidence, the independent
  reviewer's approval, no failing runner check, and the diff readable from GitHub's compare. The
  runner's own verdict is kept as evidence. Risk flags (`.factory/` self-modify, permissions, auth,
  migrations, deps) are computed from the compare. A reviewer resolving to the implementer's model
  is a warning in the packet.
- **`factory/verify`** is a check run the App posts for exactly one SHA and updates in place
  (`core_verify_checks`): success / failure from the packet's evidence and CI as it stands, and
  `in_progress` while CI runs. `verify.refresh` re-evaluates it when a PR opens or is pushed to
  (a new head has no passing check until verify runs again: `in_progress` if it is the head the
  factory put there, failure otherwise), when a check suite completes, and when someone re-runs
  it. A PR with no work item fails it.
- **Workflow v2** ([ADR 0053](0053-workflow-versioning.md)): after the build is accepted it opens the
  PR, runs the verify job, then waits for CI (`ci.read`; woken by the `ci-<item>-<sha>` event the
  connector sends when a check suite completes; it re-reads every 10 minutes, up to 2 hours, or 30
  minutes when no CI reports at all), then records the packet and goes by its verdict. v1 instances
  replay unchanged.
- **The connector** is two packages: `connector-webhook` (signature check, provider-neutral) and
  `connector-github` (event → operations). It is **mounted in sf-engine** at `/webhooks/github`, and
  served on `software-factory.zerobsai.com/webhooks/*` by a Workers route in front of sf-app's
  Custom Domain, so sf-app is untouched. Deliveries are deduped by delivery id in
  `core_connector_events` (recorded by `connector.receive` after handling) and every call runs as
  `{ type: "intake", id: "github" }`.
- **Branch confinement**: a repository ruleset (`FACTORY_RULESET` in `packages/core`) blocks
  creating, updating or deleting any branch but `factory/**` and the default branch for everyone
  except repo admins; the App is not a bypass actor, so it can only push `factory/*`, and reaches
  the default branch only by a PR that passes branch protection. `push.observe` checks each App push
  against the runs: a run branch must belong to an active run whose fencing token is current; the
  work item branch may only move to a handed-back run's head (or while no run is active, the
  control plane's own commits). Anything else fails the item's active run, bumps its fencing token,
  notifies the requester and is audited.
- **Policy bootstrap**: `policy.sync` and `push.observe` are `bootstrapsPolicy` operations, judged as
  unscoped calls (Cautious + the floor): they are how a policy arrives, so a missing or malformed one
  can't block them. They apply only default-branch content.
- **Onboarding**: `project.checkGitHub` reports whether the repo requires `factory/verify` from the
  App with admins enforced and has the confining ruleset.

## Consequences
- The App needs `checks: write` and `administration: read` on top of contents and pull requests, and
  the `pull_request`, `check_suite`, `check_run`, `push`, `installation` and
  `installation_repositories` events. Check and admin calls mint their own tokens, so an App
  without them still opens and merges PRs; the failure is reported in the packet.
- A runner's job token can still push the item branch while a run is active for up to an hour; that
  is caught after the fact (the run fails) and can't merge: the merge is bound to the SHA the
  control plane verified.
- Requiring `factory/verify` on a repo blocks every PR the factory didn't open. On software-factory
  itself that waits for the bootstrap (V1 step 5), see the PR that added this ADR.
