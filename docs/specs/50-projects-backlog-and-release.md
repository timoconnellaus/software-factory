# Spec 50: Projects, repositories, backlog and release (the work model)

Read first: ADRs [0490](../adr/0490-a-project-is-not-a-repository.md),
[0491](../adr/0491-work-starts-in-a-backlog-and-is-released.md) and
[0492](../adr/0492-a-project-runs-one-workflow.md); spec [09](09-factory-config-in-the-app.md) M2
(workflows, ADR [0371](../adr/0371-workflows-are-presets-over-typed-slots.md)); ADRs
[0040](../adr/0040-web-push-and-wip-backpressure.md) (WIP backpressure),
[0370](../adr/0370-factory-config-lives-in-the-app.md) (config versions),
[0055](../adr/0055-github-installations-are-org-records.md) (installations) and
[0330](../adr/0330-the-factory-runs-its-own-merge-queue.md) (merge queue). Code:
`packages/db/migrations`, `packages/core/src/scope.ts`, `packages/core/src/operations/{projects,shared,work-items}.ts`,
`apps/engine/src/workflow/work-item.ts`.

The owner approved the model in this spec. A later task rebuilds the desktop screens on top of it;
this one changes data and operations only.

## Goal
Work is organised as **org → project → work item → run**, and people decide when work enters the
factory.

- A **project** is a body of work, not a repository. It has zero or more **repositories** (a
  Marketing project may have none) and runs **one workflow**.
- A work item starts in the **backlog**, is shaped to **ready**, and is **released** to the factory
  (**queued**). The factory pulls queued items into the pipeline by priority, respecting "waits for"
  links and the project's limit on active items.

## What main has today
- `core_projects` is a GitHub repository (owner, name, default branch, installation, repo id,
  policy PR) plus the project's identity (name, slug, item numbers) and its config version
  (`policy_sha`). Ids `prj_…` are everywhere: work items, config versions, protection, merge queue,
  trials, kill switches, the app's URLs, the CLI and the desktop app.
- Workflows (ADR 0371) are defined in each project's config version; triage picks one per work item
  and `workItem.setWorkflow` lets a person change it before build.
- `workItem.create` creates the item and starts its Workflow in the same batch (`createWorkItem` in
  `operations/shared.ts`, used by `workItem.create`, `workItem.attachPr` and `incident.open`).
- The WIP limit (`wipLimit`, ADR 0040) holds **builds** while that many items wait at human gates.
  Nothing limits how many items are in the pipeline.

## Part A: projects and repositories (PR A)
Nothing changes for a user.

- **Migration 0260** (`0260_repositories.sql`):
  - `core_repositories`: `id` (`repo_…`), `org_id`, `project_id`, `owner`, `name`,
    `default_branch`, `github_installation_id`, `installation_record_id`, `github_repo_id`,
    `policy_pr_url`, `created_at`, `created_by`; unique `(owner, name)` (a GitHub repository belongs
    to one project in one org, as today).
  - Backfill: **one repository per existing project**, with the project's repo columns. Its id is
    `repo_` + the project id's hex, so it is deterministic and a test can predict it.
  - **Additive only.** The repo columns stay on `core_projects` for this release: the code deployed
    before it reads them until the Worker deploy lands, and a failed deploy must leave production
    working. Nothing reads them from this release on; `project.create` still writes them as a mirror
    (a project with no repository writes `''` and its own id, to keep their UNIQUE). A later
    migration, once this code is live, backfills a repository for any project created in that gap
    and drops the columns (a rebuild: see 0261 on copying aside the rows of cascading tables).
  - `core_work_items.repository_id` (nullable), backfilled with the project's repository, with
    indexes on `(repository_id, pr_number)` and `(repository_id, head_sha)`.
  - `core_verify_checks.repository_id`, backfilled: `factory/verify` per head SHA is per repository.
- **Lookups by repository.** Everything that finds a work item from a webhook keys it by the
  repository, never by the project alone: `verify.refresh` by `(repository_id, pr_number)` and
  `(repository_id, head_sha)` (so closing B#5 never touches A#5), the push check by
  `(repository_id, number)`. A job's repository is the item's, else the project's only one
  (`itemRepository`, the same rule in the engine's Workflow); a claim checks it before anything is
  claimed, and an item with none waits with the reason instead of blocking the queue. The Workflow
  fails rather than assume a default branch.
- **Scope** (`resolveScope`) gains `repository`: the work item's repository; else the input's
  `repositoryId`; else the project's repository when it has exactly one; else null. Both the
  batched and the unbatched paths, still one D1 round trip.
- **`requireRepository(ctx)`** refuses `not_found` with "this project has no repository" or
  "this project has N repositories: name one (`repositoryId`)". `repoRef(ctx, repository)` takes a
  repository row. Every caller that read repo fields off the project now reads them off the
  repository: GitHub reads, verify, the review packet, the merge queue, protection, attach, runner
  jobs (`job.repo`), the connector's webhook lookups (`projectForRepo` now finds the repository and
  returns its project), onboarding's installation reconciling, the desktop's merge wording and the
  engine's Workflow and cron queries.
- **Operations**:
  - `project.create` keeps its input and output. With `installationRecordId` and `repoId` it creates
    the project **and** its first repository (today's Setup). Without them it creates a project with
    no repository (refused today: both become optional, but given together or not at all).
  - `repository.add { projectId, installationRecordId, repoId }` (admin): adds a repository to a
    project **with none**, with the same checks as `project.create` (the installation is the org's
    and active, GitHub reaches the repo, it isn't already a repository anywhere). A second
    repository is refused until protection is tracked per repository (below).
  - `repository.list { orgId, projectId? }` (member, read): repositories with their connection.
  - `repository.update { repositoryId, githubInstallationId?, detectInstallation?, defaultBranch? }`
    (admin): today's `project.update` fix, per repository. `project.update` keeps its input and
    changes the project's repository (`repositoryId` when it has several).
  - The project view (`project.list`, `project.create`, `setup.status`) keeps `repo` (the project's
    first repository, now `null` for a project with none) and adds `repositories`.
  - Operations that act on one repository (`policy.resync`, `protection.*`, `github.openPullRequests`,
    `workItem.attachPr`, `workItem.previewRouting`) accept an optional `repositoryId`, needed only
    when the project has more than one.
- **Which repository a work item uses.** It is chosen when the item is created (`repositoryId` on
  `workItem.create`; the project's repository when it has exactly one) and can be changed with
  `workItem.update` until the item is pulled. An attached PR and an incident take the repository
  they are about. After the pull it is fixed: the item's branch, PR, runs and merge-queue entry
  belong to that repository. A project with several repositories and an item that names none can
  sit in the backlog and be shaped; release refuses it when its workflow needs a repository (part
  B). Triage picking the repository, and one item changing several repositories, are out of scope.
- **Config versions with several repositories or none.** Config stays per project (ADR 0370): one
  version history, whatever the repositories. A new project starts from the template. Importing
  `.factory/policy.json` (`policy.resync`, and `project.create`'s first read) reads the default
  branch of one repository: the one being added by `project.create`, else the `repositoryId` given,
  else the project's only repository. A project with no repository can't import; it edits its config
  in the app. Adding a second repository never changes the config. Repository-specific settings in
  the config (harness profile, protection `onRed`) apply to every repository of the project.
- **The merge queue is per repository**: entries stay in `core_merge_queue` (keyed by project), and
  the head, positions and the next wake are computed among the items of the same repository, since
  each lands on its own repository's default branch.
- **Protection stays per project for now**, so **a project has at most one repository**
  (ADR 0490 §8): `core_project_protection`, the build hold on red and the daily re-check are per
  project, and a second repository's default branch would be unguarded with Setup green.
  `repository.add` refuses a second one with that reason. Everything else already keys by
  repository, so per-repository protection (and Setup showing every repository) is the one change
  that lifts the limit. The same follow-up rekeys `core_verify_checks` from `(project_id,
  head_sha)` to `(repository_id, head_sha)`: it can't change now, because code deployed before
  0260 upserts on the old key during the deploy.

## States and stages: what is fixed and what belongs to the workflow
Two separate things, which the schema and the operations keep apart:

1. **Work-management states**, fixed, the same for every item whatever its workflow:
   `backlog` → `ready` → (release) → `queued` → *(the workflow runs)* → `done`, with the endings
   `failed`, `rejected` and `cancelled`. While the workflow runs the item's status says only whether
   it is moving: `running`, `waiting` (on a person or an event) or `paused` (a kill switch), and,
   before release, `shaping` while the workflow's shaping stages run (part C). These
   are `core_work_items.status` (a CHECK), `ITEM_STATUSES`, the board read's states and counts, and
   the operations that move between them (`workItem.create/update/move/release/link`,
   `queue.pull`, `workItem.cancel`). None of them names a software stage.
2. **Stages**, which belong to the **workflow**. Triage, spec, build, verify, review and merge are
   the **Software** workflow's stages, not universal ones: a Marketing workflow might draft, review
   and publish. A workflow's stages fall in two **phases** with release between them: **shaping**
   stages (they need a person, hold no build slot and don't count as active) and **delivery**
   stages. They are `core_work_items.stage` (free text since 0261), `core_stages` (free text) and
   the board's `stage` field (a string).
   - **Interview planning is one stage type**, not a universal state. How it runs is the workflow's
     setting: whether it is required and from what size (today `spec.requiredFrom`), which agent
     runs it, and who approves the plan (today the spec gate and its approvers).

**Known limits** (because the engine's skeleton is fixed code, ADR 0371): the stages a workflow can
use today are the skeleton's (`intake`, `triage`, `spec`, `build`, `verify`, `merge`, `done`; the
operations validate against `STAGES`); `core_jobs.stage` and the planning tables keep CHECKs on the
job kinds the runner contract knows (`triage`, `spec`, `planning`, `build`, `verify`); planning's
settings live in config fields the skeleton reads (`spec.requiredFrom`, approvers) rather than in a
workflow definition; and every workflow is assumed to need a repository
(`workflowNeedsRepository`). Workflow-defined stages and per-workflow planning settings are the
same follow-up as org-level workflows (out of scope below): the work-management states and the
operations in this spec don't change for them, and only the job-kind CHECKs would need a migration.

## Part B: backlog, ready, queued (PR B)
- **Migration 0261** (`0261_backlog.sql`):
  - `core_work_items.status` gains `backlog`, `ready`, `queued` and `shaping` (the CHECK is
    rebuilt, as in 0080; `shaping` is used from part C). `stage` stays `intake` until the item is
    pulled. The rebuild drops `stage`'s CHECK: stages are the workflow's (below), so a
    workflow-defined stage needs no migration; the operations still validate it.
  - New columns: `priority` (0 urgent, 1 high, 2 normal, 3 low; default 2), `rank` (REAL, the
    order within a priority; lower first), `acceptance_criteria` (JSON, set while shaping),
    `released_at`, `released_by`, `pulled_at`. Existing items are left as they are: they are
    already in the pipeline.
  - `core_work_item_links (work_item_id, waits_for_id, created_at, created_by)`, primary key on the
    pair, both items in the same org, any project.
  - Index for the pull: `(project_id, status, priority, rank)`.
- **States.** `backlog` → `ready` → `queued` → the pipeline (`running`, `waiting`, `paused`) →
  `done` / `failed` / `rejected` / `cancelled`. Nothing runs in the first three: no Workflow
  instance exists until the pull.
  - **Backlog**: captured. Title, notes (body), project, priority, optionally a repository.
  - **Ready**: shaped. Size and acceptance criteria may be set; planning and a cheap triage pass are
    allowed here later (out of scope for this spec beyond the state itself).
  - **Queued**: released, waiting for a slot.
- **Operations** (all `workItem.*`, member unless noted):
  - `workItem.create` gains `state: "backlog" | "ready" | "queued"` (default `backlog`),
    `priority`, `repositoryId` and `waitsFor` (item ids). **Creating no longer starts the
    pipeline.** `state: "queued"` is the one-step **create and release**: it runs the release rules
    below and then the pull, in the same call, so an item with room starts at once exactly as today.
    New work in the app, `sf new` and the runner e2e pass `queued`.
  - `workItem.attachPr` and `incident.open` keep starting at once: an attached PR skips the backlog
    (it is already built), and an incident is the factory's own fix. Both are created `queued` and
    pulled in the same call; neither is held by the active-item limit (they never were).
  - `workItem.update { workItemId, title?, body?, priority?, repositoryId?, size?,
    acceptanceCriteria? }`: only before the pull; the repository only in backlog or ready (release
    checked it).
  - `workItem.move { workItemId, to: "backlog" | "ready" }`: between backlog and ready, and from
    queued back to ready (un-release) before the pull.
  - `workItem.reorder { workItemId, before?: workItemId, after?: workItemId }`: sets `rank` between
    two neighbours in the same project; when the gap runs out of precision, the project's ranks are
    renumbered 1, 2, 3… in their current order first.
  - `workItem.release { workItemId }` (`backlog` or `ready` → `queued`), then the pull for the
    item's project.
  - `workItem.link { workItemId, waitsFor }` / `workItem.unlink { workItemId, waitsFor }`: same
    org, not itself, no cycle (refused `conflict`), only while the item isn't pulled. The cycle
    check is repeated inside the insert, so two links made at once can't close a cycle.
- **Release rules** (in code, `releaseRefusal()`):
  1. The item is in `backlog` or `ready` (else `conflict`).
  2. The project has a valid config (else `unavailable`, as `workItem.create` today).
  3. **`workflowNeedsRepository(policy, workflow)`** decides whether the item's workflow needs a
     repository. Today it is true for every workflow (the skeleton always builds code). When it is
     true and the item has no repository, release refuses (`conflict`, naming the fix).
  4. **Who may release.** A person (`human`, member) always may. Anyone else (`agent`, `intake`,
     a chat agent later) only when the project's config has `release.agents: true`; otherwise
     `denied`. `release.agents` defaults to `false`. Turning it on is a **loosening** in
     `policyImpact`, so it is a human-only change through `config.save` (ADR 0370, 0373).
  - The incident and attached-PR paths are code paths, not `workItem.release` calls, and are not
    governed by rule 4.
- **The pull** (`pullQueued` in core, run only by `queue.pull { projectId }`):
  - A project's **active items** are those in `running`, `waiting` or `paused`. The config's new
    `activeLimit` (default 10, at most 100) caps them. Raising it is `neutral`, like `wipLimit`.
  - While active < `activeLimit`, pull the next queued item of the project that has its repository
    (when its workflow needs one) and whose every "waits for" item is `done`, by `priority`, then
    `rank`, then `released_at`. Pulling sets `status = running`, `pulled_at`, pins the config
    version in force (`policy_sha`; for an item joining a running trial, the trial's candidate, ADR
    0373) and **that version's** `workflow`, writes the intake stage and emits `workflow.create`.
    An item that sat in the backlog for a month runs on the config in force when it starts.
  - **Never inside another call's batch.** Release, create-and-release, finish and cancel emit a
    `queue.pull` outbox message; the engine delivers it right after their commit and runs the pull
    in its own batch. So a pull that loses a race aborts only itself, never a finish (which would
    record a merged item as failed), a cancel or New work.
  - **One start, one conditional write.** Each start is an UPDATE that re-checks, in the same
    statement, that the item is still queued, the project is still under `activeLimit` (a count
    subquery), it has its repository and nothing it waits for is undone; anything else aborts the
    pull's batch. D1 runs write batches one at a time, so two pulls can't both take the last slot.
  - **The scheduler actor.** `queue.pull` is run only by `scheduler` (a new actor type): read and
    write in every shipped autonomy policy, nothing else. It starts only work that was already
    released, so it is never a reviewable decision; under `cautious` it doesn't open an approval a
    minute. A floor that sends its writes to review still applies; the engine then skips a project
    while its pull approval is pending.
  - A kill switch on the org or project holds the pull.
  - Runs: after release, create-and-release, finish (its own project, and the projects with queued
    work waiting on it when it is done) and cancel; and from the engine's minute cron, which asks
    only for projects where something can start now (a queued item with its waits-for done, under
    the config's `activeLimit`), oldest released work first, so a project with nothing to start
    costs no call and no audit row.
  - `wipLimit` keeps its meaning (ADR 0040): builds wait while that many items wait at gates.
- **Existing projects on deploy** (migration 0261, ADR 0492): a project whose config defines
  exactly one workflow gets a new config version (`source: migrated`) naming it, so its new items
  keep that workflow's gate steps. A project whose config defines several and names none **fails
  closed**: release is refused with the reason, the pull starts nothing, and Setup's config step
  says to choose the project's workflow. Items started before 0261 (no `pulled_at`) keep triage's
  pick, as ADR 0371 promised them.
- **The workflow comes from the project** (ADR 0492). The config gains `workflow` (a workflow name
  or null). An item records its project's `workflow` when it is pulled. Triage no longer picks: its `workflow` field is ignored and the Workflow's
  `workflow: options` step returns none. `workItem.setWorkflow` is refused (`conflict`, "an item
  follows its project's workflow"). Changing `workflow` in config compares the gate steps of the
  old and new workflow in `policyImpact`: removing a gate step is a loosening.
- **Reads the UI will need**:
  - `workItem.board { orgId, projectId?, states? }`: items in the given states (default backlog,
    ready, queued and active), each with priority, rank, repository, `waitsFor` (id, number, title,
    status) and `blockedBy` (the waits-for items not done), ordered as the pull would take them;
    and `counts` per project and state, across the org, including done and the terminal states.
    At most 500 items.
  - `workItem.get` gains `priority`, `repository`, `waitsFor`, `waitedOnBy`, `releasedAt`,
    `releasedBy`.
  - The status enum in reads (`workItem.list`, `inbox.list`, …) includes the three new states.

## Part C: shaping stages run before release (PR C, Workflow v7)
Decided by the owner (2026-11-12), ADR [0493](../adr/0493-shaping-stages-run-before-release.md). A
workflow has two phases with release between them: **shaping** stages (they need a person, hold no
build slot and don't count as active) and **delivery** stages. Only the backlog, the release and
done are the same for every item; interview planning is one stage type, not a universal state. The
full stage-type model (a workflow as an ordered list of typed stages with their own settings) is its
own spec; this part fits today's fixed engine to it.

- **Phases of today's stages** (`STAGE_PHASE` in core): triage and interview planning (the spec
  stage and its gate) are **shaping**; build, verify, the merge gate and the merge queue are
  **delivery**. `workItem.board` returns each item's `phase`.
- **`workItem.shape { workItemId }`** (a person, `member`): starts the item's Workflow from backlog or
  ready, with release's preconditions (valid config, a chosen workflow, a repository when the
  workflow needs one). The item's status becomes **`shaping`** (a fixed work-management state:
  "its workflow's shaping stages are running"); `shaping_started_at` is set (migration **0262**). It
  holds no build slot and doesn't count against `activeLimit`; its triage and planning jobs run on
  the light pool. Statuses the shaping stages would set elsewhere (`waiting` on questions) leave a
  shaping item `shaping`.
- **Workflow v7**: the v6 steps, then **`release: check`**. Already pulled (released straight from
  the backlog): go on, exactly as v6. Shaped: **`release: shaped`** (`workItem.shaped`: status
  `ready`, "shaped: release it to build", the requester notified), then **`release: wait #k`** for
  `release-<item>`, re-checking `pulled_at` on each 12-hour timeout (**`release: check #k`**), then
  delivery from `workflow: plan` on. v1–v6 replay unchanged.
- **Release and the pull**: a shaped, ready item is released like any other. When the pull starts
  it, it pins delivery's config version and workflow and sends `release-<item>` instead of creating
  a Workflow (`startPipeline`).
- **Small items need no shaping**: released from the backlog, their Workflow runs triage and, when
  the size needs it, planning inside delivery, as today.
- **A shaped item is released or cancelled**: `workItem.move` to the backlog and changing its
  repository are refused once shaping started. Cancelling it terminates its Workflow, runs and
  gates. A spec rejected while shaping ends the item `rejected` (`workItem.finish` accepts
  `shaping`).
- **A shaped plan is fixed.** Once shaping starts, `workItem.update` refuses everything but the
  priority (delivery builds what was planned: cancel and capture again to change it). The item's
  workflow is the one `workItem.shape` pinned: triage's pick is ignored while shaping, as at any
  time (only items from before 0261, never pulled and never shaped, keep triage's pick).
- **A stale plan is visible, not silent.** `workItem.shaped` records when shaping finished and the
  default branch's head then (`shaped_at`, `shaped_base_sha`). Releasing a shaped item returns
  `plan { shapedAt, baseSha, behindBy }` (the commits the default branch gained since), and
  `workItem.get` returns `shaping { startedAt, shapedAt, baseSha }`. Release re-checks the config in
  force: if the item's size now needs a plan it was shaped without, release is refused with the
  reason. After the release the Workflow re-reads the item and its config as the pull pinned them
  (`release: meta`), so delivery never runs on what was journaled at shaping time.
- **Shaping can't crowd out delivery.** The config's `shapingLimit` (default 5) caps the items
  shaping at once per project (lowering it tightens). The scheduler claims released work's jobs
  before shaping items' jobs, on runners with or without a light pool. A kill switch refuses
  `workItem.shape` and pauses shaping Workflows like any other (the item stays `shaping`).
- **A dead Workflow fails the item, visibly.** If a shaped item's Workflow ended (errored,
  terminated) while it waited, the release event finds nobody: the engine ends the item `failed`
  with the reason, so it never holds a slot.
- **Known limits** (the fixed engine): the shaping stages are exactly triage and interview planning;
  whether planning runs is still triage's size against `spec.requiredFrom`; only a person may shape;
  shaping can't be undone except by cancelling. A shaped item waits with one wait step and one check
  step per 12 hours, so on the Workers free plan's step limit an instance can wait about 250 days;
  past that it errors and its release fails visibly (above). Per-workflow stages and phases are the
  stage-type spec's.
- **No screen calls `workItem.shape` yet**: today it is reached through the operations (MCP, the
  CLI's `sf call`). Shaping in the desktop UI (shape, the plan's age at release) is the next UI
  slice.

### Acceptance criteria (part C)
11. `workItem.shape` starts the Workflow of a backlog or ready item without using a slot: another
    item can start in the project's only slot while it shapes.
12. A shaped item runs triage (and planning when its size needs it) before release, becomes ready,
    and doesn't build until it is released and pulled; then it goes straight to build without a
    second triage.
13. An item released straight from the backlog runs exactly as v6.
14. Cancelling a shaping item stops its Workflow; shaping twice and moving a shaped item back are
    refused.

## Out of scope
Screen changes beyond what keeps today's screens working, chat, issue intake, the reconciler, triage
choosing a repository, items spanning several repositories, per-repository protection verdicts and
merge queues (follow-up above), 
**moving workflow definitions to the org** (follow-up spec: workflows defined once per org and
chosen by projects; it changes ADR 0370's per-project config versions and the loosening checks, so
it gets its own spec and ADR).

## Acceptance criteria
1. Migration 0260 on a database with projects gives each exactly one repository with the same
   owner, name, default branch, installation and repo id, and each work item and verify check that
   repository; no project id changes, every project's config version is unchanged, and
   `PRAGMA foreign_key_check` is clean (test against real D1).
2. Every existing flow behaves as before for a one-repository project: Setup, New work, attach,
   verify, the merge queue, protection, the runner's job repo, the webhook lookups (the existing
   suites pass with only setup-helper changes).
3. A project can be created with no repository and given one; a second repository is refused
   with the reason; the code paths that must key by repository (webhooks, verify, jobs, tokens, the
   merge queue) are tested with two repositories inserted directly.
4. `workItem.create` without `state` leaves the item in `backlog` with no Workflow instance and no
   stage beyond intake; `state: "queued"` starts it at once when the project has room.
5. Release refuses an item that isn't in backlog or ready, an item without a repository when its
   workflow needs one, and an agent when the config doesn't allow agent release; it allows the
   agent when `release.agents` is true; turning `release.agents` on through `config.save` is a
   loosening.
6. The pull takes queued items by priority, then rank, then release time; never more than
   `activeLimit` active items; skips an item whose waits-for item isn't done and takes it once that
   item is done (also across projects, through `queue.pull`).
7. `workItem.link` refuses a cycle, an item in another org and an item that's already pulled.
8. Attached PRs and incidents start at once whatever the backlog and the active limit.
9. A new item takes its project's `workflow`; triage's pick is ignored; `workItem.setWorkflow` is
   refused.
10. `workItem.board` returns the items in pull order with `blockedBy`, and counts per project and
    state across the org.
