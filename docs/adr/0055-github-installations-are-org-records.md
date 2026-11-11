# ADR 0055: GitHub App installations are org records, connected through GitHub's install flow

Status: accepted, 2026-11-11 (onboarding, branch `onboarding-connect-github`). Amends
[ADR 0025](0025-github-app-per-org.md) and [ADR 0240](0240-v1-app-sign-in-and-server-functions.md).

## Context
The first Setup ([incident 2026-11-11-bootstrap](../incidents/2026-11-11-bootstrap.md)) asked the
owner to type a repo owner, name and branch, offered an "installation id" field nobody can find, a
**Detect installation** button and a manual **Sync policy**, and saved half-broken projects behind a
toast. The owner's verdict: "weird, I've never seen a process like this." Vercel, Netlify, Linear and
Railway connect GitHub with one button and a repo picker. **Onboarding must never ask users for ids
the system can fetch.**

## Decision
- **An installation is a record of the org** (`core_github_installations`, migration 0060): GitHub's
  installation id (never shown), the account login and type, the repository selection and a status
  (`active`, `suspended`, `deleted`). One installation belongs to one org.
- **Connect GitHub** (`github.connectStart`, org owner/admin) returns
  `https://github.com/apps/<slug>/installations/new?state=…`. The state is 32 random bytes, stored
  only as its SHA-256 with the org, the person and a 15-minute expiry, and is spent once.
- **The App's Setup URL** is `https://software-factory.zerobsai.com/integrations/github/setup`
  (sf-app). It signs the person in if needed (keeping GitHub's parameters), then calls
  `github.connectInstallation { installationId, setupAction, state, userAccessToken? }`, which:
  1. with a state: refuses one that is unknown, someone else's (CSRF), used or expired; without one
     (`setup_action=update` from GitHub's settings) the installation must already be connected to
     an org the person administers;
  2. asks GitHub **as the App** (`GET /app/installations/{id}`): an id GitHub doesn't know for this
     App is refused (`not_found`), so a forged `installation_id` can't be recorded;
  3. requires the person to have access to it: it is on their own GitHub account (login match), or
     their own GitHub user token lists it (`GET /user/installations`). The app gets that token from
     Better Auth (`getAccessToken`, which refreshes it); it is redacted from the audit row, never
     stored by the factory and never used for repo access, so ADR 0025's "never via user login
     tokens" still holds for everything the factory does to a repo;
  4. records or refreshes the installation, then links the org's existing projects on that account
     whose repo it reaches (recording GitHub's repo id) and reads their policy. This migrates the
     first `software-factory` project, saved with no installation.
  `setup_action=request` (an org member asked an owner to approve) records nothing.
- **Webhooks keep it current** (`github.installation`): repositories added or removed (projects are
  linked or disconnected), `suspend` / `unsuspend` (the record's status; a suspended installation's
  GitHub calls are refused by `repoRef` with a reason), `deleted`. An installation no org connected
  never takes over a project that has a connection.
- **A project is a repo picked from what the org's installations reach.** `github.repos` lists them
  live with metadata-only installation tokens. `project.create { orgId, installationRecordId,
  repoId, name? }` takes the default branch from GitHub and **refuses** (saving nothing) when the
  installation isn't the org's, isn't active, or can't reach the repo. Reachability is asked with an
  installation token limited to that one repo id: GitHub refuses it (422) unless the installation
  reaches the repo. (Reading `/repositories/{id}` alone would also answer for any public repo.)
- **The policy syncs itself**: `project.create`, connecting an installation, and every push to the
  default branch (`push.observe`) read `.factory/policy.json` at the head through the App and record
  it. `policy.resync` is the small manual Re-sync. The app's own GitHub read (`syncPolicy`) is gone,
  so private repos work.
- **No policy → a PR, not a form.** `policy.proposeTemplate` (human only, admin, risk `outbound`)
  opens a PR from `factory/setup-policy` adding a template: autonomy policy Balanced, the person as
  approver and backup owner. It refuses when the default branch already has the file. `push.observe`
  treats the App's push to that branch as its own.
- **Setup is a checklist** (`setup.status`): GitHub connected, a project, its policy valid, one of
  your runners online, `factory/verify` required (asked of GitHub as the App), each with the one
  action that fixes it. The inbox shows a **Finish setup** card until all are green.
- `project.update` stays for admin fixes (MCP, scripts). The app doesn't show or ask for an
  installation id anywhere.

## Consequences
- The GitHub App needs its **Setup URL** set to `/integrations/github/setup` with "Redirect on
  update" on, and GitHub must send `installation` / `installation_repositories` events (already
  subscribed, ADR 0231).
- `project.create`'s free-text input is gone; tests onboard through the same three operations.
- Open: a template-policy PR is opened by the App and isn't a work item, so once `factory/verify` is
  required it can't pass. Setup orders policy before the required check, which avoids it for new
  repos; a repo that already requires the check needs the owner to merge it as an admin.
- Open: an organization member without admin rights can install the App only by request; that path
  records nothing until an owner approves, then `setup_action=update` arrives without a state, and
  the person must start Connect GitHub again to link it.
