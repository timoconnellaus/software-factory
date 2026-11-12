// The repository's `.kim/` folder (spec 22, ADR 0305): the plan, its kept mockups and designs land
// there with the spec, and a later planning session pulls them back to build on. A pulled file
// keeps its content then as revision 0 (the base); if the default branch's copy has changed since,
// it's a conflict the planner must merge before the plan is approved.
import { parseJson } from "@software-factory/db";
import { DESIGN_NOTATION, type DesignType } from "@software-factory/runner-contract";
import { z } from "zod";
import { sha256Hex } from "./attachments.ts";
import { OperationError } from "./errors.ts";
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
    // core_planning_artifacts_item_idx (work_item_id, created_at): a stable order, so paths that
    // collide are told apart the same way every time.
    .orderBy("a.created_at")
    .orderBy("a.id")
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

/** The plan's own copy under `.kim/plans/`: the spec as committed. */
export const planPath = (w: Pick<WorkItemRow, "number" | "slug">) =>
  `.kim/plans/wi-${w.number}-${w.slug}.md`;

/** One `.kim/` file the approved plan writes from a kept artifact (review of #130). */
export interface WriteBackFile {
  path: string;
  artifactId: string;
  revision: number;
  kind: string;
  /** `new`: not pulled (no base to compare); `changed`: pulled, and differs from its base. */
  status: "new" | "changed";
  content: string;
  /** The pulled file's content on the default branch when pulled; null when not pulled. */
  base: string | null;
}

/**
 * The kept artifacts the approved plan will write to `.kim/`, as a person sees them at the gate
 * (review of #130). A pulled file whose latest revision equals its base is left out: nothing to
 * write. Paths that collide (two kept designs with one title, or one on the plan's own path) get
 * `-2`, `-3`, … before the extension, so nothing is overwritten silently. One indexed read.
 */
export async function writeBackFiles(
  ctx: Pick<HandlerContext, "db">,
  w: Pick<WorkItemRow, "id" | "number" | "slug">,
): Promise<WriteBackFile[]> {
  const kept = await ctx.db
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
      "a.revision",
      "r.content",
      "b.content as base",
    ])
    .where("a.work_item_id", "=", w.id)
    .where("a.deleted_at", "is", null)
    .where("a.keep", "=", 1)
    .orderBy("a.created_at")
    .orderBy("a.id")
    .limit(50)
    .execute();
  const taken = new Set<string>([planPath(w)]);
  for (const a of kept) if (a.pulled_path) taken.add(a.pulled_path);
  const out: WriteBackFile[] = [];
  for (const a of kept) {
    const pulled = a.pulled_path !== null && a.base !== null;
    if (pulled && a.content === a.base) continue;
    let path = kimPath(a);
    if (!a.pulled_path) {
      const dot = path.lastIndexOf(".");
      for (let n = 2; taken.has(path); n++)
        path = `${kimPath(a).slice(0, dot)}-${n}${kimPath(a).slice(dot)}`;
      taken.add(path);
    }
    out.push({
      path,
      artifactId: a.id,
      revision: a.revision,
      kind: a.kind,
      status: pulled ? "changed" : "new",
      content: a.content,
      base: pulled ? a.base : null,
    });
  }
  return out;
}

/** What a person approved (core_specs.kim_files): each file's revision and content hash. */
export const kimManifestSchema = z.array(
  z.object({
    path: z.string(),
    artifactId: z.string(),
    revision: z.number().int(),
    sha256: z.string(),
  }),
);
export type KimManifest = z.infer<typeof kimManifestSchema>;

const hashText = (text: string) => sha256Hex(new TextEncoder().encode(text));

/**
 * At approval (review of #130): records on the gated spec exactly which `.kim/` files, at which
 * revision and with what content, the person approved. spec.commit writes those and nothing else.
 */
export async function bindKimApproval(
  ctx: HandlerContext,
  w: Pick<WorkItemRow, "id" | "number" | "slug" | "current_spec_id">,
): Promise<KimManifest> {
  if (!w.current_spec_id) return [];
  const files = await writeBackFiles(ctx, w);
  const manifest: KimManifest = await Promise.all(
    files.map(async (f) => ({
      path: f.path,
      artifactId: f.artifactId,
      revision: f.revision,
      sha256: await hashText(f.content),
    })),
  );
  ctx.write(
    ctx.db
      .updateTable("core_specs")
      .set({ kim_files: JSON.stringify(manifest) })
      .where("id", "=", w.current_spec_id)
      .where("status", "=", "draft"),
  );
  return manifest;
}

/**
 * The approved `.kim/` files' content, exactly the revisions a person approved (review of #130),
 * refusing if one is gone or its content differs. Point reads by the revisions' primary key.
 */
export async function approvedKimFiles(
  ctx: Pick<HandlerContext, "db">,
  kimFiles: string | null,
): Promise<{ path: string; content: string }[]> {
  const manifest = kimManifestSchema.parse(parseJson<unknown>(kimFiles ?? "[]", []));
  if (!manifest.length) return [];
  const found = await ctx.db
    .selectFrom("core_planning_artifact_revisions")
    .select(["artifact_id", "revision", "content"])
    .where((eb) =>
      eb.or(
        manifest.map((m) =>
          eb.and([eb("artifact_id", "=", m.artifactId), eb("revision", "=", m.revision)]),
        ),
      ),
    )
    .limit(manifest.length)
    .execute();
  const out: { path: string; content: string }[] = [];
  for (const m of manifest) {
    const r = found.find((x) => x.artifact_id === m.artifactId && x.revision === m.revision);
    if (!r || (await hashText(r.content)) !== m.sha256) {
      throw new OperationError(
        "conflict",
        `${m.path} isn't the revision a person approved at the gate: nothing is committed`,
        { path: m.path },
      );
    }
    out.push({ path: m.path, content: r.content });
  }
  return out;
}
