// Factory: Overview (spec 41, slice 5; design FactoryOverview). What the factory is doing in the
// chosen org now: running, the queue, what waits on you, runners, the merge queues and incidents.
// The design's time by stage and usage need the audit journal's aggregates, which no operation
// returns yet, so they aren't here.
import { STAGE_LABEL } from "@software-factory/client/format";
import { StatusDot } from "@software-factory/ui/components/status-dot";
import { useQuery } from "@tanstack/react-query";
import { createRoute, Link } from "@tanstack/react-router";
import { BabysitterSection } from "../components/babysitter.tsx";
import { Cell, Empty, Row, Stat, TablePanel, When, WIDE } from "../components/data-table.tsx";
import { Reads, StatSkeleton } from "../components/read-state.tsx";
import { PageArea, PageHeader, SectionTitle } from "../components/shell-list.tsx";
import { useOrgScope, useScopedInbox } from "../components/shell-sidebar.tsx";
import { incidentRows, queued, runnersOnline, runningNow } from "../lib/factory.ts";
import { deliveryStatusQuery, mergeQueuesQuery } from "../lib/factory-queries.ts";
import { openItem } from "../lib/places.ts";
import { projectsQuery, workListsQuery } from "../lib/queries.ts";
import { waitingCount } from "../lib/scope.ts";
import { useProjects, useSession } from "../lib/session.ts";
import { factoryLayout } from "./_factory.tsx";

/** The figure tiles' grid. */
const STATS = "grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-2.5";

export const Route = createRoute({
  getParentRoute: () => factoryLayout,
  path: "/factory",
  loader: async ({ context: { queryClient, session } }) => {
    const orgIds = session.orgs.map((o) => o.id);
    const projects = await queryClient.ensureQueryData(projectsQuery(orgIds)).catch(() => []);
    return Promise.all([
      queryClient.ensureQueryData(workListsQuery(orgIds)),
      queryClient.ensureQueryData(mergeQueuesQuery(projects.map((p) => p.id))),
      // The Babysitter line (spec 53), one read per project.
      ...projects.map((p) => queryClient.ensureQueryData(deliveryStatusQuery(p.id))),
    ]).catch(() => null);
  },
  component: OverviewPage,
});

function OverviewPage() {
  const session = useSession();
  const orgId = useOrgScope();
  const projects = useProjects();
  const { inbox, query: inboxRead } = useScopedInbox();
  const all = useQuery(workListsQuery(session.orgs.map((o) => o.id)));
  const inScope = (all.data ?? []).filter((i) => orgId === null || i.orgId === orgId);
  const scopedProjects = (projects.data ?? []).filter((p) => orgId === null || p.orgId === orgId);
  const queues = useQuery(mergeQueuesQuery((projects.data ?? []).map((p) => p.id)));
  const projectName = (id: string) => projects.data?.find((p) => p.id === id)?.name ?? "";

  const running = runningNow(inScope);
  const waitingQueue = queued(inScope);
  const waiting = inbox ? waitingCount(inbox) : 0;
  const runners = runnersOnline(inbox?.runners ?? []);
  const incidents = incidentRows(inScope).filter((r) => r.open);
  const merging = (queues.data ?? [])
    .filter((q) => scopedProjects.some((p) => p.id === q.projectId))
    .flatMap((q) => q.entries.map((e, i) => ({ ...e, projectId: q.projectId, position: i + 1 })));

  return (
    <PageArea>
      <PageHeader
        title="Overview"
        sub="What the factory is doing in this org now: what runs, what waits for a slot, and what waits on you."
      />
      <Reads
        queries={[all, inboxRead]}
        what="the factory's figures"
        skeleton={
          <div className={STATS}>
            <StatSkeleton />
            <StatSkeleton />
            <StatSkeleton />
            <StatSkeleton />
          </div>
        }
      >
        {() => (
          <div className={STATS}>
            <Stat
              label="Running"
              value={running.length}
              sub={running.length === 1 ? "item with a run going" : "items with a run going"}
              data-testid="stat-running"
            />
            <Stat
              label="Queued"
              value={waitingQueue.length}
              sub="waiting for a slot"
              data-testid="stat-queued"
            />
            <Stat
              label="Waiting on you"
              value={waiting}
              sub={
                <Link to="/" className="underline">
                  Open the inbox
                </Link>
              }
              needsYou={waiting > 0}
              data-testid="stat-waiting"
            />
            <Stat
              label="Runners online"
              value={`${runners.online} of ${runners.total}`}
              sub={
                <Link to="/factory/runners" className="underline">
                  See runners
                </Link>
              }
              data-testid="stat-runners"
            />
          </div>
        )}
      </Reads>

      <SectionTitle>Running now</SectionTitle>
      <Reads queries={[all]} what="what is running">
        {() =>
          running.length === 0 ? (
            <Empty>Nothing is running.</Empty>
          ) : (
            <TablePanel
              head={[
                "Item",
                { label: "Project", className: WIDE },
                "Stage",
                { label: "Doing", className: WIDE },
                "Updated",
              ]}
              data-testid="running"
            >
              {running.map((i) => (
                <Row key={i.id}>
                  <Cell className="whitespace-normal">
                    <Link {...openItem(i.id)} className="flex items-start gap-2 hover:underline">
                      <StatusDot status="running" className="mt-[7px]" />
                      <span className="font-medium">
                        #{i.number} {i.title}
                      </span>
                    </Link>
                  </Cell>
                  <Cell className={WIDE}>{projectName(i.projectId)}</Cell>
                  <Cell>{STAGE_LABEL[i.stage] ?? i.stage}</Cell>
                  <Cell className={`max-w-[200px] truncate text-ink-3 ${WIDE}`}>
                    {i.statusReason ?? ""}
                  </Cell>
                  <Cell className="font-mono text-ink-muted text-xs">
                    <When iso={i.updatedAt} />
                  </Cell>
                </Row>
              ))}
            </TablePanel>
          )
        }
      </Reads>

      <SectionTitle note="Released work is pulled in priority order as slots free up.">
        Queue
      </SectionTitle>
      <Reads queries={[all]} what="the queue">
        {() =>
          waitingQueue.length === 0 ? (
            <Empty>Nothing is waiting for a slot.</Empty>
          ) : (
            <TablePanel
              head={["Item", { label: "Project", className: WIDE }, "Released"]}
              data-testid="queue"
            >
              {waitingQueue.map((i) => (
                <Row key={i.id}>
                  <Cell className="whitespace-normal">
                    <Link {...openItem(i.id)} className="font-medium hover:underline">
                      #{i.number} {i.title}
                    </Link>
                  </Cell>
                  <Cell className={WIDE}>{projectName(i.projectId)}</Cell>
                  <Cell className="font-mono text-ink-muted text-xs">
                    <When iso={i.releasedAt ?? i.createdAt} />
                  </Cell>
                </Row>
              ))}
            </TablePanel>
          )
        }
      </Reads>

      <BabysitterSection projects={scopedProjects} />

      <SectionTitle note="Approved work lands one at a time per repository.">
        Merge queue
      </SectionTitle>
      <Reads queries={[queues, projects]} what="the merge queues">
        {() =>
          merging.length === 0 ? (
            <Empty>Nothing is waiting to merge.</Empty>
          ) : (
            <TablePanel
              head={[
                "",
                "Item",
                { label: "Project", className: WIDE },
                { label: "Head", className: WIDE },
                "Entered",
              ]}
              data-testid="merge-queue"
            >
              {merging.map((e) => (
                <Row key={e.workItemId}>
                  <Cell className="w-8 font-mono text-ink-muted text-xs">{e.position}</Cell>
                  <Cell className="whitespace-normal">
                    <Link {...openItem(e.workItemId)} className="font-medium hover:underline">
                      #{e.number} {e.title}
                    </Link>
                  </Cell>
                  <Cell className={WIDE}>{projectName(e.projectId)}</Cell>
                  <Cell className={`font-mono text-xs ${WIDE}`}>{e.headSha.slice(0, 7)}</Cell>
                  <Cell className="font-mono text-ink-muted text-xs">
                    <When iso={e.enqueuedAt} />
                  </Cell>
                </Row>
              ))}
            </TablePanel>
          )
        }
      </Reads>

      <SectionTitle>Incidents</SectionTitle>
      <Reads queries={[all]} what="the incidents">
        {() => (
          <Empty>
            {incidents.length === 0
              ? "No open incidents."
              : `${incidents.length} open ${incidents.length === 1 ? "incident" : "incidents"}.`}{" "}
            <Link to="/factory/incidents" className="text-ink underline">
              Checks and incidents
            </Link>
          </Empty>
        )}
      </Reads>
    </PageArea>
  );
}
