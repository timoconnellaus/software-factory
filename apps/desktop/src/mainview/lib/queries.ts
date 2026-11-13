// TanStack Query options for every read the desktop makes, through `read()` (one `batch` on the
// client door per tick). Route loaders `ensureQueryData` everything their page renders, so a
// navigation fetches in one request; a cached page shows at once and refreshes in the background.
// The keys match sf-app's, so the screens ported from it invalidate the same way.
import type { OpOutput, Project } from "@software-factory/client/ops";
import { queryOptions, useQueryClient } from "@tanstack/react-query";
import { read } from "./op.ts";

export interface Me {
  user: { id: string; name: string; githubLogin: string | null };
  orgs: { id: string; name: string; kind: string; role: string }[];
  /** The Personal org (every user has one). */
  personalOrgId: string | null;
}

/** Who is signed in and their orgs (`org.list`), the desktop's stand-in for sf-app's session. */
export const meQuery = (login: string | null) =>
  queryOptions({
    queryKey: ["me", login],
    queryFn: async (): Promise<Me> => {
      const { orgs, userId } = await read("org.list", {});
      return {
        user: { id: userId, name: login ?? "you", githubLogin: login },
        orgs,
        personalOrgId: orgs.find((o) => o.kind === "personal")?.id ?? null,
      };
    },
    staleTime: 5 * 60_000,
  });

export const inboxQuery = () =>
  queryOptions({
    queryKey: ["inbox"],
    queryFn: () => read("inbox.list", {}),
    staleTime: 10_000,
    refetchInterval: 15_000,
  });

export const workItemQuery = (workItemId: string) =>
  queryOptions({
    queryKey: ["workItem", workItemId],
    queryFn: () => read("workItem.get", { workItemId }),
    staleTime: 5_000,
    refetchInterval: 10_000,
  });

export const timelineQuery = (workItemId: string) =>
  queryOptions({
    queryKey: ["workItem", workItemId, "timeline"],
    queryFn: () => read("workItem.timeline", { workItemId }),
    staleTime: 5_000,
    refetchInterval: 10_000,
  });

/** How often the Planning tab re-reads while it is open. */
/** A fallback only: the engine pushes `planning.changed` to the live socket (spec 26). */
export const PLANNING_POLL_MS = 30_000;

/**
 * A work item's planning (spec 20). The engine pushes a change to the desktop's live socket for
 * whoever has the view open, and the Planning tab re-reads then (spec 26); this slow poll covers a
 * dropped socket.
 */
export const planningQuery = (workItemId: string) =>
  queryOptions({
    queryKey: ["workItem", workItemId, "planning"],
    queryFn: () => read("planning.get", { workItemId }),
    staleTime: 2_000,
    refetchInterval: PLANNING_POLL_MS,
  });

/** A work item's attachments (ADR 0310): metadata only. */
export const attachmentsQuery = (workItemId: string) =>
  queryOptions({
    queryKey: ["workItem", workItemId, "attachments"],
    queryFn: () => read("workItem.attachment.list", { workItemId }),
    staleTime: 10_000,
  });

/** One attachment's bytes, as `{ $bytes: base64 }` from the door (shown as a blob URL). */
export const attachmentBytesQuery = (attachmentId: string) =>
  queryOptions({
    queryKey: ["attachment", attachmentId],
    queryFn: () => read("workItem.attachment.get", { attachmentId }),
    staleTime: Number.POSITIVE_INFINITY,
  });

/** Every project in every org the user belongs to. */
export const projectsQuery = (orgIds: string[]) =>
  queryOptions({
    queryKey: ["projects", orgIds],
    queryFn: async (): Promise<Project[]> => {
      const lists = await Promise.all(orgIds.map((orgId) => read("project.list", { orgId })));
      return lists.flatMap((l) => l.projects);
    },
    staleTime: 60_000,
  });

export const workListQuery = (orgId: string) =>
  queryOptions({
    queryKey: ["work", orgId],
    queryFn: () => read("workItem.list", { orgId, limit: 100 }),
    staleTime: 10_000,
    refetchInterval: 15_000,
  });

/**
 * Every org's recent work items, merged newest first: the shell's lists, pins and search (ADR 0460).
 * The rail's org scope filters this on the client.
 */
export const workListsQuery = (orgIds: string[]) =>
  queryOptions({
    queryKey: ["work", "all", orgIds],
    queryFn: async () => {
      const lists = await Promise.all(
        orgIds.map((orgId) => read("workItem.list", { orgId, limit: 100 })),
      );
      return lists
        .flatMap((l) => l.items)
        .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    },
    staleTime: 10_000,
    refetchInterval: 15_000,
  });

/** An open archive incident, tagged with its org. */
export type ArchiveIncident = OpOutput<"incident.listArchiveMissing">["incidents"][number] & {
  orgId: string;
};

/**
 * Every org's open archive incidents (`incident.listArchiveMissing`): runs whose archived log lost an
 * object, a record for a person to resolve. Read when Checks and incidents opens, never polled (an
 * indexed read of a near-empty partial index, but not one to add to every tick).
 */
export const archiveIncidentsQuery = (orgIds: string[]) =>
  queryOptions({
    queryKey: ["incidents", "archive", orgIds],
    queryFn: async () => {
      const lists = await Promise.all(
        orgIds.map(async (orgId) => {
          const r = await read("incident.listArchiveMissing", { orgId });
          const incidents: ArchiveIncident[] = r.incidents.map((i) => ({ ...i, orgId }));
          return { more: r.more, incidents };
        }),
      );
      return {
        incidents: lists
          .flatMap((l) => l.incidents)
          .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)),
        more: lists.some((l) => l.more),
      };
    },
    staleTime: 60_000,
  });

/**
 * Every org's board (spec 50, `workItem.board`): backlog, shaping, ready, queued and active items in
 * pull order, each tagged with its org, and the counts per project and state (done and stopped
 * included), which the Work list shows. The rail's org scope filters this on the client. With a
 * project, only that project's (the server filters by its index, and its 500 cap is the project's).
 * The live socket's events refresh it (routes/root.tsx); the slow poll covers a dropped socket.
 */
export const boardsQuery = (orgIds: string[], projectId: string | null = null) =>
  queryOptions({
    queryKey: ["work", "board", orgIds, projectId],
    queryFn: async () => {
      const boards = await Promise.all(
        orgIds.map(async (orgId) => ({
          orgId,
          board: await read("workItem.board", projectId ? { orgId, projectId } : { orgId }),
        })),
      );
      return {
        items: boards.flatMap(({ orgId, board }) => board.items.map((i) => ({ ...i, orgId }))),
        counts: boards.flatMap(({ orgId, board }) => board.counts.map((c) => ({ ...c, orgId }))),
      };
    },
    staleTime: 10_000,
    refetchInterval: 60_000,
  });

/**
 * The workflow a project's items follow and its stages in order, each with its label and phase
 * (`project.workflow`, ADR 0492/0493): what New work names and the board's lanes come from.
 */
export const workflowQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["workflow", projectId],
    queryFn: () => read("project.workflow", { projectId }),
    staleTime: 60_000,
  });

/** A project's factory config (ADR 0370): its workflow and approvers, for the project page. */
export const configQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["config", projectId],
    queryFn: () => read("config.get", { projectId }),
    staleTime: 60_000,
  });

export const runnersQuery = () =>
  queryOptions({
    queryKey: ["runners"],
    queryFn: () => read("runner.list", {}),
    staleTime: 30_000,
  });

/** The Setup checklist for an org, live (GitHub, project, policy, runner, factory/verify). */
export const setupStatusQuery = (orgId: string) =>
  queryOptions({
    queryKey: ["setup", orgId],
    queryFn: () => read("setup.status", { orgId }),
    staleTime: 30_000,
    refetchInterval: 30_000,
  });

export const reposQuery = (orgId: string) =>
  queryOptions({
    queryKey: ["repos", orgId],
    queryFn: () => read("github.repos", { orgId }),
    staleTime: 30_000,
  });

export const routingQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["routing", projectId],
    queryFn: () => read("workItem.previewRouting", { projectId }),
    staleTime: 10_000,
  });

/** The project's open PRs no work item owns yet (New work's Attach list, spec 05). */
export const openPullsQuery = (projectId: string) =>
  queryOptions({
    queryKey: ["open-pulls", projectId],
    queryFn: () => read("github.openPullRequests", { projectId }),
    staleTime: 30_000,
  });

/** What `/attach` shows for one PR (spec 05). */
export const attachPreviewQuery = (repo: { owner: string; name: string }, prNumber: number) =>
  queryOptions({
    queryKey: ["attach", repo.owner, repo.name, prNumber],
    queryFn: () => read("workItem.previewAttach", { repo, prNumber }),
    staleTime: 10_000,
    retry: false,
  });

/** After a decision: everything that shows gates, items or counts. */
export function useRefreshAfterDecision() {
  const queryClient = useQueryClient();
  return (workItemId?: string) =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["inbox"] }),
      queryClient.invalidateQueries({ queryKey: ["work"] }),
      // A config change an approver decided (ADR 0610): the Policy page re-reads the project's.
      queryClient.invalidateQueries({ queryKey: ["config"] }),
      workItemId
        ? queryClient.invalidateQueries({ queryKey: ["workItem", workItemId] })
        : Promise.resolve(),
    ]);
}
