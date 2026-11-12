// Factory: Checks and incidents (spec 41, slice 5; design FactoryIncidents). An incident is the
// work item the factory opens when work is sent back or a run fails or stalls (`kind: "incident"`),
// so the list comes from `workItem.list`: open until its fix is done. Each shows the fix item's
// title as it is: what went wrong and the item it came from are the incident's own fields, which no
// read returns yet (an `incident.list`), and neither does the first guess at the cause. The checks
// that came from incidents and the project checks need a checks read; acknowledging one has no
// operation either.
import { StatusDot } from "@software-factory/ui/components/status-dot";
import { useQuery } from "@tanstack/react-query";
import { createRoute, Link } from "@tanstack/react-router";
import { Cell, Empty, Row, TablePanel, When, WIDE } from "../components/data-table.tsx";
import { Reads } from "../components/read-state.tsx";
import { PageArea, PageHeader, SectionTitle } from "../components/shell-list.tsx";
import { useOrgScope } from "../components/shell-sidebar.tsx";
import { ExternalLink } from "../lib/external.tsx";
import { fixText, type IncidentRow, incidentRows } from "../lib/factory.ts";
import { openItem } from "../lib/places.ts";
import { workListsQuery } from "../lib/queries.ts";
import { useProjects, useSession } from "../lib/session.ts";
import { factoryLayout } from "./_factory.tsx";

export const Route = createRoute({
  getParentRoute: () => factoryLayout,
  path: "/factory/incidents",
  loader: ({ context: { queryClient, session } }) =>
    queryClient.ensureQueryData(workListsQuery(session.orgs.map((o) => o.id))).catch(() => null),
  component: IncidentsPage,
});

function IncidentsPage() {
  const session = useSession();
  const orgId = useOrgScope();
  const projects = useProjects();
  const all = useQuery(workListsQuery(session.orgs.map((o) => o.id)));
  const rows = incidentRows((all.data ?? []).filter((i) => orgId === null || i.orgId === orgId));
  const open = rows.filter((r) => r.open);
  const closed = rows.filter((r) => !r.open).slice(0, 20);
  const projectName = (id: string) => projects.data?.find((p) => p.id === id)?.name ?? "";
  return (
    <PageArea>
      <PageHeader
        title="Checks and incidents"
        sub="When work is sent back or a run fails, the factory opens an incident: a work item that proposes a check, so the same thing is caught next time."
      />
      <SectionTitle>Open incidents</SectionTitle>
      <Reads queries={[all]} what="the incidents">
        {() =>
          open.length === 0 ? (
            <Empty>No open incidents.</Empty>
          ) : (
            <Incidents rows={open} projectName={projectName} testId="open-incidents" />
          )
        }
      </Reads>
      <SectionTitle note="The most recent, newest first.">Closed</SectionTitle>
      <Reads queries={[all]} what="the incidents">
        {() =>
          closed.length === 0 ? (
            <Empty>No closed incidents yet.</Empty>
          ) : (
            <Incidents rows={closed} projectName={projectName} testId="closed-incidents" />
          )
        }
      </Reads>
    </PageArea>
  );
}

function Incidents({
  rows,
  projectName,
  testId,
}: {
  rows: IncidentRow[];
  projectName: (id: string) => string;
  testId: string;
}) {
  // Both tables size their columns the same (a fixed layout), so Open and Closed line up.
  return (
    <TablePanel
      fixed
      head={[
        "Incident",
        { label: "Project", className: `w-[100px] ${WIDE}` },
        { label: "Fix", className: "w-[250px] max-[1100px]:w-[180px]" },
        { label: "Opened", className: `w-[80px] ${WIDE}` },
      ]}
      data-testid={testId}
    >
      {rows.map((r) => (
        <Row key={r.id}>
          <Cell className="whitespace-normal">
            <span className="flex items-start gap-2">
              <StatusDot
                className="mt-[7px]"
                status={r.open ? (r.status === "waiting" ? "waiting" : "running") : "done"}
              />
              <span className="min-w-0 font-medium">{r.title}</span>
            </span>
          </Cell>
          <Cell className={`truncate text-ink-3 ${WIDE}`}>{projectName(r.projectId)}</Cell>
          <Cell className="whitespace-normal">
            <span className="flex flex-wrap gap-x-1">
              <Link {...openItem(r.id)} className="whitespace-nowrap underline">
                #{r.number}, {fixText(r).toLowerCase()}
              </Link>
              {r.prUrl && (
                <span className="whitespace-nowrap">
                  ·{" "}
                  <ExternalLink href={r.prUrl} className="underline">
                    PR #{r.prUrl.split("/").pop()}
                  </ExternalLink>
                </span>
              )}
            </span>
          </Cell>
          <Cell className={`text-ink-muted text-xs ${WIDE}`}>
            <When iso={r.openedAt} />
          </Cell>
        </Row>
      ))}
    </TablePanel>
  );
}
