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

### Part B1: the runner's checks, previews and the `.svg` write-back
- **`packages/planning-designs`** (Node, on the runner): `checkDesign(type, source)` parses with
  each notation's own engine, as kim does: DBML with `@dbml/parse`, D2 with `@terrastruct/d2`
  (wasm, dagre layout), Mermaid with `mermaid.parse` (parsing only), OpenAPI with `yaml` plus the
  shape OpenAPI 3 needs. An error refuses the save with each problem's line, the line's text and a
  fix (at most 8). It then **draws the design itself** to a static SVG (D2 from its compiled shapes
  and routes; the data model, sequences and states laid out here, the last two read by a small
  reader of its own after Mermaid accepted them; OpenAPI as endpoints and schema cards), with every
  part's id, label, signature and box: tables, enums and relations; boxes and arrows; participants
  and messages; states and transitions; endpoints and schemas. Layout warnings save with it and
  name the parts: crossing arrows, arrows through a box they don't connect, and text too small once
  fitted to a 1280×800 window. Ported in part from kim (`designCheck.ts`, `design/errors.ts`,
  `design/layoutCheck.ts`, `design/dataModel.ts`).
- **The planning MCP server** checks a design before relaying `artifact.add` or `artifact.update`:
  refused, nothing reaches the cloud; saved, the preview goes with it (`preview`, never in the
  model's tool schema) and the warnings come back to the planner as `layoutWarnings`. After a
  `design.pull` of a design it reads the base, draws it, and stores its preview with
  **`design.preview`** (revision 0, and revision 1 on a first pull), a harness-only call.
- **The cloud** keeps the preview with the revision (`core_planning_artifact_revisions.preview`,
  migration 0400) only if it was drawn from exactly that content (its SHA-256) and the SVG has no
  script, event attribute, foreign content, style, image, link or outside reference
  (`unsafeSvg`); it counts in the revision's size (the item's byte budget and pruning cover it).
  `artifact.get` returns `designType` and `preview`; `artifact.read` returns `kind` and
  `designType` and reads revision 0.
- **Write-back** (criterion 4): each kept design's preview is written beside it as `.svg` (kim's
  naming: `x.d2` → `x.svg`, `-2` on a collision), recorded in the approval's `kim_files` with
  `preview: true` and committed in the same commit. The gate's file list shows it as an image.
- **Rendering untrusted design text**: no design text is executed. The SVG is this repo's code's
  drawing, its text escaped; the app only ever shows it as an image (`<img>` with a data URL), where
  nothing runs or loads.
- Tests: `packages/planning-designs/test/designs.test.ts` (criterion 1), `harness-claude`
  `planning-designs.test.ts`, `core` `design-previews.test.ts` (criterion 4's previews).

### Part B2 (next): the System tab
The System tab draws each design's preview with what changed against the pulled base highlighted
(criterion 3), and comments pinned on tables, boxes and arrows reach the planner naming the part
(criterion 2).
