// Factory incidents (V1 scope, the improvement loop): when a PR is sent back or a run fails or
// stalls, a new work item in the same project proposes a fix to `.factory/` (a check, a skill or
// prompt, context, policy) plus a regression case in evals/. It goes through the normal gates.
// Depth limit: an incident's own failures don't open further incidents.
import { sql } from "kysely";
import { z } from "zod";
import { OperationError } from "../errors.ts";
import { newId } from "../ids.ts";
import { classifyIncident, ROOT_CAUSES } from "../incidents/classify.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { startPipeline } from "./backlog.ts";
import { createWorkItem, requireProject, requireWorkItem, workItemId } from "./shared.ts";

export async function openIncident(
  ctx: HandlerContext,
  input: {
    kind: "sent_back" | "run_failed" | "run_stalled" | "manual";
    reason: string;
    runId: string | null;
  },
): Promise<{ incidentId: string; fixWorkItemId: string; rootCause: string } | null> {
  const w = requireWorkItem(ctx);
  if (w.kind === "incident") return null;
  // An attached PR was built outside the factory: sending it back is review of a person's work, not
  // a factory failure (spec 05, ADR 0290). Its verify runs failing still are.
  if (w.kind === "attached" && input.kind === "sent_back") return null;
  const project = requireProject(ctx);
  const incidentId = newId("incident");
  const { rootCause, proposedFix } = classifyIncident({ ...input, incidentId });
  const what =
    input.kind === "sent_back"
      ? "was sent back at review"
      : input.kind === "run_stalled"
        ? "had a run that stalled"
        : input.kind === "run_failed"
          ? "had a run that failed"
          : "needs a factory fix";
  const fix = createWorkItem(ctx, {
    project,
    // The incident's fix goes to the same repository as the item it is about (ADR 0490).
    repositoryId: w.repository_id,
    title: `Factory incident: #${w.number} ${what}`,
    body: [
      `Work item #${w.number} (${w.title}) ${what}.`,
      "",
      `Reason: ${input.reason}`,
      "",
      "Propose a fix to `.factory/` (a check, a skill or prompt, context, or policy) that would have",
      "prevented this, plus a regression case in `evals/`.",
      "",
      `Incident: ${incidentId}`,
      "",
      proposedFix,
    ].join("\n"),
    source: "incident",
    kind: "incident",
    requesterUserId: w.requester_user_id,
    parentWorkItemId: w.id,
    number: project.next_number,
    // The factory's own fix skips the backlog and the active limit (ADR 0491): started at once.
    state: "queued",
  });
  startPipeline(ctx, fix, project, { policy: ctx.scope.policy, trial: null });
  // createWorkItem pointed the audit row at the new item; this call is about the source item.
  ctx.subject({ workItemId: w.id });
  ctx.write(
    ctx.db.insertInto("core_incidents").values({
      id: incidentId,
      org_id: w.org_id,
      project_id: w.project_id,
      source_work_item_id: w.id,
      run_id: input.runId,
      kind: input.kind,
      reason: input.reason,
      fix_work_item_id: fix.id,
      created_by: ctx.actor.id,
      created_at: ctx.now,
      root_cause: rootCause,
      proposed_fix: proposedFix,
    }),
  );
  ctx.change({
    entity: "incident",
    id: incidentId,
    after: { kind: input.kind, fixWorkItemId: fix.id, rootCause },
  });
  return { incidentId, fixWorkItemId: fix.id, rootCause };
}

/**
 * A run's archived log is lost (an object the chunk index names is gone from sf-archive): an
 * incident for a person, recorded and nothing more. No agent can bring the object back, so there is
 * no work item at all (nothing a person could release into the incident workflow, whose fixes can
 * auto-merge): the record is a core_incidents row of kind `archive_missing` with no fix item, listed
 * on the desktop's Checks and incidents page (incident.listArchiveMissing) until a person resolves
 * it (incident.resolve). One per run: the row is written only while the run has none, and the batch
 * aborts otherwise (a viewer and the daily sample racing each other).
 */
export function openArchiveIncident(
  ctx: HandlerContext,
  input: { runId: string; runNo: number; key: string },
): { incidentId: string } {
  const w = requireWorkItem(ctx);
  const incidentId = newId("incident");
  ctx.subject({ workItemId: w.id });
  ctx.write(
    ctx.db
      .insertInto("core_incidents")
      .columns([
        "id",
        "org_id",
        "project_id",
        "source_work_item_id",
        "run_id",
        "kind",
        "reason",
        "created_by",
        "created_at",
      ])
      // Selected from the source item's own row (one row), unless the run already has one.
      .expression(
        ctx.db
          .selectFrom("core_work_items")
          .select([
            sql<string>`${incidentId}`.as("id"),
            sql<string>`${w.org_id}`.as("org_id"),
            sql<string>`${w.project_id}`.as("project_id"),
            sql<string>`${w.id}`.as("source_work_item_id"),
            sql<string>`${input.runId}`.as("run_id"),
            sql<string>`'archive_missing'`.as("kind"),
            sql<string>`${`run ${input.runNo}'s archived log: ${input.key} is missing from sf-archive`}`.as(
              "reason",
            ),
            sql<string>`${ctx.actor.id}`.as("created_by"),
            sql<string>`${ctx.now}`.as("created_at"),
          ])
          .where("id", "=", w.id)
          .where(
            sql<boolean>`NOT EXISTS (SELECT 1 FROM core_incidents WHERE run_id = ${input.runId} AND kind = 'archive_missing')`,
          ),
      ),
  );
  ctx.guardChanged("one archive incident per run");
  ctx.change({
    entity: "incident",
    id: incidentId,
    after: { kind: "archive_missing", runId: input.runId, key: input.key },
  });
  return { incidentId };
}

/** How many open archive incidents incident.listArchiveMissing returns at most. */
export const ARCHIVE_INCIDENTS_MAX = 50;

export const incidentListArchiveMissing = defineOperation({
  name: "incident.listArchiveMissing",
  description:
    "The org's open archive incidents, newest first: runs whose archived log lost an object in sf-archive. Each is a record for a person (no work item, no agent): check the bucket, then resolve it with incident.resolve. Read when the Checks and incidents page opens, not polled.",
  risk: "read",
  actors: ["human"],
  permission: "member",
  input: z.object({ orgId: z.string().min(1) }),
  output: z.object({
    incidents: z.array(
      z.object({
        id: z.string(),
        projectId: z.string(),
        workItemId: z.string(),
        workItemNumber: z.number(),
        workItemTitle: z.string(),
        runId: z.string().nullable(),
        reason: z.string(),
        createdAt: z.string(),
      }),
    ),
    /** More are open than were returned. */
    more: z.boolean(),
  }),
  async handler(input, ctx) {
    // core_incidents_open_archive_idx: (org_id, created_at) over the open archive incidents only.
    const rows = await ctx.db
      .selectFrom("core_incidents as i")
      .innerJoin("core_work_items as w", "w.id", "i.source_work_item_id")
      .select([
        "i.id",
        "i.project_id",
        "i.source_work_item_id",
        "w.number",
        "w.title",
        "i.run_id",
        "i.reason",
        "i.created_at",
      ])
      .where("i.org_id", "=", input.orgId)
      .where("i.kind", "=", "archive_missing")
      .where("i.resolved_at", "is", null)
      .orderBy("i.created_at", "desc")
      .limit(ARCHIVE_INCIDENTS_MAX + 1)
      .execute();
    return {
      incidents: rows.slice(0, ARCHIVE_INCIDENTS_MAX).map((r) => ({
        id: r.id,
        projectId: r.project_id,
        workItemId: r.source_work_item_id,
        workItemNumber: r.number,
        workItemTitle: r.title,
        runId: r.run_id,
        reason: r.reason,
        createdAt: r.created_at,
      })),
      more: rows.length > ARCHIVE_INCIDENTS_MAX,
    };
  },
});

export const incidentResolve = defineOperation({
  name: "incident.resolve",
  description:
    "Close an archive incident (a run's archived log lost an object) once an org admin has dealt with it: restored the object, or accepted the loss. Says what was done. Only for archive incidents (one recorded before migration 0365 also has a backlog work item: cancel that by hand); other incidents close with their fix item.",
  risk: "write",
  actors: ["human"],
  permission: "admin",
  input: z.object({
    workItemId,
    incidentId: z.string().min(1),
    resolution: z.string().trim().min(1).max(2_000),
  }),
  output: z.object({ resolved: z.boolean() }),
  async handler(input, ctx) {
    const w = requireWorkItem(ctx);
    const row = await ctx.db
      .selectFrom("core_incidents")
      .select(["id", "kind", "resolved_at"])
      .where("id", "=", input.incidentId)
      .where("source_work_item_id", "=", w.id)
      .executeTakeFirst();
    if (!row) throw new OperationError("not_found", "no such incident on this work item");
    if (row.kind !== "archive_missing") {
      throw new OperationError(
        "conflict",
        "only an archive incident is resolved by itself; this one closes with its fix work item",
      );
    }
    if (row.resolved_at !== null) return { resolved: false };
    ctx.write(
      ctx.db
        .updateTable("core_incidents")
        .set({ resolved_at: ctx.now, resolved_by: ctx.actor.id, resolution: input.resolution })
        .where("id", "=", row.id)
        .where("resolved_at", "is", null),
    );
    ctx.guardChanged("the incident is still open");
    ctx.change({
      entity: "incident",
      id: row.id,
      before: { resolvedAt: null },
      after: { resolvedAt: ctx.now, resolution: input.resolution },
    });
    return { resolved: true };
  },
});

export const incidentOpen = defineOperation({
  name: "incident.open",
  description:
    "Open a factory incident for a work item: a new work item that proposes a `.factory/` fix plus an eval regression case. Opened automatically when a run fails or stalls and when a PR is sent back; people can open one too. Not opened for incident work items themselves (depth limit).",
  risk: "write",
  actors: ["agent", "human"],
  permission: "member",
  input: z.object({
    workItemId,
    kind: z.enum(["run_failed", "run_stalled", "manual"]),
    reason: z.string().min(1).max(8_000),
    runId: z.string().nullable().default(null),
  }),
  output: z.object({
    incidentId: z.string().nullable(),
    fixWorkItemId: z.string().nullable(),
    rootCause: z.enum(ROOT_CAUSES).nullable(),
  }),
  async handler(input, ctx) {
    const opened = await openIncident(ctx, input);
    return {
      incidentId: opened?.incidentId ?? null,
      fixWorkItemId: opened?.fixWorkItemId ?? null,
      rootCause: (opened?.rootCause as (typeof ROOT_CAUSES)[number] | undefined) ?? null,
    };
  },
});
