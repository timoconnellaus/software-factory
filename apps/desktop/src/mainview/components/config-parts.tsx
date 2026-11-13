// The parts the Policy, Agents and Workflows pages share (spec 41, slice 5): which project's config
// they show, the footer with its version and where it is changed, and the changes that wait for an
// approver. The config is edited here (ADR 0610): a save that loosens waits as a pending action,
// shown with the engine's classified impact, and an approver decides it with Touch ID
// (`approval.decide` through `decide()`).
import type { ConfigView, Project } from "@software-factory/client/ops";
import { Button } from "@software-factory/ui/components/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@software-factory/ui/components/select";
import { StatusDot } from "@software-factory/ui/components/status-dot";
import { type QueryClient, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { configProject, versionLine } from "../lib/config-view.ts";
import { useDecide } from "../lib/decisions.tsx";
import { configQuery } from "../lib/factory-queries.ts";
import { read } from "../lib/op.ts";
import { projectsQuery } from "../lib/queries.ts";
import { orgScope } from "../lib/scope.ts";
import { useProjects } from "../lib/session.ts";
import { getViewState } from "../lib/view-state.ts";
import { CannotApproveYet, useCanDecide } from "./cannot-approve.tsx";
import { ChangeDiff, ImpactList } from "./config-editor.tsx";
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

/**
 * Saves and rollbacks waiting for an approver: they loosen the config. Each shows what it changes as
 * the engine classifies it against the current version (`config.preview`) and the difference itself,
 * before and after; Approve is offered only once both are on screen. Approve and Reject are each
 * one decision with Touch ID, and the prompt shows the engine's own summary of the change. One
 * drafted against an older version, or one whose document can't be shown, can only be rejected.
 */
export function PendingChanges({ config, projectId }: { config: ConfigView; projectId: string }) {
  if (config.pending.length === 0) return null;
  const n = config.pending.length;
  const current = config.current;
  return (
    <section className="flex flex-col gap-2" data-testid="config-pending">
      <div className="flex items-center gap-2 font-semibold text-[13px]">
        <StatusDot status="waiting" />
        {config.pendingMore
          ? `More than ${n} changes are waiting for an approver: the newest ${n} are here`
          : n === 1
            ? "1 change is waiting for an approver"
            : `${n} changes are waiting for an approver`}
      </div>
      <CannotApproveYet />
      {config.pending.map((p) => (
        <PendingChange
          key={p.pendingActionId}
          change={p}
          current={current?.version ?? 0}
          currentPolicy={current?.policy ?? null}
          projectId={projectId}
        />
      ))}
    </section>
  );
}

/** Why a waiting change can't be approved here, or null when it can (pure; tested). */
export function cannotApprove(
  change: { baseVersion: number | null; policy: Record<string, unknown> | null },
  current: number,
  classified: "loading" | "failed" | "ready",
): string | null {
  if (change.baseVersion !== null && change.baseVersion !== current)
    return `This was drafted against v${change.baseVersion}; the config is now v${current}, so it can't apply any more. Reject it and propose it again.`;
  if (!change.policy)
    return "This change can't be shown: the document it would make current isn't available. Reject it, and propose it again if it's still wanted.";
  if (classified === "failed")
    return "The engine couldn't classify this change, so it can't be approved here. Reject it, or try again later.";
  if (classified === "loading") return "Classifying the change…";
  return null;
}

function PendingChange({
  change,
  current,
  currentPolicy,
  projectId,
}: {
  change: ConfigView["pending"][number];
  current: number;
  currentPolicy: Record<string, unknown> | null;
  projectId: string;
}) {
  const { decide, pending } = useDecide();
  // A software key's proofs are refused: no Approve or Reject that can only fail (the notice says why).
  const canDecide = useCanDecide();
  const stale = change.baseVersion !== null && change.baseVersion !== current;
  const policy = change.policy;
  const impact = useQuery({
    queryKey: ["config", projectId, "preview", "pending", change.pendingActionId],
    queryFn: () => read("config.preview", { projectId, policy: policy ?? {} }),
    enabled: !!policy && !stale,
    staleTime: 30_000,
  });
  const classified = impact.data?.impact
    ? "ready"
    : impact.isError || (impact.data && !impact.data.impact)
      ? "failed"
      : "loading";
  const why = cannotApprove(change, current, classified);
  const decideIt = (decision: "approved" | "rejected") =>
    void decide(
      { kind: "approval.decide", pendingActionId: change.pendingActionId, decision },
      `${change.pendingActionId}:${decision}`,
    );
  return (
    <Panel needsYou data-testid={`pending-${change.pendingActionId}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="min-w-[min(100%,280px)] flex-1 font-medium text-[13px]">
          {change.operation === "config.rollback" ? `Roll back to v${change.toVersion}` : "Save"}
          {change.note && change.operation !== "config.rollback" ? `: ${change.note}` : ""}
          <span className="font-normal text-ink-3 text-xs">
            {change.by ? ` · by ${change.by}` : ""}
            {change.baseVersion !== null ? ` · from v${change.baseVersion}` : ""}
          </span>
        </span>
        {!why && (
          <Button
            size="sm"
            onClick={() => decideIt("approved")}
            disabled={pending !== null || !canDecide}
            data-testid="pending-approve"
          >
            Approve
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          onClick={() => decideIt("rejected")}
          disabled={pending !== null || !canDecide}
          data-testid="pending-reject"
        >
          Reject
        </Button>
      </div>
      {why && (
        <div className="text-ink-3 text-xs" data-testid="pending-why">
          {why}
        </div>
      )}
      {impact.data?.impact && !stale && (
        <>
          <ImpactList changes={impact.data.impact.changes} testId="pending-impact" />
          <ChangeDiff
            before={currentPolicy}
            after={policy}
            changes={impact.data.impact.changes}
            testId="pending-diff"
          />
        </>
      )}
    </Panel>
  );
}

export function ConfigFooter({ config, projectId }: { config: ConfigView; projectId: string }) {
  return (
    <div
      className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1 text-ink-3 text-xs"
      data-testid="config-footer"
    >
      <span>{versionLine(config.current)}</span>
      <span>Tightening saves at once; loosening waits for an approver.</span>
      <Link
        to="/factory/policy"
        search={{ project: projectId, edit: true }}
        className="text-ink underline"
      >
        History and roll back
      </Link>
    </div>
  );
}

/** Edit (to `?edit=1`) or Done, in a config page's header. */
export function EditToggle({
  from,
  projectId,
  editing,
  label,
  extra,
}: {
  from: "/factory/policy" | "/factory/agents" | "/factory/workflows";
  projectId: string | undefined;
  editing: boolean;
  label: string;
  extra?: Record<string, string>;
}) {
  const here = { ...(projectId ? { project: projectId } : {}), ...extra };
  return editing ? (
    <Button size="sm" variant="outline" asChild>
      <Link to={from} search={here} data-testid="edit-done">
        Done
      </Link>
    </Button>
  ) : (
    <Button size="sm" asChild>
      <Link to={from} search={{ ...here, edit: true }} data-testid="edit-config">
        {label}
      </Link>
    </Button>
  );
}

/** A config page's `?edit=` search, as a boolean. */
export const editSearch = (s: Record<string, unknown>): { edit?: boolean } =>
  s.edit === true || s.edit === "1" || s.edit === "true" ? { edit: true } : {};

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
