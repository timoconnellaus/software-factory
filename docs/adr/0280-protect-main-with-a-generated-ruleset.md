# ADR 0280: The factory generates the default-branch ruleset; a person applies it; the factory verifies it

Status: accepted, 2026-11-11 (branch `protect-main-ruleset`). Amends [ADR 0052](0052-job-tokens-and-branch-confinement.md)
item 1 and [ADR 0055](0055-github-installations-are-org-records.md) (the Setup checklist). Builds on
[ADR 0037](0037-factory-verify-pinned-and-sha-bound.md).

## Context
"Nothing reaches main except through `factory/verify` and the merge gate" (ADR 0020, 0021, 0037)
holds only if GitHub enforces it on the default branch. Until now Setup's last step said
"`factory/verify` required" and linked to `gh api` commands in `docs/deploying.md`, and the check
looked at classic branch protection. Applying protection from the factory would need the App to
hold `administration: write`, which also lets it **delete repositories**. The owner's constraint:
the App keeps `administration: read`. The factory verifies protection; a person applies it.

Rulesets beat classic protection here: GitHub can export and import them as JSON, they can have no
bypass actors at all (classic protection's `enforce_admins` still lets admins change the rule
silently), the App can read them with `administration: read`, and GitHub reports the rules in force
on a branch (`GET /repos/{o}/{r}/rules/branches/{branch}`), org rulesets included.

## Decision
- **Two generated rulesets**, in the JSON GitHub's **New ruleset → Import a ruleset** takes (the same
  body as `POST /repos/{o}/{r}/rulesets`: `name`, `target`, `enforcement`, `bypass_actors`,
  `conditions`, `rules`):
  - `<repo>-default-branch.json`: target `~DEFAULT_BRANCH`, active, **no bypass actors**; rules
    `pull_request` (0 approvals: the factory's review packet is the approval, ADR 0041),
    `required_status_checks` with the policy's CI checks (default `ci`) and `factory/verify` pinned
    to the factory's App (`integration_id`), strict (up to date); `non_fast_forward`; `deletion`.
  - `<repo>-factory-branches.json`: the push confinement of ADR 0052 item 1, unchanged (repo admins
    bypass it so people keep their own branches; the App never does). It is offered only when no
    active ruleset confines the App already.
- **The App stays read-only on settings.** `APP_REQUIREMENTS` keeps `administration: read`. Nothing
  in the factory calls a GitHub endpoint that changes protection.
- **Verification** (`verifyProtection`, pure) compares GitHub's report with the generated ruleset and
  returns each missing piece as its own sentence: "a pull request isn't required before merging",
  "`factory/verify` not required", "`factory/verify` isn't pinned to the factory's App", "branches
  needn't be up to date before merging", "`ci` not required", "force pushes are allowed", "the
  branch can be deleted", "bypass allowed for admins (ruleset `X`)", a ruleset that targets the
  wrong branch or is in evaluate mode, and a missing confinement ruleset. A requirement is met when
  at least one active ruleset without bypass actors provides it. When GitHub doesn't show a
  ruleset's bypass list to the App, that is a warning, not a failure. Classic branch protection is
  not counted (a warning says it is still there and can go once the ruleset passes).
- **Operations.** `protection.ruleset` (the file), `protection.check` (Check now, human),
  `protection.observe` (the connector and the daily re-check, as the `github` intake). Both checks
  record the verdict in `core_project_protection` (migration 0070): `ok`, `red` or `unknown`
  (GitHub couldn't be read). They are `write` risk (a factory row) and `bootstrapsPolicy`, so they
  run before a policy lands and while a kill switch is on. `project.checkGitHub` returns the same
  verdict without recording it.
- **Setup's last step is "Protect `main`"**, with **Download ruleset** (served by sf-app at
  `/api/projects/<id>/rulesets/<kind>.json` with `Content-Disposition: attachment`), **Open GitHub
  rulesets** (`https://github.com/<owner>/<repo>/settings/rules`, hint *New ruleset → Import a ruleset
  → choose the file → Create*) and **Check now** (✓, or the list of what's missing).
- **Client repos.** Setup asks GitHub (as the App, `GET /collaborators/{login}/permission`) whether
  the viewer is a repo admin. If not, it shows **Send to the repo admin**: a copyable message with
  the steps and the same download. If GitHub can't say, both are shown.
- **Drift.** `repository_ruleset` and `branch_protection_rule` webhooks route to `protection.observe`;
  the minute cron re-checks a few projects a minute whose last check is over a day old. A red after
  an ok is drift: the org's owners and admins get a `protection.changed` notification and the inbox
  shows **Protection on `main` changed** with the same buttons, until a check is green again.
  Setup reads GitHub live, so the step is red as soon as protection is. Setup lists the two events
  if the App isn't subscribed to them (`GET /app`).
- **Policy.** `.factory/policy.json` gains `protection: { onRed: "warn" | "block", requiredChecks }`.
  `warn` (the default) only shows it. `block` keeps build jobs queued with the wait reason
  "default-branch protection is red" until a check is green; triage, spec and verify still run.
  Changing it is a `.factory/` change, so only a person can loosen it.

## Consequences
- The App never needs `administration: write`, and a leaked App credential can't remove protection.
- With no bypass actors, the owner's own PRs need `factory/verify` too. A repo should switch only
  once the factory opens its PRs (V1 step 5 for software-factory). Admins can still edit or disable a
  ruleset on GitHub; that is drift, and the factory says so.
- `strict` means a PR must be up to date with the default branch before it merges. When main moves
  under an open factory PR, merging needs the branch updated first.
- Open: GitHub doesn't document the import format beyond "an exported ruleset". The generated file
  uses the REST create body (what an export contains, minus `id`, `source` and timestamps). If the
  import page refuses it, the fallback is the same JSON through `POST /repos/{o}/{r}/rulesets` by a
  repo admin.
- Open: whether GitHub shows `bypass_actors` to an App with `administration: read` isn't documented;
  if it doesn't, Check now passes with a warning and the person confirms the bypass list by eye.
