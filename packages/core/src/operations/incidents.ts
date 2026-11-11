// Factory incidents (V1 scope, the improvement loop): when a PR is sent back or a run fails or
// stalls, a new work item in the same project proposes a fix to `.factory/` (a check, a skill or
// prompt, context, policy) plus a regression case in evals/. It goes through the normal gates.
// Depth limit: an incident's own failures don't open further incidents.
import { z } from "zod";
import { newId } from "../ids.ts";
import { classifyIncident, ROOT_CAUSES } from "../incidents/classify.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
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
  });
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
