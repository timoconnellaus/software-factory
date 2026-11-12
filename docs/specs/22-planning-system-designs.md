# Spec 22: Planning M3, system designs and `.kim/` write-back

Read first:
- ADR [0305](../adr/0305-planning-artifacts-and-the-kim-folder.md);
- specs [20](20-planning-loop.md) and [21](21-planning-visuals.md);
- kim's skill, in the "System designs and the repo's .kim/ folder" section.

## Goal
Planning can work through the data model, architecture and flows as reviewable text designs. The
approved ones, along with the mockups and the plan, land in the repo with the spec, where the next
planning session can build on them.

## Scope
- **Design types**:
  - `data-model` (DBML);
  - `architecture` and `data-flow` (D2);
  - `sequence` and `state` (Mermaid);
  - `api` (OpenAPI 3 YAML).
- **Checks** run on the runner, in a `planning-designs` package the harness's MCP server uses:
  - errors (diagnostics with line and fixes) refuse the save;
  - layout warnings (text too small, crossings, labels on shapes) save, with the warning attached.
- **System tab**: designs are drawn in the app, and comments can be pinned on tables, boxes and
  arrows.
- **`.kim/`**
  - `design.pull` copies a file from the default branch, and the app highlights what changed
    against it.
  - `artifact.keep` and `artifact.drop` decide what lands.
  - At spec approval, `spec.commit` writes the kept artifacts to `.kim/designs/`, `.kim/mockups/`
    and `.kim/plans/`, in the same commit as the spec, on the work item's branch.
  - A file that changed on the default branch since it was pulled is a conflict. The gate shows it,
    and the agent merges it before the commit.

## Out of scope
Creating a design system when none exists, unless asked (as in kim).

## Acceptance criteria
1. A DBML design with a syntax error is refused with its line and a fix. A D2 design with crossing
   edges saves with a layout warning naming the parts.
2. A comment pinned on a DBML table reaches the agent naming the table.
3. Pulling `.kim/designs/x.d2` shows it in the System tab with the agent's changes highlighted
   against the default branch.
4. Approving a spec commits the spec and every kept artifact (with an `.svg` preview for each
   design) in one commit on the work item's branch. Dropped and draft artifacts aren't committed.
5. When a pulled file changed on the default branch before approval, nothing is committed and the
   gate shows the conflict. After the agent merges it, approval commits the merge.

## As built
### Part A: designs as artifacts, `.kim/` pull and write-back (server)
- A **design** is an artifact of kind `design` with a `designType`: `data-model` (DBML),
  `architecture` and `data-flow` (D2), `sequence` and `state` (Mermaid), `api` (OpenAPI 3 YAML)
  (`DESIGN_TYPES`, `DESIGN_NOTATION` in runner-contract). `artifact.add` refuses a design without its
  type. Migration 0373 (block AR) rebuilds `core_planning_artifacts` for the new kind (as 0261 did)
  and adds `design_type`, `pulled_path` and `pulled_base_sha`, with one live artifact per pulled path.
- **`design.pull { path }`** (a planner tool) reads a file under `.kim/designs|mockups|plans/` on the
  default branch. Its content is kept as **revision 0, the base** (pruning never removes it) and as
  revision 1 to revise. The artifact is kept, and the type comes from the extension (and, for
  Mermaid, the first line). Pulling again takes the default branch's current copy as the new base
  and leaves the planner's latest revision as it is. `planning.get` gives each artifact's
  `designType` and `pulledPath`.
- **Keep or drop** is the artifact's existing `keep` (`artifact.update { keep }`); no separate
  `artifact.keep` and `artifact.drop` operations.
- **Write-back**: `spec.commit` commits the spec, the plan (`.kim/plans/wi-N-slug.md`) and every kept
  live artifact (designs to `.kim/designs/`, mockups to `.kim/mockups/`, documents to
  `.kim/plans/`, a pulled file back at its path) in **one commit** on the work item's branch, through
  the new `commitFiles` (the Git Data API: a tree on the branch head, a commit, a fast-forward).
  Dropped and draft (not kept) artifacts aren't committed (criterion 4, without the `.svg` previews:
  part B).
- **Conflicts** (criterion 5): a kept pulled file whose default-branch copy differs from its base
  is a conflict.
  - `planning.ready` refuses it, naming the files and telling the planner to pull again and merge.
  - `spec.approve` refuses it, telling the person to request changes so the planner merges. Nothing
    is committed.
  - Deviation: the conflict reaches the gate as these refusals, not as a stored notice. A refused
    approval can't record anything, since its batch rolls back.
- **What is approved is what is written** (review of #130):
  - While the plan waits at the gate, `artifact.add`, `artifact.update`, `artifact.delete` and
    `design.pull` are refused (like `spec.revise`), and guarded in the batch against a race with
    `planning.ready`.
  - Approving the gate (`spec.approve`, or `approval.decide` on a spec gate) records on the spec
    (`core_specs.kim_files`, migration 0373) each `.kim/` file the write-back writes: path, artifact,
    revision and SHA-256 of its content. `spec.commit` writes exactly those revisions and refuses
    if one is gone or its content differs; a spec approved without a record writes no artifacts.
  - A pulled file whose latest revision equals its base isn't written. Generated paths that collide
    get `-2`, `-3` before the extension.
- The desktop's Mockups pane and canvas leave designs out (they are drawn in part B's System tab).
  Until then, the gate lists every file approving writes (`spec.writeBack`): path, new or changed
  against the pulled base, and its text as plain text in a collapsible block with added and removed
  lines marked. The approve button reads "Approve the plan and write N files to .kim/".
- `design.pull` takes a path of at most 200 characters, no `.` or empty segments, `.dbml`, `.d2`,
  `.mmd`, `.yaml` or `.yml` under `designs/`, `.html` under `mockups/` and `.md` under `plans/`.
- Tests: `packages/core/test/designs.test.ts` and the db late-migrations test (0373 after
  everything on main).

### Part B (next): the checks package and the System tab
Checks on the runner (errors refuse a save, layout warnings save with the warning), `.svg` previews
written with each design, the System tab drawing designs with changes highlighted against the base,
and comments pinned on tables, boxes and arrows (criteria 1, 2, 3's highlighting, 4's previews).

