// Factory: Checks and incidents (spec 41, slice 5; design FactoryIncidents). An incident is the
// work item the factory opens when work is sent back or a run fails or stalls (`kind: "incident"`),
// so the list comes from `workItem.list`: open until its fix is done. Each shows the fix item's
// title as it is: what went wrong and the item it came from are the incident's own fields, which no
// read returns yet (an `incident.list`), and neither does the first guess at the cause. The checks
// that came from incidents and the project checks need a checks read; acknowledging one has no
// operation either.
//
// A run whose archived log lost an object is an incident too, but a record for a person with no
// work item (nothing an agent could do): those come from `incident.listArchiveMissing`, read when
// the page opens, and a person resolves each with `incident.resolve`.
import { Button } from "@software-factory/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@software-factory/ui/components/dialog";
import { StatusDot } from "@software-factory/ui/components/status-dot";
import { Textarea } from "@software-factory/ui/components/textarea";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { Cell, Empty, Row, TablePanel, When, WIDE } from "../components/data-table.tsx";
import { Reads } from "../components/read-state.tsx";
import { PageArea, PageHeader, SectionTitle } from "../components/shell-list.tsx";
import { useOrgScope } from "../components/shell-sidebar.tsx";
import { ExternalLink } from "../lib/external.tsx";
import { fixText, type IncidentRow, incidentRows } from "../lib/factory.ts";
import { OpError, op } from "../lib/op.ts";
import { openItem } from "../lib/places.ts";
import { type ArchiveIncident, archiveIncidentsQuery, workListsQuery } from "../lib/queries.ts";
import { useProjects, useSession } from "../lib/session.ts";
import { factoryLayout } from "./_factory.tsx";

export const Route = createRoute({
  getParentRoute: () => factoryLayout,
  path: "/factory/incidents",
  loader: ({ context: { queryClient, session } }) => {
    const orgIds = session.orgs.map((o) => o.id);
    return Promise.all([
      queryClient.ensureQueryData(workListsQuery(orgIds)).catch(() => null),
      queryClient.ensureQueryData(archiveIncidentsQuery(orgIds)).catch(() => null),
    ]);
  },
  component: IncidentsPage,
});

function IncidentsPage() {
  const session = useSession();
  const orgId = useOrgScope();
  const projects = useProjects();
  const all = useQuery(workListsQuery(session.orgs.map((o) => o.id)));
  const archive = useQuery(archiveIncidentsQuery(session.orgs.map((o) => o.id)));
  const lost = (archive.data?.incidents ?? []).filter((i) => orgId === null || i.orgId === orgId);
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
      {lost.length > 0 && (
        <>
          <SectionTitle note="A record for a person: no agent can bring a lost object back.">
            Archived logs missing
          </SectionTitle>
          <ArchiveIncidents rows={lost} projectName={projectName} more={!!archive.data?.more} />
        </>
      )}
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

function ArchiveIncidents({
  rows,
  projectName,
  more,
}: {
  rows: ArchiveIncident[];
  projectName: (id: string) => string;
  more: boolean;
}) {
  const [resolving, setResolving] = useState<ArchiveIncident | null>(null);
  return (
    <>
      <TablePanel
        fixed
        head={[
          "Incident",
          { label: "Project", className: `w-[100px] ${WIDE}` },
          { label: "Run", className: "w-[220px] max-[1100px]:w-[160px]" },
          { label: "Opened", className: `w-[80px] ${WIDE}` },
          { label: "", className: "w-[92px]" },
        ]}
        data-testid="archive-incidents"
      >
        {rows.map((r) => (
          <Row key={r.id}>
            <Cell className="whitespace-normal">
              <span className="flex items-start gap-2">
                <StatusDot className="mt-[7px]" status="failed" />
                <span className="min-w-0">
                  <span className="block font-medium">An archived log is missing</span>
                  <span className="block truncate text-ink-3 text-xs" title={r.reason}>
                    {r.reason}
                  </span>
                </span>
              </span>
            </Cell>
            <Cell className={`truncate text-ink-3 ${WIDE}`}>{projectName(r.projectId)}</Cell>
            <Cell className="whitespace-normal">
              <Link {...openItem(r.workItemId)} className="underline">
                #{r.workItemNumber} {r.workItemTitle}
              </Link>
            </Cell>
            <Cell className={`text-ink-muted text-xs ${WIDE}`}>
              <When iso={r.createdAt} />
            </Cell>
            <Cell className="text-right">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setResolving(r)}
                data-testid="resolve-incident"
              >
                Resolve
              </Button>
            </Cell>
          </Row>
        ))}
      </TablePanel>
      {more && <Empty>More are open than shown here: resolve these to see the rest.</Empty>}
      <ResolveDialog incident={resolving} onClose={() => setResolving(null)} />
    </>
  );
}

function ResolveDialog({
  incident,
  onClose,
}: {
  incident: ArchiveIncident | null;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [resolution, setResolution] = useState("");
  const [busy, setBusy] = useState(false);
  async function resolve() {
    if (!incident) return;
    setBusy(true);
    try {
      await op("incident.resolve", {
        workItemId: incident.workItemId,
        incidentId: incident.id,
        resolution: resolution.trim(),
      });
      toast.success("Incident resolved");
      setResolution("");
      onClose();
    } catch (error) {
      toast.error(error instanceof OpError ? error.message : "Couldn't resolve it");
    } finally {
      setBusy(false);
      await queryClient.invalidateQueries({ queryKey: ["incidents", "archive"] });
      await queryClient.invalidateQueries({ queryKey: ["workItem", incident.workItemId] });
    }
  }
  return (
    <Dialog open={incident !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Resolve this incident?</DialogTitle>
          <DialogDescription>
            Check the archive bucket first: restore the object from a backup, or accept that this
            part of the log is lost. Say what you did; it goes in the item's activity.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={resolution}
          onChange={(e) => setResolution(e.target.value)}
          placeholder="Restored from the backup, or: lost, accepted"
          maxLength={2000}
          data-testid="incident-resolution"
        />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Not yet
          </Button>
          <Button
            disabled={busy || resolution.trim() === ""}
            onClick={resolve}
            data-testid="confirm-resolve"
          >
            Resolve
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
