// All orgs (.kim/mockups/all-orgs.html), the org strip's top button: what needs you across every
// org with Open to go to it, what agents are working on now, and each org with its counts. One read
// (`flow.inbox.all`); each org's projects and agents name the rest.
import {
  agentName,
  type FlowInboxAll,
  type FlowInboxAllItem,
  flowKey,
  when,
} from "@software-factory/client/flow";
import { inboxQuestion } from "@software-factory/client/flow-edit";
import { Button } from "@software-factory/ui/components/button";
import { Skeleton } from "@software-factory/ui/components/skeleton";
import { cn } from "@software-factory/ui/lib/utils";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { flowAgentsQuery, flowInboxAllQuery, flowProjectsQuery } from "../../lib/flow-queries.ts";
import { orgInitial } from "../../lib/scope.ts";
import { useSession } from "../../lib/session.ts";
import { PageHeader, Pill } from "./parts.tsx";

type Row = FlowInboxAllItem & { orgName: string };

/** Everything across the orgs, flattened with each item's org, oldest-waiting last. */
export function allRows(all: FlowInboxAll | undefined) {
  const needs: (Row & { kind: "work" | "decision" })[] = [];
  const working: Row[] = [];
  for (const o of all?.orgs ?? []) {
    for (const i of o.decisions) needs.push({ ...i, orgName: o.name, kind: "decision" });
    for (const i of o.work) needs.push({ ...i, orgName: o.name, kind: "work" });
    for (const i of o.working) working.push({ ...i, orgName: o.name });
  }
  const newest = (a: Row, b: Row) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
  return { needs: needs.sort(newest), working: working.sort(newest) };
}

export function AllOrgsPage() {
  const session = useSession();
  const all = useQuery(flowInboxAllQuery());
  const orgIds = session.orgs.map((o) => o.id);
  const projects = useQueries({ queries: orgIds.map((id) => flowProjectsQuery(id)) });
  const agents = useQueries({ queries: orgIds.map((id) => flowAgentsQuery(id)) });
  const { needs, working } = allRows(all.data);
  const agentOf = (orgId: string, agentId: string) =>
    agentName(
      { me: { id: "", name: "" }, agents: agents[orgIds.indexOf(orgId)]?.data?.agents ?? [] },
      agentId,
    );

  return (
    <main className="flex min-w-0 flex-1 flex-col" data-testid="all-orgs-page">
      <PageHeader title="Everything">
        <span className="flex-1" />
        {working.length > 0 && (
          <Pill className="border-transparent bg-work-soft text-work" data-testid="all-working">
            {working.length} working
          </Pill>
        )}
        {needs.length > 0 && (
          <Pill className="border-need-line bg-need-soft text-need" data-testid="all-needs">
            {needs.length} need{needs.length === 1 ? "s" : ""} you
          </Pill>
        )}
      </PageHeader>
      <div className="min-h-0 flex-1 overflow-auto bg-board px-5 py-4">
        <div className="grid max-w-3xl gap-2">
          <Heading>Needs you</Heading>
          {!all.data ? (
            <Skeleton className="h-16" />
          ) : needs.length === 0 ? (
            <Empty>Nothing needs you in any org.</Empty>
          ) : (
            <Rows data-testid="needs-you">
              {needs.map((i) => (
                <ItemRow
                  key={i.id}
                  item={i}
                  // The question as the Inbox asks it: "Approve: Add rate limiting", "Decide: …".
                  title={inboxQuestion({ item: i, kind: i.kind }, i.statusName)}
                  sub={`${i.orgName} · ${i.projectName} · ${flowKey({ key: i.projectKey }, i.number)}`}
                  open
                  testId="need-row"
                />
              ))}
            </Rows>
          )}
          <Heading>Working now</Heading>
          {!all.data ? (
            <Skeleton className="h-16" />
          ) : working.length === 0 ? (
            <Empty>No agent is working right now.</Empty>
          ) : (
            <Rows data-testid="working-now">
              {working.map((i) => (
                <ItemRow
                  key={i.id}
                  item={i}
                  title={i.title}
                  sub={[
                    i.orgName,
                    i.projectName,
                    i.statusName,
                    i.waiting.on === "run" ? agentOf(i.orgId, i.waiting.agentId) : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                  testId="working-row"
                />
              ))}
            </Rows>
          )}
          <Heading>Orgs</Heading>
          <Rows data-testid="org-counts">
            {session.orgs.map((o, n) => {
              const list = projects[n]?.data?.projects;
              const org = all.data?.orgs.find((x) => x.orgId === o.id);
              const open = list?.every((p) => p.openCount !== undefined)
                ? list.reduce((sum, p) => sum + (p.openCount ?? 0), 0)
                : null;
              const need = org ? org.work.length + org.decisions.length : 0;
              return (
                <Link
                  key={o.id}
                  to="/flow/$orgId/work"
                  params={{ orgId: o.id }}
                  className="flex items-center gap-3 px-3.5 py-2.5 hover:bg-hover"
                  data-testid="org-count"
                >
                  <OrgMark name={o.name} />
                  <span className="font-medium">{o.name}</span>
                  <span className="text-[12px] text-ink-muted">
                    {list
                      ? `${list.length} project${list.length === 1 ? "" : "s"}${open !== null ? ` · ${open} open item${open === 1 ? "" : "s"}` : ""}`
                      : ""}
                  </span>
                  {org && (
                    <span className="ml-auto text-[12px] text-ink-muted">
                      {org.working.length} working · {need} need{need === 1 ? "s" : ""} you
                    </span>
                  )}
                </Link>
              );
            })}
          </Rows>
        </div>
      </div>
    </main>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return <h2 className="mt-2 font-semibold text-[13px] first:mt-0">{children}</h2>;
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-1 text-ink-muted">{children}</p>;
}

function Rows({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "grid overflow-hidden rounded-[10px] border border-line bg-panel [&>*+*]:border-line-soft [&>*+*]:border-t",
        className,
      )}
      {...props}
    />
  );
}

function OrgMark({ name }: { name: string }) {
  return (
    <span
      aria-hidden
      className="grid size-7 flex-none place-items-center rounded-[7px] bg-field font-semibold text-[11.5px]"
    >
      {orgInitial(name)}
    </span>
  );
}

function ItemRow({
  item,
  title,
  sub,
  open,
  testId,
}: {
  item: Row;
  title: string;
  sub: string;
  open?: boolean;
  testId: string;
}) {
  return (
    <div className="flex items-center gap-3 px-3.5 py-2.5" data-testid={testId}>
      <OrgMark name={item.orgName} />
      <span className="grid min-w-0">
        <span className="truncate font-medium">{title}</span>
        <span className="truncate text-[12px] text-ink-muted">{sub}</span>
      </span>
      <span className="ml-auto flex flex-none items-center gap-2.5">
        {open && (
          <Button asChild size="md">
            <Link
              to="/flow/$orgId/p/$projectId"
              params={{ orgId: item.orgId, projectId: item.projectId }}
              search={{ item: item.id }}
              data-testid="open-item"
            >
              Open
            </Link>
          </Button>
        )}
        <time className="w-16 text-right text-[12px] text-ink-faint">{when(item.updatedAt)}</time>
      </span>
    </div>
  );
}
