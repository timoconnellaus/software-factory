// Planning visuals (spec 21, ADR 0472): the planner's mockups, diagrams and documents. Each revision
// is kept in D1 with the controls it declares; the planner adds, revises, removes and shows them;
// people read them (`artifact.get`) to render them in a sandboxed frame. Questions that link to
// them are checked here (`checkQuestionVisuals`), so a binding to an undeclared control is refused.
import { parseJson } from "@software-factory/db";
import {
  ARTIFACT_MAX_BYTES,
  artifactAddInputSchema,
  artifactDeleteInputSchema,
  artifactReadInputSchema,
  artifactShowInputSchema,
  artifactUpdateInputSchema,
  declaredControls,
} from "@software-factory/runner-contract";
import { z } from "zod";
import { OperationError } from "../errors.ts";
import { newId } from "../ids.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { logPlanning } from "../planning.ts";
import { liveArtifact } from "../planning-visuals.ts";
import { byJob, planningJob, planningJobFields } from "./planning.ts";
import { requireWorkItem, workItemId } from "./shared.ts";

const bytes = (text: string) => new TextEncoder().encode(text).length;

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
    "The planning agent adds a mockup, diagram or document beside the plan (spec 21, ADR 0472). Its content is kept as revision 1, with the controls a mockup declares. People see it in the Mockups tab and on the canvas.",
  risk: "write",
  actors: ["runner"],
  permission: "signed-in",
  input: artifactAddInputSchema.extend(planningJobFields),
  output: z.object({
    artifactId: z.string(),
    revision: z.number(),
    controls: z.array(z.string()),
  }),
  scope: byJob,
  async handler(input, ctx) {
    const { session } = await planningJob(ctx, input);
    const w = requireWorkItem(ctx);
    if (bytes(input.content) > ARTIFACT_MAX_BYTES) {
      throw new OperationError(
        "invalid_input",
        `an artifact holds at most ${ARTIFACT_MAX_BYTES} bytes`,
      );
    }
    const id = newId("planningArtifact");
    const controls = controlsOf(input.kind, input.content);
    ctx.write(
      ctx.db.insertInto("core_planning_artifacts").values({
        id,
        work_item_id: w.id,
        kind: input.kind,
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
        size: bytes(input.content),
        controls: JSON.stringify(controls),
        created_at: ctx.now,
      }),
    );
    if (input.show) showArtifact(ctx, session.id, id);
    logPlanning(ctx, w.id, "artifact.added", { artifactId: id, revision: 1 });
    return { artifactId: id, revision: 1, controls };
  },
});

export const artifactUpdate = defineOperation({
  name: "artifact.update",
  description:
    "The planning agent revises an artifact: new content is a new revision (the old ones are kept); title, description, keep and show change in place. Answers with `warnings` when a question binds a control the new revision no longer declares.",
  risk: "write",
  actors: ["runner"],
  permission: "signed-in",
  input: artifactUpdateInputSchema.extend(planningJobFields),
  output: z.object({
    artifactId: z.string(),
    revision: z.number(),
    controls: z.array(z.string()),
    warnings: z.array(z.string()),
  }),
  scope: byJob,
  async handler(input, ctx) {
    const { session } = await planningJob(ctx, input);
    const w = requireWorkItem(ctx);
    const current = await liveArtifact(ctx, w.id, input.artifactId);
    let revision = current.revision;
    let controls = current.controls;
    let warnings: string[] = [];
    if (input.content !== undefined) {
      if (bytes(input.content) > ARTIFACT_MAX_BYTES) {
        throw new OperationError(
          "invalid_input",
          `an artifact holds at most ${ARTIFACT_MAX_BYTES} bytes`,
        );
      }
      revision = current.revision + 1;
      controls = controlsOf(current.kind, input.content);
      warnings = await droppedBindings(ctx, current.id, controls);
      ctx.write(
        ctx.db.insertInto("core_planning_artifact_revisions").values({
          artifact_id: current.id,
          revision,
          content: input.content,
          size: bytes(input.content),
          controls: JSON.stringify(controls),
          created_at: ctx.now,
        }),
      );
    }
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
    if (input.show) showArtifact(ctx, session.id, current.id);
    logPlanning(ctx, w.id, "artifact.updated", { artifactId: current.id, revision });
    return { artifactId: current.id, revision, controls, warnings };
  },
});

export const artifactDelete = defineOperation({
  name: "artifact.delete",
  description:
    "The planning agent removes an artifact from the plan's workspace. Its revisions stay in the record.",
  risk: "write",
  actors: ["runner"],
  permission: "signed-in",
  input: artifactDeleteInputSchema.extend(planningJobFields),
  output: z.object({ artifactId: z.string(), deleted: z.boolean() }),
  scope: byJob,
  async handler(input, ctx) {
    await planningJob(ctx, input);
    const w = requireWorkItem(ctx);
    const current = await liveArtifact(ctx, w.id, input.artifactId);
    ctx.write(
      ctx.db
        .updateTable("core_planning_artifacts")
        .set({ deleted_at: ctx.now, updated_at: ctx.now })
        .where("id", "=", current.id),
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
    "A planning artifact's content (spec 21), the latest revision unless one is named, for the Planning view to render in a sandboxed frame (ADR 0472). Untrusted HTML: never render it on the app's own origin.",
  risk: "read",
  actors: ["human"],
  permission: "member",
  input: z.object({
    workItemId,
    artifactId: z.string().min(1),
    revision: z.number().int().positive().optional(),
  }),
  output: z.object({
    artifactId: z.string(),
    kind: z.string(),
    title: z.string(),
    revision: z.number(),
    latest: z.number(),
    content: z.string(),
    controls: z.array(z.string()),
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
    if (!r) throw new OperationError("not_found", `no revision ${revision}`);
    return {
      artifactId: a.id,
      kind: a.kind,
      title: a.title,
      revision,
      latest: a.revision,
      content: r.content,
      controls: parseJson<string[]>(r.controls, []),
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
      .selectAll()
      .where("artifact_id", "=", a.id)
      .where("revision", "=", revision)
      .executeTakeFirst();
    if (!r) throw new OperationError("not_found", `no revision ${revision}`);
    return {
      artifactId: a.id,
      revision,
      content: r.content,
      controls: parseJson<string[]>(r.controls, []),
    };
  },
});
