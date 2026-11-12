# Spec 50: Projects, repositories, backlog and release (the work model)

Read first: ADRs [0440](../adr/0440-a-project-is-not-a-repository.md),
[0441](../adr/0441-work-starts-in-a-backlog-and-is-released.md) and
[0442](../adr/0442-a-project-runs-one-workflow.md); spec [09](09-factory-config-in-the-app.md) M2
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

- **Migration 0210** (`0210_repositories.sql`):
  - `core_repositories`: `id` (`repo_…`), `org_id`, `project_id`, `owner`, `name`,
    `default_branch`, `github_installation_id`, `installation_record_id`, `github_repo_id`,
    `policy_pr_url`, `created_at`, `created_by`; unique `(owner, name)` (a GitHub repository belongs
    to one project in one org, as today).
  - Backfill: **one repository per existing project**, with the project's repo columns. Its id is
    `repo_` + the project id's hex, so it is deterministic and a test can predict it.
  - `core_projects` is rebuilt without the repo columns (`repo_owner`, `repo_name`,
    `default_branch`, `github_installation_id`, `installation_record_id`, `github_repo_id`,
    `policy_pr_url`). Project ids, names, slugs, numbers and config versions are unchanged, so every
    `project_id` elsewhere stays valid. Foreign keys are deferred for the rebuild, as in 0080.
  - `core_work_items.repository_id` (nullable), backfilled with the project's repository.
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
    project, with the same checks as `project.create` (the installation is the org's and active,
    GitHub reaches the repo, it isn't already a repository anywhere).
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
- **Per-repository state that stays keyed by project** (correct while a project has one repository,
  which is every project after the backfill): the protection verdict (`core_project_protection`)
  and the merge queue. Both get a `repository_id` in a follow-up before multi-repository projects
  are offered in the UI; until then `repository.add` on a project that already has one is allowed
  through the API only, and the spec's tests cover it.

## Part B: backlog, ready, queued (PR B)
- **Migration 0211** (`0211_backlog.sql`):
  - `core_work_items.status` gains `backlog`, `ready`, `queued` and `planning` (the CHECK is
    rebuilt, as in 0080; `planning` is used from part C). `stage` stays `intake` until the item is pulled.
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
    acceptanceCriteria? }`: only before the pull.
  - `workItem.move { workItemId, to: "backlog" | "ready" }`: between backlog and ready, and from
    queued back to ready (un-release) before the pull.
  - `workItem.reorder { workItemId, before?: workItemId, after?: workItemId }`: sets `rank` between
    two neighbours in the same project.
  - `workItem.release { workItemId }` (`backlog` or `ready` → `queued`), then the pull for the
    item's project.
  - `workItem.link { workItemId, waitsFor }` / `workItem.unlink { workItemId, waitsFor }`: same
    org, not itself, no cycle (refused `conflict`), only while the item isn't pulled.
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
- **The pull** (`pullQueued(ctx, projectId)` in core, and `queue.pull { projectId }`, foreman only,
  for the cron):
  - A project's **active items** are those in `running`, `waiting` or `paused`. The config's new
    `activeLimit` (default 10, at most 100) caps them. Raising it is `neutral`, like `wipLimit`.
  - While active < `activeLimit`, pull the next queued item of the project whose every "waits for"
    item is `done`, by `priority`, then `rank`, then `released_at`. Pulling sets `status = running`,
    `pulled_at`, pins the project's current config version (`policy_sha`, and a running trial, ADR
    0373) and its `workflow`, writes the intake stage and emits `workflow.create` (what
    `createWorkItem` did at creation). An item that sat in the backlog for a month runs on the config
    in force when it starts, not the one when it was written down. A queued item that waits on something not done stays queued; the read says why.
  - A kill switch on the org or project holds the pull.
  - Runs: inside `workItem.release` and `workItem.create { state: "queued" }`; after
    `workItem.finish` and `workItem.cancel`; and from the engine's minute cron for every project
    with queued items (the "waits for" item may be in another project).
  - `wipLimit` keeps its meaning (ADR 0040): builds wait while that many items wait at gates.
- **The workflow comes from the project** (ADR 0442). The config gains `workflow` (a workflow name
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

## Part C: planning before release (PR C, Workflow v7)
Raised by the owner after part B was written: planning (the live session with questions, spec 20) is
not a pipeline stage after Queued. **Planning is how an item gets from Backlog to Ready**, and the
spec gate is that transition. Release stays a separate, later decision.

States: `backlog` → `planning` (optional: by size, or on request) → `ready` (the plan approved at the
spec gate, or no plan needed) → `queued` (released) → build → verify → merge gate → merge queue →
`done`.

What it changes:
- **`planning` is a status** (added to the CHECK by migration 0211 already, so part C needs no table
  rebuild). Items in it are not active: they don't count against `activeLimit`, and their jobs run on
  the light pool (ADR 0301) as planning does today. No commitment to build.
- **When the Workflow instance starts.** Either when planning starts (`workItem.plan { workItemId }`,
  a person's call, or automatically on entering `ready` for items triage sizes at or above
  `spec.requiredFrom`), or at the pull for an item that never planned. One instance per item, as now
  (ADR 0006); the instance id stays the item id.
- **Workflow v7** (new version; v1–v6 replay unchanged and v7's step names are frozen in
  `workflow-versions.test.ts`):
  1. triage → spec stage (the planning session) → spec gate → `spec: commit`, exactly as v6, while
     the item is `planning`;
  2. then a new step, **`release: wait`**: the item becomes `ready` and the instance waits for the
     event `release-<item>` (in a loop of bounded `waitForEvent` timeouts, like the gate waits). No
     job or slot is held while it waits;
  3. the pull, finding a queued item that already has an instance, sends `release-<item>` instead of
     `workflow.create`; the instance pins the config version current at that moment, records the
     project's workflow (`workflow: plan`), and goes on to the slots, build, verify and the merge
     gate as v6 does.
  - An item released straight from the backlog (New work, `sf new`) has no instance; the pull creates
    one, and v7 runs triage and, when the size needs it, planning **after** release, as today: the
    `release: wait` step is a no-op for an item already released. Its planning then counts as active.
  - Requesting changes at the spec gate keeps the item in `planning` (same session, as today); a
    rejected spec ends the item as `rejected`, as today.
- **Moving back.** `workItem.move { to: "backlog" }` from `planning` or `ready` ends the planning
  session and terminates the instance; the approved spec stays on the item, and planning again
  starts a new instance with a new id suffix (`<item>-p<n>`), so instance ids stay unique.
- **The cheap triage pass in Ready** is v7's triage step: it runs when planning starts, never on
  capture.

Part C is staged after part B because it is a Workflow version: B ships the states, release, the
pull and the links with planning still after the pull (v6 unchanged), and C moves planning ahead of
release.

## Out of scope
Screen changes beyond what keeps today's screens working, chat, issue intake, the reconciler, triage
choosing a repository, items spanning several repositories, per-repository protection verdicts and
merge queues (follow-up above), planning and triage in `ready` (only the state exists), and
**moving workflow definitions to the org** (follow-up spec: workflows defined once per org and
chosen by projects; it changes ADR 0370's per-project config versions and the loosening checks, so
it gets its own spec and ADR).

## Acceptance criteria
1. Migration 0210 on a database with projects gives each exactly one repository with the same
   owner, name, default branch, installation and repo id, and each work item that repository; no
   project id changes and every project's config version is unchanged (test against real D1).
2. Every existing flow behaves as before for a one-repository project: Setup, New work, attach,
   verify, the merge queue, protection, the runner's job repo, the webhook lookups (the existing
   suites pass with only setup-helper changes).
3. A project can be created with no repository; a second repository can be added; an operation
   that needs a repository on a project with two and no `repositoryId` is refused with the reason.
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
