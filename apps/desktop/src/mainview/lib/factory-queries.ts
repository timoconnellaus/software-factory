// The Factory and Settings sections' reads (spec 41, slices 5 and 6), through `read()` like the
// rest of lib/queries.ts. Kept apart so the sections can grow without touching the shell's reads.
import { queryOptions } from "@tanstack/react-query";
import { read } from "./op.ts";

/** Each project's merge queue, head first (ADR 0330), keyed by project. */
export const mergeQueuesQuery = (projectIds: string[]) =>
  queryOptions({
    queryKey: ["mergeQueue", projectIds],
    queryFn: async () => {
      const lists = await Promise.all(
        projectIds.map((projectId) => read("mergeQueue.list", { projectId })),
      );
      return projectIds.map((projectId, i) => ({ projectId, entries: lists[i]?.entries ?? [] }));
    },
    staleTime: 15_000,
    refetchInterval: 30_000,
  });

/** A project's config (ADR 0370): the current version's document, history and pending saves. */
export const configQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["config", projectId],
    queryFn: () => read("config.get", { projectId }),
    staleTime: 30_000,
  });

/** The factory's own practice changes on a project (ADR 0373), newest first. */
export const trialsQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["config", projectId, "trials"],
    queryFn: () => read("config.trials", { projectId, limit: 20 }),
    staleTime: 30_000,
  });

/** The adjudicator's record against a project's people (spec gates and gate steps). */
export const adjudicatorQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["config", projectId, "adjudicator"],
    queryFn: () => read("adjudicator.stats", { projectId }),
    staleTime: 30_000,
  });

/** An org workflow with its stages' settings (a project on it overrides some of them). */
export const orgWorkflowQuery = (orgId: string, workflowId: string) =>
  queryOptions({
    queryKey: ["workflow", orgId, workflowId],
    queryFn: () => read("workflow.get", { orgId, workflowId }),
    staleTime: 30_000,
  });

/** The org's workflows (spec 52), for a project to run one. */
export const orgWorkflowsQuery = (orgId: string) =>
  queryOptions({
    queryKey: ["workflows", orgId],
    queryFn: () => read("workflow.list", { orgId }),
    staleTime: 60_000,
  });

/** An org's config (spec 52): its workflows and agents, history, and changes waiting. */
export const orgConfigQuery = (orgId: string) =>
  queryOptions({
    queryKey: ["orgConfig", orgId],
    queryFn: () => read("orgConfig.get", { orgId }),
    staleTime: 30_000,
  });

/** The stage types a workflow is built from, with their settings' defaults. */
export const stageTypesQuery = () =>
  queryOptions({
    queryKey: ["stageTypes"],
    queryFn: () => read("stageType.list", {}),
    staleTime: 10 * 60_000,
  });

/** An org's kill switches and its projects' (ADR 0044). */
export const killSwitchesQuery = (orgId: string) =>
  queryOptions({
    queryKey: ["killSwitches", orgId],
    queryFn: () => read("killSwitch.list", { orgId }),
    staleTime: 30_000,
  });

/** The org workflow a project's config runs on, if it names one (`wf_…`). */
export const orgWorkflowOf = (doc: Record<string, unknown> | null | undefined): string | null =>
  typeof doc?.workflow === "string" && doc.workflow.startsWith("wf_") ? doc.workflow : null;

/** Every org's Setup status, for Settings' repositories (protection) and connections. */
export const setupStatusesQuery = (orgIds: string[]) =>
  queryOptions({
    queryKey: ["setup", "all", orgIds],
    queryFn: () => Promise.all(orgIds.map((orgId) => read("setup.status", { orgId }))),
    staleTime: 30_000,
  });

/** Your desktop devices and CLI tokens (Settings: Devices). */
export const devicesQuery = () =>
  queryOptions({
    queryKey: ["devices"],
    queryFn: async () => {
      const [desktop, cli] = await Promise.all([
        read("desktopDevice.list", {}),
        read("cliToken.list", {}),
      ]);
      return { devices: desktop.devices, tokens: cli.tokens };
    },
    staleTime: 30_000,
  });
