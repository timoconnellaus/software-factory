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
