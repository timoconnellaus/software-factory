// The repository's `.kim/` folder (spec 22, ADR 0305): the plan, its kept mockups and designs land
// there with the spec, and a later planning session pulls them back to build on. A pulled file
// keeps its content then as revision 0 (the base); if the default branch's copy has changed since,
// it's a conflict the planner must merge before the plan is approved.
import { DESIGN_NOTATION, type DesignType } from "@software-factory/runner-contract";
import type { HandlerContext, WorkItemRow } from "./operation.ts";
import { repoRef, requireRepository } from "./operations/shared.ts";

/** A kept artifact's path under `.kim/`: where it was pulled from, or one from its kind and title. */
export function kimPath(a: {
  kind: string;
  design_type: string | null;
  title: string;
  pulled_path: string | null;
}): string {
  if (a.pulled_path) return a.pulled_path;
  const slug =
    a.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "untitled";
  if (a.kind === "design") {
    const ext = DESIGN_NOTATION[(a.design_type ?? "architecture") as DesignType]?.ext ?? "txt";
    return `.kim/designs/${slug}.${ext}`;
  }
  if (a.kind === "document") return `.kim/plans/${slug}.md`;
  return `.kim/mockups/${slug}.html`;
}

/** An item's live kept artifacts with their latest content (and a pulled one's base). */
export async function keptArtifacts(ctx: Pick<HandlerContext, "db">, workItemId: string) {
  const rows = await ctx.db
    .selectFrom("core_planning_artifacts as a")
    .innerJoin("core_planning_artifact_revisions as r", (j) =>
      j.onRef("r.artifact_id", "=", "a.id").onRef("r.revision", "=", "a.revision"),
    )
    .leftJoin("core_planning_artifact_revisions as b", (j) =>
      j.onRef("b.artifact_id", "=", "a.id").on("b.revision", "=", 0),
    )
    .select([
      "a.id",
      "a.kind",
      "a.design_type",
      "a.title",
      "a.pulled_path",
      "a.pulled_base_sha",
      "r.content",
      "b.content as base",
    ])
    .where("a.work_item_id", "=", workItemId)
    .where("a.deleted_at", "is", null)
    .where("a.keep", "=", 1)
    .limit(50)
    .execute();
  return rows;
}

/**
 * Pulled files that changed on the default branch since they were pulled (spec 22): each must be
 * merged (pull it again, which takes the new base, and fold the planner's changes in) before the
 * plan is approved. One GitHub read per kept pulled file; no D1 beyond `keptArtifacts`.
 */
export async function kimConflicts(
  ctx: HandlerContext,
  w: Pick<WorkItemRow, "id">,
): Promise<{ path: string; artifactId: string }[]> {
  const kept = (await keptArtifacts(ctx, w.id)).filter((a) => a.pulled_path && a.base !== null);
  if (!kept.length) return [];
  const repository = requireRepository(ctx);
  const repo = await repoRef(ctx, repository);
  const out: { path: string; artifactId: string }[] = [];
  for (const a of kept) {
    const now = await ctx.services.github.readFile(
      repo,
      a.pulled_path as string,
      repository.default_branch,
    );
    if ((now ?? "") !== (a.base ?? ""))
      out.push({ path: a.pulled_path as string, artifactId: a.id });
  }
  return out;
}
