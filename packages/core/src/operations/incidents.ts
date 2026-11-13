// Factory incidents (V1 scope, the improvement loop): when a PR is sent back or a run fails or
// stalls, a new work item in the same project proposes a fix to `.factory/` (a check, a skill or
// prompt, context, policy) plus a regression case in evals/. It goes through the normal gates.
// Depth limit: an incident's own failures don't open further incidents.
import { sql } from "kysely";
import { z } from "zod";
import { newId } from "../ids.ts";
import { classifyIncident, ROOT_CAUSES } from "../incidents/classify.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { holdAutoApproval } from "./auto-approve.ts";
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
  // An incident holds dark factory mode on the project (ADR 0515 §7), when its workflow has it on.
  await holdAutoApproval(ctx, project, `factory incident on #${w.number}: ${what}`, [incidentId]);
  return { incidentId, fixWorkItemId: fix.id, rootCause };
}

/**
 * A run's archived log is lost (an object the chunk index names is gone from sf-archive): an
 * incident for a person, never one that starts an agent's fix, since no agent can bring the object
 * back. Its record is a work item of kind `incident` left in the backlog (nothing runs until a
 * person releases it; it shows in Checks and incidents) and a core_incidents row of kind
 * `archive_missing`. One per run: the row is written only while the run has none, and the batch
 * aborts otherwise (a viewer and the daily sample racing each other).
 */
export function openArchiveIncident(
  ctx: HandlerContext,
  input: { runId: string; runNo: number; key: string },
): { incidentId: string; workItemId: string; number: number } {
  const w = requireWorkItem(ctx);
  const project = requireProject(ctx);
  const incidentId = newId("incident");
  const fix = createWorkItem(ctx, {
    project,
    repositoryId: w.repository_id,
    title: `Factory incident: #${w.number} run ${input.runNo}'s archived log is missing`,
    body: [
      `Run ${input.runNo} of work item #${w.number} (${w.title}) was archived, and part of its log`,
      `is no longer in the archive: \`${input.key}\` is missing from sf-archive.`,
      "",
      "This needs a person: an agent can't bring the object back. Check the bucket (a lifecycle",
      "rule, a manual delete, a restore from a backup) and close this item when it is resolved.",
      "",
      `Incident: ${incidentId}`,
    ].join("\n"),
    source: "incident",
    kind: "incident",
    requesterUserId: w.requester_user_id,
    parentWorkItemId: w.id,
    number: project.next_number,
    // Left in the backlog: nothing runs until a person releases it (ADR 0491).
    state: "backlog",
  });
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
        "fix_work_item_id",
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
            sql<string>`${`${input.key} is missing from sf-archive`}`.as("reason"),
            sql<string>`${fix.id}`.as("fix_work_item_id"),
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
    after: { kind: "archive_missing", runId: input.runId, fixWorkItemId: fix.id },
  });
  return { incidentId, workItemId: fix.id, number: fix.number };
}

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
