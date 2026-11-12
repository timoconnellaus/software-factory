// The parts the Policy, Agents and Workflows pages share (spec 41, slice 5): which project's config
// they show, the footer with its version and where it is changed, and the notice when a change
// waits for an approver. The desktop never writes the config: a save is `config.save` on the
// website, where a loosening waits for an approver (ADR 0370), so every page links there.
import type { ConfigView, Project } from "@software-factory/client/ops";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@software-factory/ui/components/select";
import { StatusDot } from "@software-factory/ui/components/status-dot";
import { type QueryClient, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { configProject, versionLine } from "../lib/config-view.ts";
import { ExternalLink, WEBSITE_URL } from "../lib/external.tsx";
import { configQuery } from "../lib/factory-queries.ts";
import { projectsQuery } from "../lib/queries.ts";
import { orgScope } from "../lib/scope.ts";
import { useProjects } from "../lib/session.ts";
import { getViewState } from "../lib/view-state.ts";
import { Empty } from "./data-table.tsx";
import { type ReadQuery, Reads, readState } from "./read-state.tsx";
import { Panel } from "./shell-list.tsx";
import { useOrgScope } from "./shell-sidebar.tsx";

/** The config pages' search: which project (`?project=`). */
export interface ProjectSearch {
  project?: string;
}
export const projectSearch = (s: Record<string, unknown>): ProjectSearch =>
  typeof s.project === "string" ? { project: s.project } : {};

/** The loaders' side of `configProject`: the rail's org from the view state. */
export async function configProjectId(
  context: {
    queryClient: QueryClient;
    session: { personalOrgId: string | null; orgs: { id: string }[] };
  },
  chosen: string | undefined,
): Promise<string | null> {
  const projects = await context.queryClient
    .ensureQueryData(projectsQuery(context.session.orgs.map((o) => o.id)))
    .catch(() => []);
  const orgId = orgScope(context.session, getViewState().orgId);
  return configProject(projects, orgId, chosen).project?.id ?? null;
}

/** The website page where a project's config is changed. */
export const configUrl = (projectId: string, page: "settings" | "workflows") =>
  `${WEBSITE_URL}/projects/${encodeURIComponent(projectId)}/${page}`;

/** The projects in the rail's org, the chosen one (`?project=`, else the first) and its config. */
export function useProjectConfig(chosen: string | undefined) {
  const orgId = useOrgScope();
  const projects = useProjects();
  const { inScope, project } = configProject(projects.data ?? [], orgId, chosen);
  const config = useQuery({ ...configQuery(project?.id ?? ""), enabled: !!project });
  return { projects: inScope, project, projectsRead: projects, config };
}

export function ProjectPicker({
  projects,
  project,
  from,
}: {
  projects: Project[];
  project: Project | null;
  from: "/factory/policy" | "/factory/agents" | "/factory/workflows";
}) {
  const navigate = useNavigate();
  if (projects.length < 2 || !project) return null;
  return (
    <Select
      value={project.id}
      onValueChange={(id) => void navigate({ to: from, search: { project: id } })}
    >
      <SelectTrigger
        size="sm"
        className="w-[180px]"
        data-testid="config-project"
        aria-label="Project"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {projects.map((p) => (
          <SelectItem key={p.id} value={p.id}>
            {p.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Saves waiting for an approver: they loosen the config, so a person decides on the website. */
export function PendingChanges({ config, projectId }: { config: ConfigView; projectId: string }) {
  if (config.pending.length === 0) return null;
  const n = config.pending.length;
  return (
    <Panel
      needsYou
      className="flex-row flex-wrap items-center gap-x-3 gap-y-1"
      data-testid="config-pending"
    >
      <StatusDot status="waiting" />
      <span className="font-semibold">
        {n === 1
          ? "1 change is waiting for an approver"
          : `${n} changes are waiting for an approver`}
      </span>
      <span className="min-w-0 flex-1 text-ink-3 text-xs">
        {config.pending
          .map((p) =>
            [p.by ? `${p.by}:` : null, p.note ?? "a change that loosens the config"]
              .filter(Boolean)
              .join(" "),
          )
          .join(" · ")}
      </span>
      <ExternalLink href={configUrl(projectId, "settings")} className="text-xs underline">
        Review on the website
      </ExternalLink>
    </Panel>
  );
}

export function ConfigFooter({
  config,
  projectId,
  page,
}: {
  config: ConfigView;
  projectId: string;
  page: "settings" | "workflows";
}) {
  return (
    <div
      className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 text-ink-3 text-xs"
      data-testid="config-footer"
    >
      <span>{versionLine(config.current)}</span>
      <span>
        Changing it is a policy change for a person, made on the website: tightening saves at once,
        loosening waits for an approver.
      </span>
      <ExternalLink href={configUrl(projectId, page)} className="text-ink underline">
        {page === "settings"
          ? "Change the policy on the website"
          : "Change workflows and agents on the website"}
      </ExternalLink>
    </div>
  );
}

/**
 * What a page shows until its config is there to show: a skeleton while the projects or the config
 * load, the error with Retry when a read failed, and "no project" or "no config yet" only when the
 * read answered so. Null once the config is ready (the page renders it).
 */
export function ConfigState({
  projectsRead,
  project,
  config,
}: {
  projectsRead: ReadQuery;
  project: Project | null;
  config: ReadQuery & { data?: ConfigView };
}) {
  if (readState([projectsRead]) !== "ready")
    return (
      <Reads queries={[projectsRead]} what="the projects">
        {() => null}
      </Reads>
    );
  if (!project) return <Empty>No project in this org yet. Add one in Setup.</Empty>;
  if (readState([config]) !== "ready")
    return (
      <Reads queries={[config]} what="the project's config">
        {() => null}
      </Reads>
    );
  if (config.data?.error) return <Empty>The current config isn't valid: {config.data.error}</Empty>;
  if (!config.data?.current?.policy) return <Empty>This project has no config yet.</Empty>;
  return null;
}
