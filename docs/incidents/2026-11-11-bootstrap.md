# Incident 2026-11-11: bootstrap setup on production

The first factory incidents. They were found by hand while setting up V1 on production (the app's
Setup page and the M5 runner), not opened by `incident.open`, because the factory wasn't running yet.
There are four. Each has the root-cause class the incident flow uses (`packages/core/src/incidents/classify.ts`)
and what in `.factory/` or the specs would have caught it. All four are fixed on branch `bootstrap-fixes`.

| # | What happened | Root cause class | Fixed by |
| --- | --- | --- | --- |
| 1 | `project.create` saved `software-factory` with `github_installation_id = null`, and nothing could change it afterwards | `missing-check` (spec gap) | `project.update`; `project.create` returns `installationWarning`; Setup shows a warning and a fix path |
| 2 | Setup's installation auto-detect failed ("No GitHub App installation found: …") although the App is installed on the repo | `missing-context` | Detection moved to the engine and asks as the App (JWT), not the user; the reason is shown as GitHub gave it |
| 3 | Setup's Copy gave `runner id: …\nkey: …`; `sf-runner pair --key-stdin` read all of it as the key → `401 bad signature` | `missing-check` (no contract test across two builds) | Copy gives the ready-to-run command plus a separate key copy; `pair` accepts either form and names a runner-id mismatch |
| 4 | `sf-runner install` captured the shell's Node 22 into the launchd plist | `runner` | `install` refuses Node < 24 with the fix, pins the absolute Node path and puts its directory first on `PATH` |

## 1. A project couldn't be fixed after creation
**What happened.** The installation lookup failed (incident 2), Setup showed a toast that disappeared, and
then created the project anyway. The registry had `project.create` and `project.list` but nothing that
changes a project, so the only fix was a hand edit of D1, which the rules forbid (operations first).

**Root cause.** A spec gap (`missing-check`). The V1 app scope listed Setup's operations as create/list
only. No acceptance criterion said that every value Setup writes can be corrected through an
operation, or that a degraded save must stay visible.

**Fix.** `project.update` (admin, risk `write`, human only, audited with before/after) sets
`githubInstallationId`, by hand or with `detectInstallation: true`, and `defaultBranch`. A new default
branch clears the synced policy, so the project fails closed until the policy is re-read from that
branch. The operation is scoped to the org rather than the project, so it works before the project
has a policy (otherwise the gate would refuse the fix for the same reason the project is broken).
`project.create` returns `installationWarning`. Setup shows a persistent warning on a project with no
installation, an editable installation/branch row, and a **Detect installation** button.

**What would have caught it.** A spec rule for any setup screen: *every value it writes has an
update operation, and a save that leaves the entity degraded shows that on the entity, not in a
toast.* Add it to the spec template's acceptance criteria. It can't be expressed as a regex
check in `.factory/checks/`.

## 2. Installation detection failed
**What happened.** The app looked up the installation with the signed-in user's stored GitHub App
user token (`GET /user/installations`, then each installation's repositories), and reported "the
App isn't installed" for any failure. The real reason wasn't captured: the toast dropped the
detail, and the per-installation repository call skipped errors silently.

**Root cause (`missing-context`).** The design asked the wrong party. A user-to-server token is only
as good as the user's sign-in: GitHub App user tokens expire after 8 hours by default, Better Auth
doesn't refresh a token read straight from `core_account`, and the result is the intersection of the
user's and the App's access. The App itself can answer this authoritatively
(`GET /repos/{owner}/{repo}/installation` with its JWT), and the engine already holds that key. The
build agent didn't have "talk to GitHub as the App" in its context for this call. The app test faked
`fetch` with the same assumption, so it passed. The exact production failure (most likely a 401 from
an expired user token) couldn't be confirmed after the fact, because nothing logged it. That is part
of the incident.

**Fix.** Detection runs in the engine as the App (`GitHubService.findRepoInstallation`). A 404 says the
App isn't installed on the repo and links to the install page. A 401 points at `GH_APP_ID` /
`GH_APP_PRIVATE_KEY`. Anything else shows GitHub's status and message. The app's user-token lookup
is removed (ADR 0240, amended).

**What would have caught it.** Context: a line in the project's agent context (AGENTS.md / the
`.factory/` context for build runs) saying that GitHub reads and writes for the factory go through
the App's `GitHubService`, never a user token. A post-deploy smoke step would also have caught it:
call `project.create` (or `project.update { detectInstallation }`) against the real App for the
dogfood repo.

## 3. The runner key copy didn't fit `pair`
**What happened.** The app (#16) and the runner host (#14) were built in parallel sessions. The handoff
between them was a human copy-paste whose exact text no spec defined. The app copied a labelled
two-line block; `pair --key-stdin` expected the bare key and signed with the whole block.

**Root cause (`missing-check`).** No test crossed the two halves, and the CLI failed with a generic
`401 bad signature` instead of saying what was wrong.

**Fix.** Setup has **1. Copy command** (`pbpaste | local/runner-host/bin/sf-runner pair --runner-id r_… --key-stdin`)
and **2. Copy key**. The command reads the key from the clipboard, so the key never enters shell
history. `pair` accepts a bare key or the two-line block, takes the runner id from the block when
`--runner-id` is missing, refuses a mismatch by name, and adds a hint on a 401. Both sides are pinned
by tests (`apps/app/test/lib.test.ts`, `local/runner-host/test/pairing.test.ts`).

**What would have caught it.** A spec rule: *any text a person carries from one component to another
is specified verbatim in the spec, and both ends are tested against that string.* A regression case
for `evals/regressions/` belongs with the first `.factory/checks/`, e.g. a check that
forbids `writeText(\`runner id:` in `apps/app/src`.

## 4. The launchd service pinned Node 22
**What happened.** `sf-runner install` wrote `process.execPath` and the shell's `PATH` into the plist.
It ran under the shell's default Node 22, so the service would have run Node 22. `doctor` already
checked for Node ≥ 24, but `install` didn't.

**Root cause (`runner`).** The runner's install path didn't enforce the runtime it needs.

**Fix.** `install` refuses Node < 24 and prints both fixes (`nvm use 24`, or `SF_RUNNER_NODE=…`). It
pins the absolute Node path and puts that Node's directory first on the service's `PATH`, so tools
the runner spawns use the same Node.

**What would have caught it.** A rule that every precondition `doctor` checks is also checked by the
command that depends on it. It belongs in the runner-host spec's acceptance criteria.

## Follow-ups (not done here)
- Add the spec-template rules from 1 and 3 when the stage-spec template is next touched.
- Add the agent-context line from 2 and the check from 3 under `.factory/` (only `policy.json` exists so far, #17).
- Add a post-deploy setup smoke step (2) to `docs/deploying.md`.
