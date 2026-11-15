// flow.project.* and flow.agent.*: an org's projects (each on a workflow) and its agents.
import {
  createAgent,
  createProject,
  getProject,
  listAgents,
  listProjects,
  setProjectWorkflow,
  updateAgent,
} from "@software-factory/store";
import { z } from "zod";
import { defineOperation, id, OpError, orgId } from "./operation.ts";

const project = {
  name: z.string().min(1).max(80),
  /** Prefixes item numbers ("ACM-12"). */
  key: z.string().min(1).max(10),
};

const agent = {
  name: z.string().min(1).max(80),
  instructions: z.string().max(20_000),
  /**
   * The MCP servers its runs get. "factory" is the engine's own: every flow.* operation and the
   * plugin editor. Left out on update: unchanged.
   */
  mcp: z.array(z.string().min(1).max(64)).max(20).optional(),
};

export const projectOps = [
  defineOperation({
    name: "flow.project.create",
    description:
      "Create a project: a name, a key for item numbers (ACM), and the workflow its items move through.",
    risk: "write",
    input: z.object({ orgId, ...project, workflowId: id }),
    handler: (input, ctx) =>
      createProject(ctx.d1, {
        orgId: ctx.orgId,
        name: input.name,
        key: input.key,
        workflowId: input.workflowId,
      }),
  }),
  defineOperation({
    name: "flow.project.get",
    description: "One project.",
    risk: "read",
    input: z.object({ orgId, projectId: id }),
    handler: async (input, ctx) => {
      const found = await getProject(ctx.d1, input.projectId);
      if (!found) throw new OpError("not_found", `No project ${input.projectId}.`);
      return found;
    },
  }),
  defineOperation({
    name: "flow.project.list",
    description: "The org's projects, by name.",
    risk: "read",
    input: z.object({ orgId }),
    handler: async (_input, ctx) => ({ projects: await listProjects(ctx.d1, ctx.orgId) }),
  }),
  defineOperation({
    name: "flow.project.setWorkflow",
    description: "Point a project at another workflow. Its items keep their status ids.",
    risk: "write",
    input: z.object({ orgId, projectId: id, workflowId: id }),
    handler: async (input, ctx) => {
      await setProjectWorkflow(ctx.d1, input.projectId, input.workflowId);
      return getProject(ctx.d1, input.projectId);
    },
  }),
];

export const agentOps = [
  defineOperation({
    name: "flow.agent.create",
    description:
      "Create an agent: a name, the instructions it runs with, and optionally `mcp`, the MCP servers its runs get ([\"factory\"]: the engine's own, with every flow.* operation and the plugin editor). A status's owner names it by id.",
    risk: "write",
    input: z.object({ orgId, ...agent }),
    handler: (input, ctx) =>
      createAgent(ctx.d1, {
        orgId: ctx.orgId,
        name: input.name,
        instructions: input.instructions,
        ...(input.mcp ? { mcp: input.mcp } : {}),
      }),
  }),
  defineOperation({
    name: "flow.agent.update",
    description:
      "Change an agent's name and instructions, and its MCP servers when `mcp` is given. Runs already claimed keep what they got.",
    risk: "write",
    input: z.object({ orgId, agentId: id, ...agent }),
    handler: (input, ctx) =>
      updateAgent(ctx.d1, input.agentId, {
        name: input.name,
        instructions: input.instructions,
        ...(input.mcp ? { mcp: input.mcp } : {}),
      }),
  }),
  defineOperation({
    name: "flow.agent.list",
    description: "The org's agents, by name.",
    risk: "read",
    input: z.object({ orgId }),
    handler: async (_input, ctx) => ({ agents: await listAgents(ctx.d1, ctx.orgId) }),
  }),
];
