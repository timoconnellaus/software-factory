# ADR 0037: `factory/verify` is pinned to the App and bound to the head SHA

Status: accepted, 2026-11-11 (review decisions, [`docs/reviews/2026-11-11-review-decisions.md`](../reviews/2026-11-11-review-decisions.md), answering the [design review](../reviews/2026-11-11-design-review.md)).

## Context
`factory/verify` is the guarantee that nothing reaches main without the factory
([ADR 0020](0020-verification-and-review-packet.md), [ADR 0021](0021-governed-local-sessions.md)).
A check name alone can be posted by anyone with checks access, and a passing check can outlive the
commit it described.

## Decision
- Branch protection requires `factory/verify` **with the org's GitHub App as its expected source**.
- The check is posted for one **head SHA**. Any new push to the PR leaves the new head without a
  passing check until verify runs again.
- Verify relies on **CI the cloud can read** (GitHub check runs on that SHA), not on what the runner
  reports. Runner-side test results are evidence in the packet, not the verdict.
- `enforce_admins` stays on.

## Consequences
- Before a project joins the factory, the factory checks that branch protection with a required
  check is available for that repo (it is not on every private-repo plan) and refuses the project if not.
- Client repos the org does not administer need the client to install the App and set protection.

> Amended 2026-11-11 (V1 step 4, [ADR 0231](0231-verify-verdict-and-the-github-connector.md)): built. `factory/verify` is posted per SHA and updated in place; it is `in_progress` while CI runs. Making it required on software-factory waits for the bootstrap, so the PRs of the sessions building V1 aren't blocked.
