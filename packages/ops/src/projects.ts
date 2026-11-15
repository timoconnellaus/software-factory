// flow.project.* and flow.agent.*: an org's projects (each on a workflow) and its agents.
import type { FlowGitHub } from "@software-factory/plugins";
import {
  createAgent,
  createProject,
  getProject,
  listAgents,
  listProjects,
  orgInstallations,
  type ProjectRepo,
  setProjectRepo,
  setProjectWorkflow,
  updateAgent,
} from "@software-factory/store";
import { z } from "zod";
import { type Ctx, defineOperation, id, OpError, orgId } from "./operation.ts";

/** The most repositories flow.github.repos lists. */
export const REPO_LIST_CAP = 200;

function githubOf(ctx: Ctx): FlowGitHub {
  if (!ctx.host.github) throw new OpError("unavailable", "This engine has no GitHub App set up.");
  return ctx.host.github;
}

/**
 * The repositories the org's active GitHub App installations reach, at most REPO_LIST_CAP. One
 * GitHub call (paged) per installation: never on a polled path.
 */
async function reachableRepos(ctx: Ctx): Promise<{
  connected: boolean;
  account: string | null;
  repos: ProjectRepo[];
}> {
  const installations = await orgInstallations(ctx.d1, ctx.orgId);
  if (installations.length === 0) return { connected: false, account: null, repos: [] };
  const github = githubOf(ctx);
  const repos: ProjectRepo[] = [];
  for (const installation of installations) {
    if (repos.length >= REPO_LIST_CAP) break;
    for (const r of await github.installationRepos(installation.installationId)) {
      repos.push({ ...r, installationId: installation.installationId });
    }
  }
  repos.sort((a, b) => `${a.owner}/${a.name}`.localeCompare(`${b.owner}/${b.name}`));
  return {
    connected: true,
    account: installations.map((i) => i.accountLogin).join(", "),
    repos: repos.slice(0, REPO_LIST_CAP),
  };
}

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
    description:
      "The org's projects, by name, each with `openCount`: its items waiting on something (an agent, a person or a decision) or stopped with an error.",
    risk: "read",
    input: z.object({ orgId }),
    handler: async (_input, ctx) => ({ projects: await listProjects(ctx.d1, ctx.orgId) }),
  }),
  defineOperation({
    name: "flow.project.setRepository",
    description:
      "Give a project a GitHub repository ({ owner, name }), or take it away ({ clear: true }). The repository must be one the org's GitHub connection reaches (flow.github.repos); its default branch is stored with it. An agent's run on an item of a project with a repository works in a checkout of it, on the item's branch factory/flow-<key>-<number>, which the runner pushes; plugins reach it through the built-in `github` gateway.",
    risk: "write",
    input: z.union([
      z.object({
        orgId,
        projectId: id,
        owner: z.string().min(1).max(100),
        name: z.string().min(1).max(100),
      }),
      z.object({ orgId, projectId: id, clear: z.literal(true) }),
    ]),
    handler: async (input, ctx) => {
      if ("clear" in input) {
        await setProjectRepo(ctx.d1, input.projectId, null);
      } else {
        const { connected, repos } = await reachableRepos(ctx);
        if (!connected) {
          throw new OpError(
            "conflict",
            "The org has no GitHub connection. Connect GitHub first, then pick a repository.",
          );
        }
        const want = `${input.owner}/${input.name}`.toLowerCase();
        const repo = repos.find((r) => `${r.owner}/${r.name}`.toLowerCase() === want);
        if (!repo) {
          throw new OpError(
            "not_found",
            `The org's GitHub connection doesn't reach ${input.owner}/${input.name}.`,
          );
        }
        await setProjectRepo(ctx.d1, input.projectId, repo);
      }
      return getProject(ctx.d1, input.projectId);
    },
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

export const githubOps = [
  defineOperation({
    name: "flow.github.repos",
    description:
      "The GitHub repositories the org's GitHub connection reaches (at most 200), for flow.project.setRepository: { connected, account, repos: [{ owner, name, defaultBranch, installationId }] }. `connected` is false when the org hasn't connected GitHub. Asks GitHub, so it is slow.",
    risk: "read",
    input: z.object({ orgId }),
    handler: (_input, ctx) => reachableRepos(ctx),
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
    description:
      "The org's agents, by name, each with `workingOn`: { itemId, itemTitle, itemNumber, projectKey } of its claimed run (else its oldest queued one), or null.",
    risk: "read",
    input: z.object({ orgId }),
    handler: async (_input, ctx) => ({ agents: await listAgents(ctx.d1, ctx.orgId) }),
  }),
];
