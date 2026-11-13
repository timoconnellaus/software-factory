// Planning visuals (spec 21, ADR 0472): the planner's mockups, diagrams and documents. Each revision
// is kept in D1 with the controls it declares; the planner adds, revises, removes and shows them;
// people read them (`artifact.get`) to render them in a sandboxed frame. Questions that link to
// them are checked here (`checkQuestionVisuals`), so a binding to an undeclared control is refused.
import { parseJson } from "@software-factory/db";
import {
  ARTIFACT_MAX_BYTES,
  artifactAddCallSchema,
  artifactDeleteInputSchema,
  artifactReadInputSchema,
  artifactShowInputSchema,
  artifactUpdateCallSchema,
  type DesignPreview,
  declaredControls,
  designPreviewInputSchema,
  designPreviewSchema,
  designPullInputSchema,
  designTypeOf,
} from "@software-factory/runner-contract";
import { sql } from "kysely";
import { z } from "zod";
import { sha256Hex } from "../attachments.ts";
import { OperationError } from "../errors.ts";
import { newId } from "../ids.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { logPlanning } from "../planning.ts";
import { liveArtifact } from "../planning-visuals.ts";
import { byJob, planningJob, planningJobFields } from "./planning.ts";
import { repoRef, requireRepository, requireWorkItem, workItemId } from "./shared.ts";

const bytes = (text: string) => new TextEncoder().encode(text).length;

/**
 * A design revision's preview as stored (spec 22 part B), checked against the source it was drawn
 * from: the runner's checks drew it from exactly this content, or it isn't kept. The row's `size`
 * counts it, and source and preview together fit one revision row.
 */
async function storedPreview(
  kind: string,
  content: string,
  preview: DesignPreview | undefined,
): Promise<{ preview: string | null; size: number }> {
  if (!preview) return { preview: null, size: bytes(content) };
  if (kind !== "design") {
    throw new OperationError("invalid_input", "only a design has a preview");
  }
  if ((await sha256Hex(new TextEncoder().encode(content))) !== preview.sha256) {
    throw new OperationError("invalid_input", "the preview wasn't drawn from this content");
  }
  const json = JSON.stringify(preview);
  const size = bytes(content) + bytes(json);
  if (size > ARTIFACT_MAX_BYTES) {
    throw new OperationError(
      "invalid_input",
      `a design and its preview hold at most ${ARTIFACT_MAX_BYTES} bytes: split the design`,
    );
  }
  return { preview: json, size };
}

/** A stored preview, read back; null when there is none or it no longer parses. */
export function readPreview(json: string | null): DesignPreview | null {
  if (!json) return null;
  const parsed = designPreviewSchema.safeParse(parseJson<unknown>(json, null));
  return parsed.success ? parsed.data : null;
}

/** The controls a revision declares: only HTML (a mockup or diagram) has any. */
const controlsOf = (kind: string, content: string) =>
  kind === "document" ? [] : declaredControls(content);

/** Questions bound to an artifact whose controls a new revision no longer declares. */
async function droppedBindings(
  ctx: Pick<HandlerContext, "db">,
  artifactId: string,
  controls: string[],
): Promise<string[]> {
  const declared = new Set(controls);
  const bound = await ctx.db
    .selectFrom("core_questions")
    .select(["number", "control", "option_values"])
    .where("artifact_id", "=", artifactId)
    .where("status", "!=", "withdrawn")
    .execute();
  const warnings: string[] = [];
  for (const q of bound) {
    const used = [
      ...(q.control ? [q.control] : []),
      ...Object.values(
        parseJson<Record<string, Record<string, string>>>(q.option_values ?? "{}", {}),
      ).flatMap((v) => Object.keys(v)),
    ];
    const missing = [...new Set(used.filter((c) => !declared.has(c)))];
    if (missing.length)
      warnings.push(
        `Q${q.number ?? "?"} binds ${missing.join(", ")}, which this revision no longer declares`,
      );
  }
  return warnings;
}

/**
 * While the plan waits at the gate, what a person is looking at doesn't change under them (review
 * of #130): adding, revising, deleting or pulling an artifact is refused, like spec.revise. Guarded
 * in the batch too, so a call racing planning.ready can't land after the gate opened.
 */
function refuseAtGate(ctx: HandlerContext, session: { id: string; at_gate: number }) {
  if (session.at_gate) {
    throw new OperationError(
      "conflict",
      "the plan is waiting at the gate, and the person deciding sees its artifacts as they are: wait for a decision (changes arrive in the chat)",
    );
  }
  ctx.guardExists(
    "the plan isn't waiting at the gate",
    ctx.db
      .selectFrom("core_planning_sessions")
      .select("id")
      .where("id", "=", session.id)
      .where("at_gate", "=", 0),
  );
}

function showArtifact(ctx: HandlerContext, sessionId: string, artifactId: string) {
  ctx.write(
    ctx.db
      .updateTable("core_planning_sessions")
      .set({ shown_artifact_id: artifactId, updated_at: ctx.now })
      .where("id", "=", sessionId),
  );
}

export const artifactAdd = defineOperation({
  name: "artifact.add",
  description:
    "The planning agent adds a mockup, diagram or document beside the plan (spec 21, ADR 0472). Its content is kept as revision 1, with the controls a mockup declares. People see it in the Mockups tab and on the canvas. Refused while the plan waits at the gate.",
  risk: "write",
  actors: ["runner"],
  permission: "signed-in",
  input: artifactAddCallSchema.extend(planningJobFields),
  output: z.object({
    artifactId: z.string(),
    revision: z.number(),
    controls: z.array(z.string()),
  }),
  scope: byJob,
  async handler(input, ctx) {
    const { session } = await planningJob(ctx, input);
    refuseAtGate(ctx, session);
    const w = requireWorkItem(ctx);
    if (bytes(input.content) > ARTIFACT_MAX_BYTES) {
      throw new OperationError(
        "invalid_input",
        `an artifact holds at most ${ARTIFACT_MAX_BYTES} bytes`,
      );
    }
    if ((input.kind === "design") !== (input.designType !== undefined)) {
      throw new OperationError(
        "invalid_input",
        "a design names its designType (data-model, architecture, data-flow, sequence, state, api), and only a design does",
      );
    }
    const stored = await storedPreview(input.kind, input.content, input.preview);
    await checkBudget(ctx, w.id, stored.size, 0, true);
    const id = newId("planningArtifact");
    const controls = controlsOf(input.kind, input.content);
    ctx.write(
      ctx.db.insertInto("core_planning_artifacts").values({
        id,
        work_item_id: w.id,
        kind: input.kind,
        design_type: input.kind === "design" ? (input.designType ?? null) : null,
        title: input.title,
        description: input.description ?? null,
        revision: 1,
        keep: input.keep ? 1 : 0,
        created_by: ctx.actor.id,
        created_at: ctx.now,
        updated_at: ctx.now,
      }),
    );
    ctx.write(
      ctx.db.insertInto("core_planning_artifact_revisions").values({
        artifact_id: id,
        revision: 1,
        content: input.content,
        size: stored.size,
        controls: JSON.stringify(controls),
        preview: stored.preview,
        created_at: ctx.now,
      }),
    );
    guardBudget(ctx, w.id);
    if (input.show) showArtifact(ctx, session.id, id);
    logPlanning(ctx, w.id, "artifact.added", { artifactId: id, revision: 1 });
    return { artifactId: id, revision: 1, controls };
  },
});

export const artifactUpdate = defineOperation({
  name: "artifact.update",
  description:
    "The planning agent revises an artifact: new content is a new revision (the old ones are kept); title, description, keep and show change in place. Answers with `warnings` when a question binds a control the new revision no longer declares. Refused while the plan waits at the gate.",
  risk: "write",
  actors: ["runner"],
  permission: "signed-in",
  input: artifactUpdateCallSchema.extend(planningJobFields),
  output: z.object({
    artifactId: z.string(),
    revision: z.number(),
    controls: z.array(z.string()),
    warnings: z.array(z.string()),
  }),
  scope: byJob,
  async handler(input, ctx) {
    const { session } = await planningJob(ctx, input);
    refuseAtGate(ctx, session);
    const w = requireWorkItem(ctx);
    const current = await liveArtifact(ctx, w.id, input.artifactId);
    let revision = current.revision;
    let controls = current.controls;
    let warnings: string[] = [];
    let stored: { preview: string | null; size: number } | null = null;
    if (input.preview && input.content === undefined) {
      throw new OperationError(
        "invalid_input",
        "a preview comes with the content it was drawn from",
      );
    }
    if (input.content !== undefined) {
      stored = await storedPreview(current.kind, input.content, input.preview);
      if (bytes(input.content) > ARTIFACT_MAX_BYTES) {
        throw new OperationError(
          "invalid_input",
          `an artifact holds at most ${ARTIFACT_MAX_BYTES} bytes`,
        );
      }
      revision = current.revision + 1;
      controls = controlsOf(current.kind, input.content);
      warnings = await droppedBindings(ctx, current.id, controls);
      await checkBudget(
        ctx,
        w.id,
        stored.size,
        await prunedBytes(ctx, current.id, revision),
        false,
      );
    }
    // The guard first (review of #90): a race is refused as a conflict, not on the revision's key.
    ctx.write(
      ctx.db
        .updateTable("core_planning_artifacts")
        .set({
          revision,
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.keep !== undefined ? { keep: input.keep ? 1 : 0 } : {}),
          updated_at: ctx.now,
        })
        .where("id", "=", current.id)
        .where("revision", "=", current.revision),
    );
    ctx.guardChanged("the artifact is still the revision read");
    if (input.content !== undefined) {
      ctx.write(
        ctx.db.insertInto("core_planning_artifact_revisions").values({
          artifact_id: current.id,
          revision,
          content: input.content,
          size: stored?.size ?? bytes(input.content),
          controls: JSON.stringify(controls),
          preview: stored?.preview ?? null,
          created_at: ctx.now,
        }),
      );
      pruneRevisions(ctx, current.id, revision);
      guardBudget(ctx, w.id);
    }
    if (input.show) showArtifact(ctx, session.id, current.id);
    logPlanning(ctx, w.id, "artifact.updated", { artifactId: current.id, revision });
    return { artifactId: current.id, revision, controls, warnings };
  },
});

export const artifactDelete = defineOperation({
  name: "artifact.delete",
  description:
    "The planning agent removes an artifact from the plan's workspace. Its revisions stay in the record. Refused while the plan waits at the gate.",
  risk: "write",
  actors: ["runner"],
  permission: "signed-in",
  input: artifactDeleteInputSchema.extend(planningJobFields),
  output: z.object({ artifactId: z.string(), deleted: z.boolean() }),
  scope: byJob,
  async handler(input, ctx) {
    const { session } = await planningJob(ctx, input);
    refuseAtGate(ctx, session);
    const w = requireWorkItem(ctx);
    const current = await liveArtifact(ctx, w.id, input.artifactId);
    ctx.write(
      ctx.db
        .updateTable("core_planning_artifacts")
        .set({ deleted_at: ctx.now, updated_at: ctx.now })
        .where("id", "=", current.id),
    );
    // Its bytes are freed (review of #90): the latest revision stays for the record, the rest go.
    ctx.write(
      ctx.db
        .deleteFrom("core_planning_artifact_revisions")
        .where("artifact_id", "=", current.id)
        .where("revision", "<", current.revision),
    );
    logPlanning(ctx, w.id, "artifact.deleted", { artifactId: current.id });
    return { artifactId: current.id, deleted: true };
  },
});

export const artifactShow = defineOperation({
  name: "artifact.show",
  description: "The planning agent brings an artifact on everyone's Planning view.",
  risk: "write",
  actors: ["runner"],
  permission: "signed-in",
  input: artifactShowInputSchema.extend(planningJobFields),
  output: z.object({ artifactId: z.string() }),
  scope: byJob,
  async handler(input, ctx) {
    const { session } = await planningJob(ctx, input);
    const w = requireWorkItem(ctx);
    const current = await liveArtifact(ctx, w.id, input.artifactId);
    showArtifact(ctx, session.id, current.id);
    logPlanning(ctx, w.id, "artifact.shown", { artifactId: current.id });
    return { artifactId: current.id };
  },
});

export const artifactGet = defineOperation({
  name: "artifact.get",
  description:
    "A planning artifact's content (spec 21), the latest revision unless one is named, for the Planning view to render in a sandboxed frame (ADR 0472). Untrusted HTML: never render it on the app's own origin. A design comes with the preview the runner drew (spec 22 part B): show its SVG only as an image.",
  risk: "read",
  actors: ["human"],
  permission: "member",
  input: z.object({
    workItemId,
    artifactId: z.string().min(1),
    /** A past revision; omitted, the latest. A pulled file's base is revision 0. */
    revision: z.number().int().nonnegative().optional(),
  }),
  output: z.object({
    artifactId: z.string(),
    kind: z.string(),
    title: z.string(),
    revision: z.number(),
    latest: z.number(),
    content: z.string(),
    controls: z.array(z.string()),
    /** A design's type and the preview the runner's checks drew (spec 22 part B), or null. */
    designType: z.string().nullable(),
    preview: designPreviewSchema.nullable(),
  }),
  async handler(input, ctx) {
    const w = requireWorkItem(ctx);
    const a = await ctx.db
      .selectFrom("core_planning_artifacts")
      .selectAll()
      .where("id", "=", input.artifactId)
      .executeTakeFirst();
    if (!a || a.work_item_id !== w.id) throw new OperationError("not_found", "no such artifact");
    const revision = input.revision ?? a.revision;
    const r = await ctx.db
      .selectFrom("core_planning_artifact_revisions")
      .selectAll()
      .where("artifact_id", "=", a.id)
      .where("revision", "=", revision)
      .executeTakeFirst();
    if (!r) {
      throw new OperationError(
        "not_found",
        `revision ${revision} isn't kept: an artifact keeps its last ${ARTIFACT_REVISIONS_KEPT}`,
      );
    }
    return {
      artifactId: a.id,
      kind: a.kind,
      title: a.title,
      revision,
      latest: a.revision,
      content: r.content,
      controls: parseJson<string[]>(r.controls, []),
      designType: a.design_type,
      preview: readPreview(r.preview),
    };
  },
});

export const artifactRead = defineOperation({
  name: "artifact.read",
  description:
    "The planning agent reads one of its work item's artifacts: the latest revision's content, or a revision named.",
  risk: "write",
  actors: ["runner"],
  permission: "signed-in",
  input: artifactReadInputSchema.extend(planningJobFields),
  output: z.object({
    artifactId: z.string(),
    kind: z.string(),
    designType: z.string().nullable(),
    revision: z.number(),
    content: z.string(),
    controls: z.array(z.string()),
  }),
  scope: byJob,
  async handler(input, ctx) {
    await planningJob(ctx, input);
    const w = requireWorkItem(ctx);
    const a = await liveArtifact(ctx, w.id, input.artifactId);
    const revision = input.revision ?? a.revision;
    const r = await ctx.db
      .selectFrom("core_planning_artifact_revisions")
      .select(["content", "controls"])
      .where("artifact_id", "=", a.id)
      .where("revision", "=", revision)
      .executeTakeFirst();
    if (!r) {
      throw new OperationError(
        "not_found",
        `revision ${revision} isn't kept: an artifact keeps its last ${ARTIFACT_REVISIONS_KEPT}`,
      );
    }
    return {
      artifactId: a.id,
      kind: a.kind,
      designType: a.design_type,
      revision,
      content: r.content,
      controls: parseJson<string[]>(r.controls, []),
    };
  },
});

export const designPreview = defineOperation({
  name: "design.preview",
  description:
    "The planning harness stores the preview its checks drew of a design revision it didn't save itself: a pulled file's base (revision 0) and first revision (spec 22 part B). Refused unless the preview was drawn from exactly that revision's content, and while the plan waits at the gate.",
  risk: "write",
  actors: ["runner"],
  permission: "signed-in",
  input: designPreviewInputSchema.extend(planningJobFields),
  output: z.object({ artifactId: z.string(), revision: z.number() }),
  scope: byJob,
  async handler(input, ctx) {
    const { session } = await planningJob(ctx, input);
    refuseAtGate(ctx, session);
    const w = requireWorkItem(ctx);
    const a = await liveArtifact(ctx, w.id, input.artifactId);
    // Revisions-table primary key (artifact_id, revision): a point read.
    const r = await ctx.db
      .selectFrom("core_planning_artifact_revisions")
      .select(["content", "size"])
      .where("artifact_id", "=", a.id)
      .where("revision", "=", input.revision)
      .executeTakeFirst();
    if (!r) throw new OperationError("not_found", `revision ${input.revision} isn't kept`);
    const stored = await storedPreview(a.kind, r.content, input.preview);
    await checkBudget(ctx, w.id, stored.size, r.size, false);
    ctx.write(
      ctx.db
        .updateTable("core_planning_artifact_revisions")
        .set({ preview: stored.preview, size: stored.size })
        .where("artifact_id", "=", a.id)
        .where("revision", "=", input.revision)
        .where("content", "=", r.content),
    );
    ctx.guardChanged("the revision is still the content the preview was drawn from");
    // The artifact changed for whoever shows it (review of #168): its drawing arrived after it.
    ctx.write(
      ctx.db
        .updateTable("core_planning_artifacts")
        .set({ updated_at: ctx.now })
        .where("id", "=", a.id),
    );
    guardBudget(ctx, w.id);
    logPlanning(ctx, w.id, "artifact.updated", { artifactId: a.id, preview: input.revision });
    return { artifactId: a.id, revision: input.revision };
  },
});

/** Revisions kept per artifact (review of #90): older ones are pruned as new ones come. */
export const ARTIFACT_REVISIONS_KEPT = 10;
/** Artifacts per work item, deleted ones included. */
export const ARTIFACTS_PER_ITEM = 50;
/** Bytes all of an item's artifact revisions may hold. */
export const ARTIFACT_ITEM_BYTES = 20_000_000;

/**
 * Checks that `adding` more bytes fits the item's budget once `freed` bytes are pruned, or refuses
 * in plain words. One indexed read: the item's artifacts (by `core_planning_artifacts_item_idx`) and
 * their revisions (by the revisions' primary key), at most ARTIFACTS_PER_ITEM × ARTIFACT_REVISIONS_KEPT.
 */
async function checkBudget(
  ctx: HandlerContext,
  workItemId: string,
  adding: number,
  freed: number,
  newArtifact: boolean,
) {
  const row = await ctx.db
    .selectFrom("core_planning_artifacts as a")
    .leftJoin("core_planning_artifact_revisions as r", "r.artifact_id", "a.id")
    .select((eb) => [
      eb.fn.coalesce(eb.fn.sum<number>("r.size"), eb.lit(0)).as("bytes"),
      eb.fn.count<number>("a.id").distinct().as("artifacts"),
    ])
    .where("a.work_item_id", "=", workItemId)
    // Only live artifacts count (review of #90): a deleted one frees its slot and its bytes.
    .where("a.deleted_at", "is", null)
    .executeTakeFirst();
  const used = Number(row?.bytes ?? 0);
  if (newArtifact && Number(row?.artifacts ?? 0) >= ARTIFACTS_PER_ITEM) {
    throw new OperationError(
      "conflict",
      `this item already has ${ARTIFACTS_PER_ITEM} mockups, diagrams and documents: update one instead of adding another`,
    );
  }
  if (used - freed + adding > ARTIFACT_ITEM_BYTES) {
    throw new OperationError(
      "conflict",
      `this item's mockups would hold ${((used - freed + adding) / 1e6).toFixed(1)} MB, and the most is ${ARTIFACT_ITEM_BYTES / 1e6} MB: make this one smaller, or update an existing one instead of adding more`,
    );
  }
}

/** Prunes an artifact's revisions older than the last ARTIFACT_REVISIONS_KEPT once `latest` lands. */
function pruneRevisions(ctx: HandlerContext, artifactId: string, latest: number) {
  if (latest <= ARTIFACT_REVISIONS_KEPT) return;
  ctx.write(
    ctx.db
      .deleteFrom("core_planning_artifact_revisions")
      .where("artifact_id", "=", artifactId)
      // Revision 0 is a pulled file's base (spec 22): it stays.
      .where("revision", ">=", 1)
      .where("revision", "<=", latest - ARTIFACT_REVISIONS_KEPT),
  );
}

/** The bytes pruning frees when `latest` lands. */
async function prunedBytes(ctx: HandlerContext, artifactId: string, latest: number) {
  if (latest <= ARTIFACT_REVISIONS_KEPT) return 0;
  const row = await ctx.db
    .selectFrom("core_planning_artifact_revisions")
    .select((eb) => eb.fn.coalesce(eb.fn.sum<number>("size"), eb.lit(0)).as("bytes"))
    .where("artifact_id", "=", artifactId)
    .where("revision", "<=", latest - ARTIFACT_REVISIONS_KEPT)
    .executeTakeFirst();
  return Number(row?.bytes ?? 0);
}

/**
 * Guards the budget in the batch (review of #90): placed after the writes, it fails the whole batch
 * if, with them, the item's live artifacts exceed the cap or their bytes the budget, so two adds
 * racing can't both pass the check above. Point lookups by core_planning_artifacts_item_idx and the
 * revisions' primary key, bounded by the caps.
 */
function guardBudget(ctx: HandlerContext, workItemId: string) {
  ctx.guardExists(
    "the item's artifacts still fit",
    ctx.db
      .selectFrom("core_work_items")
      .select("id")
      .where("id", "=", workItemId)
      .where(
        sql<boolean>`(SELECT COUNT(*) FROM core_planning_artifacts WHERE work_item_id = ${workItemId} AND deleted_at IS NULL) <= ${ARTIFACTS_PER_ITEM}`,
      )
      .where(
        sql<boolean>`(SELECT COALESCE(SUM(r.size), 0) FROM core_planning_artifacts a JOIN core_planning_artifact_revisions r ON r.artifact_id = a.id WHERE a.work_item_id = ${workItemId} AND a.deleted_at IS NULL) <= ${ARTIFACT_ITEM_BYTES}`,
      ),
  );
}

export const designPull = defineOperation({
  name: "design.pull",
  description:
    "The planning agent brings a file from the repository's .kim/ folder (designs, mockups or plans, on the default branch) in as an artifact to revise (spec 22). Its content there is kept as the base (revision 0) the app compares against; the artifact is kept, so the approved plan writes it back to the same path. Pulling a file already pulled takes the default branch's current copy as the new base (merge your changes into it) and leaves your latest revision as it is. Refused while the plan waits at the gate.",
  risk: "write",
  actors: ["runner"],
  permission: "signed-in",
  input: designPullInputSchema.extend(planningJobFields),
  output: z.object({ artifactId: z.string(), revision: z.number(), changed: z.boolean() }),
  scope: byJob,
  async handler(input, ctx) {
    const { session } = await planningJob(ctx, input);
    refuseAtGate(ctx, session);
    const w = requireWorkItem(ctx);
    const repository = requireRepository(ctx);
    const repo = await repoRef(ctx, repository);
    const head = await ctx.services.github.getBranchSha(repo, repository.default_branch);
    const content = head
      ? await ctx.services.github.readFile(repo, input.path, repository.default_branch)
      : null;
    if (content === null) {
      throw new OperationError("not_found", `${input.path} isn't on ${repository.default_branch}`);
    }
    if (bytes(content) > ARTIFACT_MAX_BYTES) {
      throw new OperationError(
        "invalid_input",
        `${input.path} is over ${ARTIFACT_MAX_BYTES} bytes`,
      );
    }
    const folder = input.path.split("/")[1];
    const designType = folder === "designs" ? designTypeOf(input.path, content) : null;
    if (folder === "designs" && !designType) {
      throw new OperationError(
        "invalid_input",
        `${input.path}: a design is .dbml, .d2, .mmd or .yaml`,
      );
    }
    const kind = folder === "designs" ? "design" : folder === "plans" ? "document" : "mockup";
    const existing = await ctx.db
      .selectFrom("core_planning_artifacts")
      .select(["id", "revision"])
      .where("work_item_id", "=", w.id)
      .where("pulled_path", "=", input.path)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    const base = {
      revision: 0,
      content,
      size: bytes(content),
      controls: JSON.stringify(controlsOf(kind, content)),
      created_at: ctx.now,
    };
    if (existing) {
      // A new base: the default branch's copy now. The planner's latest revision stays.
      ctx.write(
        ctx.db
          .insertInto("core_planning_artifact_revisions")
          .values({ artifact_id: existing.id, ...base })
          .onConflict((oc) =>
            oc.columns(["artifact_id", "revision"]).doUpdateSet({
              content: base.content,
              size: base.size,
              controls: base.controls,
              // The old base's drawing is stale (review of #163): the harness draws the new one.
              preview: null,
              created_at: base.created_at,
            }),
          ),
      );
      ctx.write(
        ctx.db
          .updateTable("core_planning_artifacts")
          .set({ pulled_base_sha: head, updated_at: ctx.now })
          .where("id", "=", existing.id),
      );
      logPlanning(ctx, w.id, "artifact.updated", { artifactId: existing.id, rebased: true });
      return { artifactId: existing.id, revision: existing.revision, changed: true };
    }
    await checkBudget(ctx, w.id, base.size * 2, 0, true);
    const id = newId("planningArtifact");
    ctx.write(
      ctx.db.insertInto("core_planning_artifacts").values({
        id,
        work_item_id: w.id,
        kind,
        design_type: designType,
        title: input.path.split("/").pop() ?? input.path,
        description: `Pulled from ${input.path}`,
        revision: 1,
        keep: 1,
        pulled_path: input.path,
        pulled_base_sha: head,
        created_by: ctx.actor.id,
        created_at: ctx.now,
        updated_at: ctx.now,
      }),
    );
    ctx.write(
      ctx.db.insertInto("core_planning_artifact_revisions").values({ artifact_id: id, ...base }),
    );
    ctx.write(
      ctx.db
        .insertInto("core_planning_artifact_revisions")
        .values({ artifact_id: id, ...base, revision: 1 }),
    );
    guardBudget(ctx, w.id);
    logPlanning(ctx, w.id, "artifact.added", { artifactId: id, revision: 1, pulled: input.path });
    return { artifactId: id, revision: 1, changed: false };
  },
});
