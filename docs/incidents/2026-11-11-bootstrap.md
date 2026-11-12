# Incident 2026-11-11: bootstrap setup on production

The first factory incidents. They were found by hand while setting up V1 on production (the app's
Setup page and the M5 runner), not opened by `incident.open`, because the factory wasn't running yet.
There are eight (the fifth to eighth were found during the first real jobs). Each has the root-cause class the incident flow uses (`packages/core/src/incidents/classify.ts`)
and what in `.factory/` or the specs would have caught it. The first four are fixed on branch `bootstrap-fixes`, the fifth on `runner-orca-resolve-repo`, the sixth on `harness-permission-mode`.

| # | What happened | Root cause class | Fixed by |
| --- | --- | --- | --- |
| 1 | `project.create` saved `software-factory` with `github_installation_id = null`, and nothing could change it afterwards | `missing-check` (spec gap) | `project.update`; `project.create` returns `installationWarning`; Setup shows a warning and a fix path |
| 2 | Setup's installation auto-detect failed ("No GitHub App installation found: …") although the App is installed on the repo | `missing-context` | Detection moved to the engine and asks as the App (JWT), not the user; the reason is shown as GitHub gave it |
| 3 | Setup's Copy gave `runner id: …\nkey: …`; `sf-runner pair --key-stdin` read all of it as the key → `401 bad signature` | `missing-check` (no contract test across two builds) | Copy gives the ready-to-run command plus a separate key copy; `pair` accepts either form and names a runner-id mismatch |
| 4 | `sf-runner install` captured the shell's Node 22 into the launchd plist | `runner` | `install` refuses Node < 24 with the fix, pins the absolute Node path and puts its directory first on `PATH` |
| 5 | The runner added a second Orca repo for `software-factory` next to the owner's, and churned a new one per job | `missing-check` (spec gap) | ADR 0260: jobs run in the existing Orca repo found by canonical identity; clone-once fallback; startup migration; `sf-runner doctor --fix` (branch `runner-orca-resolve-repo`) |
| 6 | The job's Claude ran with `--permission-mode auto` although the factory projected `dontAsk`: the launcher added the owner's own mode, and a CLI flag beats a settings file | `runner` (launcher override + missing post-launch verification) | ADR 0270: the harness owns its launch command (no user settings, its own mode), the sandbox in every stage, the live process verified before the prompt, `harness-config-mismatch` kills and fails the job; `sf-runner doctor` checks running jobs (branch `harness-permission-mode`) |
| 7 | Work item #1's PR conflicted with `main` from the start, so GitHub ran no CI; verify read "no CI" as a build failure and the retries couldn't fix it | `missing-check` (spec gap) | ADR 0320: branches merge the default branch before build, a conflict is its own state, missing CI asks a person (Workflow v3); then the merge queue (ADR 0330) |
| 8 | Every job since #24 ran on the tail of its prompt: typed into the Claude terminal, a multi-kilobyte prompt arrived truncated | `runner` (prompt transport) | The prompt goes in `.factory-prompt.md` in the worktree; the terminal gets one short pointer line; `runner-sends-the-prompt-as-a-file` check |

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

## 5. The runner added a second Orca repo
**What happened.** Found on the M5 during work item #1, the first real job. Orca showed the project
`github:timoconnellaus/software-factory` with two source repos, both named `software-factory`: the
owner's `~/orca/projects/software-factory` and the runner's own clone under
`~/.local/state/software-factory/runner/repos/`. The sidebar showed confusing duplicates.
`runner-orca`'s `prepareWorkspace` always registered the host's clone and never looked for a repo Orca
already had for the project; `release` unregistered it when its last job ended, so every job
registered it again under a new repo id.

**Root cause (`missing-check`, a spec gap).** The runner brief said "isolated workspace" and ADR 0250
said "the host owns the clone; the runner never uses the owner's own checkouts". Nobody specified
"resolve the existing Orca project": that a runner on a person's machine joins the projects they
already have. The spike's finding that Orca has no `repo rm` (only `project setup-delete --force`)
was read as "clean up what you add" rather than "don't add". No test looked at Orca's repo list
across jobs.

**Fix.** [ADR 0260](../adr/0260-runners-attach-to-the-existing-checkout.md). The runner contract has a
workspace resolution rule (`canonicalRepoKey`, optional `RunnerAdapter.resolveCheckout`). `runner-orca`
finds the Orca repo whose `gitRemoteIdentity.canonicalKey` is the job's `github.com/<owner>/<repo>` and
creates the job's worktree in it. The host fetches the item branch into that checkout by URL, into
`refs/software-factory/heads/*`, with the token only in the git process's environment, and never
touches the owner's config, branches or working tree. Only when Orca has no repo for the remote does
the host clone once and register it once, for good. `release` never unregisters. On startup the host
retires a clone it registered earlier next to an owner repo, and `sf-runner doctor [--fix]` flags (and
repairs) duplicate source repos and orphaned `sf-job:` worktrees. Tests run the real adapter and host
git against a scripted Orca CLI (`local/runner-host/test/orca-workspace.test.ts`).

**What would have caught it.** A spec line for every runner adapter: *resolve existing workspaces by
canonical identity and never create a duplicate registration; per-job state is a worktree and a
branch.* It is now in `.factory/checks/runner-adapters.md`, with two checks that run in CI:
`runner-adapter-resolves-existing-repo` (the adapter must call `findRepoForJob` and never
`repoForget`; it flags the old adapter) and `runner-never-rewrites-remotes`. No
`evals/regressions/` case: like the other bootstrap incidents it has no `inc_` id, and the regression
format requires one.

## 6. The launcher overrode the harness's permission mode
**What happened.** Found on the M5 during work item #1. The runner projected
`.claude/settings.local.json` with `"defaultMode": "dontAsk"` into the job's worktree, but the job's
Claude process (pid 45141 in `sf-job-8de27aab…`) ran as `claude … --permission-mode auto`. The
runner started Claude with `orca agent launch`, which adds the owner's own Claude permission mode:
their `~/.claude/settings.json` has `"defaultMode": "auto"`. A CLI flag beats any settings file, so
the factory's mode was silently replaced. The run went ahead in the owner's auto mode, with a model
classifier rather than the stage's allowlist deciding what it could do. Nothing looked at the process
after launch, so nobody knew until someone ran `ps`.

**Root cause (`runner`: launcher override + missing post-launch verification).** Two gaps:
- **The launcher was trusted to pass the harness's config through.** The spike had already found that
  `orca agent launch` takes no agent arguments and starts Claude with the owner's own settings
  (`spikes/runner-orca` finding 7). ADR 0250 answered that with a projected settings file. It didn't
  ask what the launcher adds on top, or whether a settings file can lose to a flag (it can).
- **Nothing verified the effective configuration.** The projection was write-only: the harness
  wrote a file and assumed the process obeyed it. The same pattern hid two more launcher effects,
  found while fixing this:
  - Orca's status hooks live in the owner's user settings, and its `PreToolUse` and
    `PermissionRequest` hooks can answer permission decisions.
  - Orca's terminals add `CLAUDE_CODE_PLUGIN_DIRS`.

**Fix.** [ADR 0270](../adr/0270-the-factory-launches-the-harness-and-verifies-it.md).
- **The harness owns the invocation.** `harness-claude` writes a launch script that `exec`s
  `claude --permission-mode <mode> --setting-sources project,local --settings <run settings> --strict-mcp-config [--model …]`.
  No user settings, so the owner's config never applies. `runner-orca` runs it in a visible Orca
  terminal (`orca terminal create`), not `orca agent launch`, and answers Claude's folder trust dialog
  for the job's worktree. Orca's status hooks come with the factory's settings, without the
  permission-deciding ones.
- **Per-stage settings:**
  - build runs in `bypassPermissions` inside Claude Code's sandbox (`allowUnsandboxedCommands: false`,
    writes limited to the worktree, temp and the run's own git objects, network limited to the npm
    registry, GitHub and the Cloudflare API, deny rules on the runner key, `~/.ssh`, `~/.config/gh`,
    `~/.wrangler` and the keychains);
  - triage, spec and verify keep `dontAsk` with their allowlists, plus the sandbox;
  - `.factory/policy.json` → `harness` can pick the modes and add to the allowlists, read from the
    default branch only.
- **Verify after launch.** Before the prompt is sent, the runner compares the live process's command
  line with the launch record, and both settings copies with the projected hash. Any difference
  closes the terminal (killing Claude) and fails the job with `harness-config-mismatch`, which the
  incident classifier files as `runner`. `sf-runner doctor` runs the same check on running jobs.
- **Tests:**
  - the invocation per stage;
  - the sandbox block (never `allowUnsandboxedCommands: true`);
  - the mismatch → kill → fail path against a scripted Orca and `ps`;
  - the owner's user settings not loaded;
  - a launch script run for real and verified, then caught after its settings are edited.
- **Live run on the M5,** through the real adapter, Orca and Claude:
  - verified before the prompt;
  - `example.com` blocked, the npm registry reachable;
  - `~/.ssh` and the owner's checkout's `.env` unreadable;
  - writes to `~` refused by both Bash and the Write tool;
  - a commit in the linked worktree went through.

**What would have caught it.** A rule for every harness: *a harness must verify its effective
configuration after launch*: the flags it really runs with and the settings it really loaded,
before it does any work. It is in `.factory/checks/runner-adapters.md`, with two checks that run in
CI:
- `harness-verifies-its-launch` (a runner adapter must call `verifyLaunch` and fail with
  `harness-config-mismatch`, and must not use `agent launch`; it flags the old adapter);
- `harness-sandbox-floor` (the harness never sets `allowUnsandboxedCommands: true`, never skips
  permissions by flag, and never loads `user` settings).

No `evals/regressions/` case: like the other bootstrap incidents, it has no `inc_` id.

## 7. A factory PR that couldn't merge waited for CI that never came
**What happened.** Work item #1 (attachments) built on a branch cut from `main` at #20 (06:11).
While it built, #21, #22 and #24 landed on the same files (`harness-claude`, `runner-orca`,
`docs/parallel-work.md`, `docs/adr/README.md`). The factory opened PR #23 at 07:10:35, 30 seconds
after #24 merged, and it conflicted with `main` from the start.

GitHub runs no `pull_request` workflows on a PR it can't build a merge commit for, so the head
`510bc9d` never got an Actions check suite. The v2 Workflow waited, read CI as `missing`, failed the
packet ("no CI has reported on 510bc9d") and posted `factory/verify` red at 07:25. It then sent the
build back with that line as the thing to fix. The retry (run 6) pushed the same SHA and failed the
same way, used up `retryLimit: 2`, and opened incident item #2 ("#1 had a run that failed"),
blaming the run.

Underneath, the build had also claimed block I (ADR 0260, migrations 0070–0079) on its stale base.
#22 had already taken block I, and #26 used migration 0070, so the branch would collide on numbers
even after the conflicts were resolved.

**Root cause (`factory`: stale run branches + missing CI read as a build failure).** Three gaps:
- **Nothing kept the run branch current.** A build started from the item branch as it was when the
  item was created, and nothing merged the default branch in before the PR opened.
- **"Can't merge" looked like "no CI".** The Workflow had no idea of mergeability, and GitHub's
  silence on a conflicting PR read the same as a repo without CI.
- **A cause outside the code was given to the builder to fix.** "No CI has reported" spent build
  retries on something no commit could change.

**Fix.** [ADR 0320](../adr/0320-factory-branches-stay-mergeable.md).
- **The runner host merges the default branch into the run branch before every build.** It is
  fetched with the job token and merged as a merge commit. A conflict is left for the agent, whose
  prompt says how to resolve it. Unmerged paths at the end fail the run without a push.
- **Workflow v3 reads the PR's `mergeable`** right after it opens and on every CI read. A conflict
  sends the item back to build with an actionable note, without a verify run. The first three such
  send-backs aren't failed attempts.
- **Missing CI asks a person** (Re-check CI / Stop this work item) instead of retrying the build.
- **Tests:**
  - in the host, against a scratch GitHub: a clean merge, a conflict resolved by the session, an
    unresolved conflict, and a clean merge with and without work of the branch's own;
  - in the engine: a conflict at PR open, a conflict found while waiting for CI, a re-check after
    the no-CI question, and stop with no incident.
- PR #23 itself was unstuck by hand. `main` was merged in keeping both sides, and its ADR and
  migration were renumbered into block N.

**What would have caught it.** A rule for the Workflow: *every state a stage waits on must
distinguish "the factory can't proceed" from "the work is wrong"*, and only the second may spend a
build retry. A test of each verify wait against a PR GitHub won't run CI on (conflicting, Actions
off) would have shown both. Both now exist in `apps/engine/test/verify-flow.test.ts`.

No `evals/regressions/` case: like the other bootstrap incidents, it has no `inc_` id. Incident
item #2 can be cancelled, because its cause is fixed here.

## 8. Agents received only the tail of their prompts
**What happened.** Found with the new `sf` CLI (`sf show 1`, `sf show 2`) the day after. Every job
since #24 merged (07:15) ran on a fragment of its prompt:
- **Work item #1's last build** received only `viewer should know (optional)" }` and a closing fence,
  the last line of the build prompt's result-file footer. It asked whether the message had been cut
  off, wrote no result file, and the item used up its last retry.
- **Incident item #2's three triage runs** each said the prompt "starts mid-sentence" (`…ay ask to
  skip or require a spec`). They wrote no result, so triage failed three times.
- **Attached PR #31's triage** judged the PR from the diff alone, because the title and body never
  arrived.

Runs before 07:15 (#1's triage, spec, first build and verify) got their whole prompts.

**Root cause (`runner`: the prompt's transport).**
- **The transport changed.** #24 (ADR 0270) stopped launching Claude with `orca agent launch --prompt`.
  The runner now starts the harness's own command in an Orca terminal, verifies the live process, and
  then types the prompt with `orca terminal send --text <prompt> --enter`. A multi-kilobyte prompt
  typed into the Claude terminal arrives with only its tail.
- **Nothing checked what arrived.** The adapter's tests covered the order (send after verify) but
  not what the agent received. In production, what it received was a fragment.

**Fix.**
- **The prompt travels as a file.** The adapter writes `job.harness.prompt` to `.factory-prompt.md`
  in the job's worktree, excluded from git like `.factory-result.json` (`PRIVATE_WORKTREE_FILES`).
- **The terminal gets one short line,** harness-claude's `PROMPT_POINTER`: "Your instructions for
  this job are in .factory-prompt.md at the repository root. Read the whole file first, then follow
  it exactly."
- The live-process check still runs before the pointer is sent.
- **Test:** the terminal receives only the pointer, the file holds the prompt exactly, and the file
  is excluded from git.
- **Rolling it out:** the M5's runner must be updated (`git pull`, then `sf-runner install` when no
  job is running) for this to take effect.

**What would have caught it.** Two things:
- **A rule:** never type a job's prompt into a terminal; send it as a file. It is in
  `.factory/checks/runner-adapters.md`, with `runner-sends-the-prompt-as-a-file.json`, which flags
  the old adapter.
- **A smoke check:** the factory reading back what an agent was given. Whenever an agent's summary
  says its message was cut off, the run should fail as `runner`, not as the build. That isn't built
  yet.

## 9. runner-local's agents couldn't read their own worktree
**What happened.** On 2026-11-12, the first live runs on the M5 after switching it to `runner-local`
(PR #40, spec 30). Work item #6's three triage runs each ended in about 20 s. Claude said it
couldn't read `.factory-prompt.md`: "the Read tool refused the path because the directory is denied
by the permission settings", and a `cat` through Bash was denied too. With no result file, triage
failed three times, and the factory opened incident #7, whose triage then hit the same wall. The
tmux session, the launch check, the prompt pointer and the status hook all worked.

**Root cause (`runner`: workspace location).**
- **Where the worktree went.** runner-local put job worktrees in
  `~/.local/state/software-factory/runner/worktrees`.
- **What the harness denies.** harness-claude denies every stage reads of
  `~/.local/state/software-factory` (`DENY_HOME`: the runner's key, runs and clones).
- Under Orca, worktrees lived in Orca's workspace folder, so the two rules never met.
- The adapter's tests run with temp dirs, and the real-tmux test uses a stand-in `claude` that
  doesn't enforce deny rules, so nothing exercised them together.

**Fix.**
- **Moved the agent's dirs.** Worktrees and attachments now live under the data dir
  (`$XDG_DATA_HOME` or `~/.local/share/software-factory/runner`).
- **What stays denied.** The key, run dirs and clones stay where they were, still denied.
- **Test.** `local/runner-host/test/paths.test.ts` checks that the agent's own dirs are under no
  `DENY_HOME` path and that the private ones still are.

**What would have caught it.** A smoke run of a real `claude` against the projected settings before
the adapter shipped. That's spec 30's criteria 1–2, which this incident is how we met.

## Follow-ups (not done here)
- ~~Add the spec-template rules from 1 and 3 when the stage-spec template is next touched.~~ Done
  with the onboarding rebuild (below).
- Add the agent-context line from 2 and the check from 3 under `.factory/` (only `policy.json` exists so far, #17).
- Add a post-deploy setup smoke step (2) to `docs/deploying.md`.

## The lesson, and the rebuild (2026-11-11, branch `onboarding-connect-github`)
All four incidents share a root: Setup exposed the factory's plumbing (a typed owner/repo/branch, an
installation id nobody can find, a "Detect installation" button, a manual "Sync policy", a runner key
to copy) instead of fetching what it needed. The owner's verdict: "weird, I've never seen a process
like this." The rule, for every setup or onboarding screen from now on:

> **Onboarding must never ask users for ids the system can fetch.**

What replaced it ([ADR 0055](../adr/0055-github-installations-are-org-records.md),
[ADR 0056](../adr/0056-runner-device-login.md)): **Connect GitHub** through GitHub's own install flow
(a single-use state, the installation verified as the App and against the person), a **repo picker**
over what the installation reaches (`project.create` refuses an unreachable repo, so no half-broken
projects), the **policy syncing itself** on create and on every push (with a **Create policy PR**
button when there is none), **`sf-runner login`** with a code approved in the app, and Setup as a
**checklist** with live state. The existing `software-factory` project is linked to its installation
automatically when GitHub is connected.

The rule is in the spec template ([`docs/specs/README.md`](../specs/README.md)) as an acceptance
criterion for any setup screen, next to the rules from incidents 1 and 3.

