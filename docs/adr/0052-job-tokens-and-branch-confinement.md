# ADR 0052: Minting job tokens, and confining pushes to the run branch

Status: accepted, 2026-11-11 (V1 core + engine). Implements [ADR 0033](0033-per-job-github-app-tokens.md)
and [ADR 0035](0035-lease-fencing-and-one-branch-per-run.md).

## Context
ADR 0033 gives each job a short-lived GitHub App installation token for one repo. GitHub cannot
scope an installation token to a branch, and installation tokens always live one hour. Tokens must
never be stored by the factory.

## Decision
- **Minting.** `sf-engine` signs an App JWT (RS256, Web Crypto) with `GH_APP_PRIVATE_KEY` (GitHub's
  PKCS#1 PEM is wrapped into PKCS#8) and `GH_APP_ID`, and calls
  `POST /app/installations/:id/access_tokens` with `repositories: [<repo>]` and
  `permissions: { contents: "write" }` only. The installation is the project's, else the org's.
- **Delivery.** The job doesn't carry the token. The runner host asks for it with
  `POST /runner/v1/jobs/:id/token { fencingToken }` (operation `run.issueToken`): only for an active
  run whose fencing token is current. The channel never puts this answer in its idempotency store,
  and the audit row redacts it. Each call mints a fresh token, so the host can refresh one that
  expires during a long run.
- **Expiry.** GitHub fixes the lifetime at one hour; the factory can't shorten it. When a lease is
  lost the fencing token makes every channel call fail, and the host must stop and revoke its token
  (`DELETE /installation/token`).
- **Branch confinement**, since the token can push any branch of the repo:
  1. **Repository ruleset** (project onboarding, spec 04): the App may only create or update refs
     matching `factory/*`; the default branch takes changes only through a PR with `factory/verify`.
  2. **Hand-back validation** (`run.handBack`): the reported branch must be the run's own
     `factory/<n>-<slug>-run-<k>`, and for a build the branch's head on GitHub must equal the reported
     `headSha`; otherwise the run fails and it is audited.
  3. **The work item branch moves only by the control plane** (`branch.advance`), as a fast-forward to
     a handed-back run whose fencing token is still current.
  4. **Push webhook** (GitHub connector, spec 04): a push by the App to any branch other than the
     run branch of an active run with the current token fails that run and is audited.
- The control plane's own calls (create the item branch, commit the approved spec, open and merge
  the PR, compare for `.factory/` changes) use a separate installation token with
  `contents` + `pull_requests`, cached in memory, never sent anywhere.

## Consequences
- A leaked job token can at worst push a `factory/*` branch for under an hour, and nothing merges
  without `factory/verify` and a person.
- Items 1 and 4 are the GitHub connector's job (spec 04); until they land, item 2 is the check.

> Amended 2026-11-11 (V1 step 4, [ADR 0231](0231-verify-verdict-and-the-github-connector.md)): items 1 and 4 are built. The ruleset is `FACTORY_RULESET` (repo admins bypass it; the App doesn't), applied to software-factory and checked by `project.checkGitHub`. The push webhook (`push.observe`) also accepts the App moving a work item's branch to a handed-back run's head, or while no run is active.
