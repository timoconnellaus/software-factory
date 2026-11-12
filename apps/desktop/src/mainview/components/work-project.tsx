// A project's page (spec 50, design WorkProject): its work by state, what is in the factory and who
// it waits on, and the project itself (its workflow, repositories and approvers). A project is a
// body of work, not a repository (ADR 0490): it may have none. Board opens its board.
import { STAGE_LABEL } from "@software-factory/client/format";
import { Button } from "@software-factory/ui/components/button";
import { StatusDot } from "@software-factory/ui/components/status-dot";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { itemsIn } from "../lib/backlog.ts";
import { openItem } from "../lib/places.ts";
import { boardsQuery, configQuery } from "../lib/queries.ts";
import { useProjects, useSession } from "../lib/session.ts";
import { viewCounts, viewOf } from "../lib/work-board.ts";
import { PageArea, PageHeader, Panel, SectionTitle } from "./shell-list.tsx";
import { useScopedInbox } from "./shell-sidebar.tsx";

/** Who an item in the factory waits on, in the design's words. */
function waitingOn(
  item: { id: string; status: string },
  needsYou: Set<string>,
): { label: string; status: "waiting" | "running" | "idle" } {
  if (needsYou.has(item.id)) return { label: "You", status: "waiting" };
  if (item.status === "queued") return { label: "A free slot", status: "idle" };
  if (item.status === "running") return { label: "Agent", status: "running" };
  if (item.status === "paused") return { label: "Paused", status: "idle" };
  return { label: "An event", status: "idle" };
}

export function ProjectPage({ projectId }: { projectId: string }) {
  const session = useSession();
  const projects = useProjects();
  const board = useQuery(boardsQuery(session.orgs.map((o) => o.id)));
  const config = useQuery(configQuery(projectId));
  const { inbox } = useScopedInbox();
  const project = projects.data?.find((p) => p.id === projectId);
  const counts = viewCounts(board.data?.counts ?? [], { orgId: null, projectId });
  const all = board.data?.items ?? [];
  const ready = itemsIn(all, ["ready"], { orgId: null, projectId });
  const backlog = itemsIn(all, ["backlog"], { orgId: null, projectId });
  const active = itemsIn(all, ["queued", "running", "waiting", "paused"], {
    orgId: null,
    projectId,
  });
  const needsYou = new Set(
    [
      ...(inbox?.gates.map((g) => g.workItemId) ?? []),
      ...(inbox?.questions.map((q) => q.workItemId) ?? []),
    ].filter((x): x is string => !!x),
  );
  const waitingOnYou = active.filter((i) => needsYou.has(i.id)).length;
  const policy = config.data?.current?.policy as
    | { workflow?: string | null; approvers?: string[] }
    | null
    | undefined;

  if (projects.data && !project) {
    return (
      <PageArea>
        <PageHeader title="Project not found" sub="It isn't in one of your orgs." />
      </PageArea>
    );
  }

  const card = (label: string, n: number, sub: string, testId: string) => (
    <Panel className="min-w-[150px] flex-1 gap-1 px-3.5 py-3" data-testid={testId}>
      <span className="text-ink-3 text-xs">{label}</span>
      <span className="font-semibold text-[20px] tabular-nums leading-tight">{n}</span>
      <span className="text-ink-muted text-xs">{sub}</span>
    </Panel>
  );

  return (
    <PageArea wide>
      <PageHeader
        above={
          <>
            <Link to="/work" search={{ view: "active" }} className="underline">
              Work
            </Link>{" "}
            / {project?.name ?? "Project"}
          </>
        }
        title={project?.name ?? "Project"}
        testId="work-title"
        actions={
          <Button asChild variant="outline" size="md">
            <Link to="/work" search={{ view: "active", project: projectId }}>
              Board
            </Link>
          </Button>
        }
      />
      <div className="flex flex-wrap gap-2.5">
        {card(
          "Backlog",
          counts.backlog,
          `${backlog.filter((i) => !i.size).length} not sized`,
          "count-backlog",
        )}
        {card(
          "Ready",
          counts.ready,
          `${ready.filter((i) => i.blockedBy.length > 0).length} wait on another`,
          "count-ready",
        )}
        {card("In the factory", counts.active, `${waitingOnYou} waiting on you`, "count-active")}
        {card(
          "Done",
          counts.done,
          `${(board.data?.counts ?? [])
            .filter(
              (c) =>
                c.projectId === projectId && c.status !== "done" && viewOf(c.status) === "done",
            )
            .reduce((n, c) => n + c.n, 0)} cancelled or failed`,
          "count-done",
        )}
      </div>
      <div className="flex flex-wrap items-start gap-[18px]">
        <section className="flex min-w-0 flex-[999_1_420px] flex-col gap-2">
          <SectionTitle>In the factory</SectionTitle>
          {active.length === 0 ? (
            <Panel className="text-ink-3" data-testid="project-active-empty">
              Nothing from this project is in the factory.{" "}
              {counts.ready > 0 ? (
                <Link
                  to="/work"
                  search={{ view: "ready", project: projectId }}
                  className="text-ink underline"
                >
                  {counts.ready} ready to release
                </Link>
              ) : null}
            </Panel>
          ) : (
            <div className="overflow-x-auto rounded-[10px] bg-panel shadow-panel">
              <table className="w-full" data-testid="project-active">
                <thead>
                  <tr className="border-line-soft border-b text-left text-ink-muted text-xs">
                    <th className="px-3.5 py-2.5 font-medium">Item</th>
                    <th className="py-2.5 pr-3 font-medium">Stage</th>
                    <th className="py-2.5 pr-3.5 font-medium">Waiting on</th>
                  </tr>
                </thead>
                <tbody>
                  {active.map((i) => {
                    const w = waitingOn(i, needsYou);
                    return (
                      <tr key={i.id} className="border-line-soft border-t first:border-t-0">
                        <td className="px-3.5 py-2.5">
                          <Link {...openItem(i.id)} className="font-medium hover:underline">
                            <span className="mr-1.5 font-mono font-normal text-[12px] text-ink-muted">
                              #{i.number}
                            </span>
                            {i.title}
                          </Link>
                        </td>
                        <td className="whitespace-nowrap py-2.5 pr-3 text-ink-3">
                          {i.status === "queued"
                            ? "Queued"
                            : (STAGE_LABEL[i.stage as keyof typeof STAGE_LABEL] ?? i.stage)}
                        </td>
                        <td className="whitespace-nowrap py-2.5 pr-3.5">
                          <span className="inline-flex items-center gap-1.5">
                            <StatusDot status={w.status} />
                            {w.label}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <div className="flex gap-3 text-[13px]">
            <Link to="/work" search={{ view: "backlog", project: projectId }} className="underline">
              Backlog for this project
            </Link>
            <Link to="/work" search={{ view: "active", project: projectId }} className="underline">
              Its board
            </Link>
          </div>
        </section>
        <aside className="flex min-w-[260px] flex-[1_1_272px] flex-col gap-3">
          <Panel className="gap-2.5" data-testid="about-project">
            <h2 className="m-0 font-semibold text-[13px]">About this project</h2>
            <dl className="m-0 grid grid-cols-[100px_minmax(0,1fr)] gap-x-3 gap-y-2">
              <dt className="text-ink-3">Workflow</dt>
              <dd className="m-0">
                {config.isPending ? "…" : (policy?.workflow ?? "The skeleton alone")}
              </dd>
              <dt className="text-ink-3">Repositories</dt>
              <dd className="m-0 flex flex-col gap-0.5">
                {project?.repositories.length ? (
                  project.repositories.map((r) => (
                    <span key={r.id} className="break-all font-mono text-[12px]">
                      {r.owner}/{r.name}
                    </span>
                  ))
                ) : (
                  <span className="text-ink-3">
                    None yet.{" "}
                    <Link to="/setup" className="underline">
                      Add one in Setup
                    </Link>
                  </span>
                )}
              </dd>
              <dt className="text-ink-3">Approvers</dt>
              <dd className="m-0">
                {policy?.approvers?.length
                  ? policy.approvers.join(", ")
                  : "The org's owners and admins"}
              </dd>
            </dl>
          </Panel>
        </aside>
      </div>
    </PageArea>
  );
}
