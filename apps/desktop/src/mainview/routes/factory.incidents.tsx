// Factory: Checks and incidents (spec 41, slice 5; design FactoryIncidents). An incident is the
// work item the factory opens when work is sent back or a run fails or stalls (`kind: "incident"`),
// so the list comes from `workItem.list`: open until its fix is done. The design's first guess at
// the cause, the checks that came from incidents and the project checks need an incident read and a
// checks read the client door doesn't have yet; acknowledging one has no operation either.
import { ago } from "@software-factory/client/format";
import { StatusDot } from "@software-factory/ui/components/status-dot";
import { useQuery } from "@tanstack/react-query";
import { createRoute, Link } from "@tanstack/react-router";
import { Cell, Empty, Row, TablePanel, WIDE } from "../components/data-table.tsx";
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
      {open.length === 0 ? (
        <Empty>No open incidents.</Empty>
      ) : (
        <Incidents rows={open} projectName={projectName} testId="open-incidents" />
      )}
      <SectionTitle note="The most recent, newest first.">Closed</SectionTitle>
      {closed.length === 0 ? (
        <Empty>No closed incidents yet.</Empty>
      ) : (
        <Incidents rows={closed} projectName={projectName} testId="closed-incidents" />
      )}
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
  return (
    <TablePanel
      head={[
        "Incident",
        { label: "From", className: WIDE },
        "Fix",
        { label: "Opened", className: WIDE },
      ]}
      data-testid={testId}
    >
      {rows.map((r) => (
        <Row key={r.id}>
          <Cell className="min-w-[140px] whitespace-normal">
            <span className="flex items-start gap-2">
              <StatusDot
                className="mt-[7px]"
                status={r.open ? (r.status === "waiting" ? "waiting" : "running") : "done"}
              />
              <span className="font-medium">{r.what}</span>
            </span>
          </Cell>
          <Cell className={`font-mono text-ink-3 text-xs ${WIDE}`}>
            {r.fromNumber !== null ? `#${r.fromNumber} · ` : ""}
            {projectName(r.projectId)}
          </Cell>
          <Cell className="min-w-[150px] whitespace-normal">
            <Link {...openItem(r.id)} className="underline">
              #{r.number}, {fixText(r).toLowerCase()}
            </Link>
            {r.prUrl && (
              <>
                {" · "}
                <ExternalLink href={r.prUrl} className="underline">
                  PR #{r.prUrl.split("/").pop()}
                </ExternalLink>
              </>
            )}
          </Cell>
          <Cell className={`font-mono text-ink-muted text-xs ${WIDE}`}>{ago(r.openedAt)}</Cell>
        </Row>
      ))}
    </TablePanel>
  );
}
