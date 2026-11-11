# ADR 0033: Per-job GitHub App tokens; runners run without the owner's credentials

Status: accepted, 2026-11-11 (review decisions, [`docs/reviews/2026-11-11-review-decisions.md`](../reviews/2026-11-11-review-decisions.md), answering the [design review](../reviews/2026-11-11-design-review.md)).

## Context
[ADR 0025](0025-github-app-per-org.md) left runners pushing with their owner's own git credentials.
The design review's top finding: a harness that runs with the owner's logged-in `git`, `gh`,
`wrangler` or cloud credentials can push, merge or deploy outside the pipeline, so "policy is
enforced in code" only holds in the cloud.

## Decision
- For every job, the control plane mints a **short-lived GitHub App installation token scoped to the
  job's one repository** and sends it to the runner with the job. It expires with the job's lease
  ([ADR 0035](0035-lease-fencing-and-one-branch-per-run.md)) or after one hour, whichever is first.
- The runner pushes with that token, and only to the work item's run branch
  ([ADR 0035](0035-lease-fencing-and-one-branch-per-run.md)). GitHub cannot scope a token to a
  branch, so the branch limit is enforced by repository rulesets and by the push webhook: a push
  from the App to any other branch, or with a stale fencing token, fails the run and is audited.
- The harness runs **without the owner's git or cloud credentials**: the runner host starts it with
  a scrubbed environment (no `GH_TOKEN`, SSH agent, cloud CLI config or keychain-backed git
  helper) and a git credential helper that serves only the job token.
- The **model subscription stays the owner's** ([ADR 0023](0023-runners-owned-by-users-and-requester-routing.md)):
  the harness keeps its own login (for Claude Code, its subscription), and nothing else.
- Branch protection on the default branch allows **no admin bypass** (`enforce_admins` on), so even
  the owner's own credentials cannot skip `factory/verify` ([ADR 0037](0037-factory-verify-pinned-and-sha-bound.md)).

## Consequences
- Resolves ADR 0025's open question (runner push credentials).
- The runner host needs a "clean launch" for each adapter. For `runner-orca` this depends on Orca
  starting a terminal with a given environment; until Orca supports launch args, harness-claude
  projects a per-run `.claude/settings.json` ([ADR 0017](0017-harness-adapters.md)) and the host
  checks the environment before it starts the session.
- A client project whose runner sits on a shared machine needs a separate OS user or container per
  client until per-item grants exist ([ADR 0030](0030-deferred-from-v1.md)).
- Open: whether the subscription terms of each harness allow unattended or team use of a runner.
