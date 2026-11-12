# ADR 0490: A project is not a repository

Status: accepted, 2026-11-12. Spec [50](../specs/50-projects-backlog-and-release.md) part A. Amends
[ADR 0055](0055-github-installations-are-org-records.md) and the **Project** entry in `CONTEXT.md`;
builds on [ADR 0370](0370-factory-config-lives-in-the-app.md).

## Context
Since V1 a project has been one GitHub repository: `core_projects` holds the repo's owner, name,
default branch and App installation next to the project's name, item numbers and config version. The
owner's work model is org → project → work item → run, where a project is a body of work (a product,
a launch, Marketing) that may touch several repositories or none. The project's id is referenced by
every work item, config version, trial, protection verdict, merge-queue entry, kill switch, app URL,
CLI command and the desktop app.

## Decision
1. **A repository is its own record.** `core_repositories` holds what was the repo half of a project:
   owner, name, default branch, installation, GitHub repo id, the template-policy PR. A repository
   belongs to one project; a GitHub repository is in at most one project.
2. **Project ids stay.** Migration 0260 keeps each existing `core_projects` row as the project and
   copies its repo columns to one backfilled repository (`repo_` + the project id's hex). This is the
   least disruptive direction: no `project_id` anywhere changes, so work items, config versions,
   URLs and the clients keep working. (The alternative, keeping the rows as repositories and creating
   new projects, would re-point every `project_id`.)
3. **A project has zero or more repositories.** A workflow uses one when a stage needs code. A
   project with none is valid (Marketing); its items can be captured and shaped, and release is
   refused only when the item's workflow needs a repository (ADR 0491).
4. **A work item uses one repository**, chosen at creation (the project's only one by default, else
   named) and changeable until it is pulled. After that its branch, PR, runs and merge-queue entry
   belong to that repository. An attached PR and an incident take the repository they are about.
   Triage choosing the repository and items that span repositories are later work.
5. **Scope resolves the repository** with the project: the item's, else the input's `repositoryId`,
   else the project's only one. Operations that need one and can't resolve it are refused with the
   reason; nothing guesses between two.
6. **Config stays per project.** One version history per project, whatever its repositories.
   Importing `.factory/policy.json` reads one named repository's default branch (the only one by
   default). A project with no repository edits its config in the app only. Repository-specific
   settings in the config apply to all of the project's repositories.

7. **The migration is additive.** 0260 adds and backfills; the repo columns stay on `core_projects`
   (written as a mirror, never read) until a later migration drops them once this code is live, so
   the code deployed before it keeps working through the deploy and a failed deploy breaks nothing.

## Consequences
- Every reader of repo fields goes through the repository row. Webhook lookups key work items and
  verify checks by repository, so two repositories with the same PR number or head never touch
  each other's items.
- The merge queue is computed per repository. The protection verdict stays per project, recorded
  only for the project's first repository, until per-repository protection lands (before the UI
  offers a second repository).
- `project.update` keeps working as a fix on the project's repository; `repository.update` is the
  per-repository form.
