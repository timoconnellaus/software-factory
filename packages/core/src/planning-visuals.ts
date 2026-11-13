// Planning visuals (spec 21, ADR 0472): checks the planning and question operations share, kept
// apart from the operations so no operation module imports another at load time.
import { parseJson } from "@software-factory/db";
import { OperationError } from "./errors.ts";
import type { HandlerContext } from "./operation.ts";

/** An artifact of this work item that isn't deleted, with its latest revision's controls. */
export async function liveArtifact(ctx: Pick<HandlerContext, "db">, workItem: string, id: string) {
  const row = await ctx.db
    .selectFrom("core_planning_artifacts as a")
    .innerJoin("core_planning_artifact_revisions as r", (j) =>
      j.onRef("r.artifact_id", "=", "a.id").onRef("r.revision", "=", "a.revision"),
    )
    .select([
      "a.id",
      "a.kind",
      "a.design_type",
      "a.title",
      "a.revision",
      "a.work_item_id",
      "a.deleted_at",
      "r.controls",
    ])
    .where("a.id", "=", id)
    .executeTakeFirst();
  if (!row || row.work_item_id !== workItem || row.deleted_at) {
    throw new OperationError("not_found", `no artifact ${id} on this work item`);
  }
  return { ...row, controls: parseJson<string[]>(row.controls, []) };
}

/** The fields a question links to visuals with (spec 21), as the planner writes them. */
export interface QuestionVisuals {
  kind?: string | undefined;
  options?: string[] | undefined;
  artifactId?: string | null | undefined;
  optionArtifacts?: Record<string, string> | null | undefined;
  optionValues?: Record<string, Record<string, string>> | null | undefined;
  control?: string | null | undefined;
  min?: number | null | undefined;
  max?: number | null | undefined;
}

/**
 * Checks a question's links to visuals against this work item's artifacts (ADR 0472): artifacts
 * exist, option keys are options, and every bound control is one the artifact declares. Throws
 * `invalid_input` with a message the planner can act on.
 */
export async function checkQuestionVisuals(
  ctx: Pick<HandlerContext, "db">,
  workItem: string,
  q: QuestionVisuals,
): Promise<void> {
  const options = q.options ?? [];
  if (q.optionArtifacts) {
    for (const [option, artifact] of Object.entries(q.optionArtifacts)) {
      if (!options.includes(option)) {
        throw new OperationError(
          "invalid_input",
          `optionArtifacts names "${option}", which isn't an option`,
        );
      }
      await liveArtifact(ctx, workItem, artifact);
    }
  }
  const bound = (q.optionValues && Object.keys(q.optionValues).length) || q.control;
  if (!q.artifactId) {
    if (bound) {
      throw new OperationError(
        "invalid_input",
        "optionValues and control need artifactId: the mockup they change",
      );
    }
    return;
  }
  const artifact = await liveArtifact(ctx, workItem, q.artifactId);
  const declared = new Set(artifact.controls);
  const undeclared = (control: string) => {
    if (!declared.has(control)) {
      throw new OperationError(
        "invalid_input",
        `"${artifact.title}" doesn't declare ${control}. It declares: ${artifact.controls.join(", ") || "nothing"}. Declare it (a CSS variable --x used through var(--x), data-plan-<name> for @<name>, data-plan-text="<slot>" for #<slot>) and update the artifact first.`,
      );
    }
  };
  for (const [option, values] of Object.entries(q.optionValues ?? {})) {
    if (!options.includes(option)) {
      throw new OperationError(
        "invalid_input",
        `optionValues names "${option}", which isn't an option`,
      );
    }
    for (const control of Object.keys(values)) undeclared(control);
  }
  if (q.control) {
    undeclared(q.control);
    if (q.kind === "number") {
      if (!q.control.startsWith("--")) {
        throw new OperationError(
          "invalid_input",
          "a number question binds a CSS variable (--name)",
        );
      }
      if (q.min === undefined || q.min === null || q.max === undefined || q.max === null) {
        throw new OperationError(
          "invalid_input",
          "a number question bound to a control needs min and max",
        );
      }
    } else if (q.kind === "text") {
      if (!q.control.startsWith("#")) {
        throw new OperationError("invalid_input", "a text question binds a text slot (#name)");
      }
    } else {
      throw new OperationError(
        "invalid_input",
        "control is for number and text questions; a choice binds its options with optionValues",
      );
    }
  }
}
