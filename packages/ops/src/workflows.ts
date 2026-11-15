// flow.workflow.*: an org's workflows, each an ordered list of statuses with owners.
import {
  createWorkflow,
  getWorkflow,
  listWorkflows,
  updateWorkflow,
  type WorkflowWrite,
} from "@software-factory/store";
import { z } from "zod";
import { defineOperation, id, OpError, orgId } from "./operation.ts";

const definition = {
  name: z.string().min(1).max(80),
  /** Checked in full by the kernel's checkWorkflow; a problem comes back as invalid_input. */
  statuses: z.array(z.unknown()).min(1).max(50),
};

function written(write: WorkflowWrite) {
  if (!write.ok) {
    throw new OpError(
      "invalid_input",
      write.problems.map((p) => p.message).join(" "),
      write.problems,
    );
  }
  return write.workflow;
}

export const workflowOps = [
  defineOperation({
    name: "flow.workflow.create",
    description:
      "Create a workflow: a name and an ordered list of statuses. Each status has an id, a name, an owner ({ kind: 'agent', agentId } | { kind: 'person', userId } | { kind: 'none' }), a brief for an agent owner, and optionally onDone, onReject (status ids) and needsDecision. Refused if a status points at one that doesn't exist.",
    risk: "write",
    input: z.object({ orgId, ...definition }),
    handler: async (input, ctx) =>
      written(
        await createWorkflow(ctx.d1, ctx.orgId, { name: input.name, statuses: input.statuses }),
      ),
  }),
  defineOperation({
    name: "flow.workflow.update",
    description:
      "Replace a workflow's name and statuses. Items keep their status ids; checked like flow.workflow.create.",
    risk: "write",
    input: z.object({ orgId, workflowId: id, ...definition }),
    handler: async (input, ctx) =>
      written(
        await updateWorkflow(ctx.d1, input.workflowId, {
          name: input.name,
          statuses: input.statuses,
        }),
      ),
  }),
  defineOperation({
    name: "flow.workflow.get",
    description: "One workflow with its statuses.",
    risk: "read",
    input: z.object({ orgId, workflowId: id }),
    handler: async (input, ctx) => {
      const workflow = await getWorkflow(ctx.d1, input.workflowId);
      if (!workflow) throw new OpError("not_found", `No workflow ${input.workflowId}.`);
      return workflow;
    },
  }),
  defineOperation({
    name: "flow.workflow.list",
    description: "The org's workflows, by name.",
    risk: "read",
    input: z.object({ orgId }),
    handler: async (_input, ctx) => ({ workflows: await listWorkflows(ctx.d1, ctx.orgId) }),
  }),
];
