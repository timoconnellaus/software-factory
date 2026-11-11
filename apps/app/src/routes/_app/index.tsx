// Home is the Inbox (spec 12): what's waiting on you, grouped by project, the Running section and
// the runner health line. `/?item=<workItemId>` (web push deep links) highlights that card.
import { Card } from "@software-factory/ui/components/card";
import { Skeleton } from "@software-factory/ui/components/skeleton";
import { StatusBadge, StatusDot } from "@software-factory/ui/components/status-dot";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect } from "react";
import { GateCard, QuestionCard } from "#/components/inbox-cards";
import { RunnerHealth } from "#/components/runner-health";
import { ago, STAGE_LABEL } from "#/lib/format";
import { groupByProject } from "#/lib/inbox";
import { inboxQuery, workListQuery } from "#/lib/queries";
import { useProjects } from "#/lib/session";

export const Route = createFileRoute("/_app/")({
  validateSearch: (s: Record<string, unknown>): { item?: string } =>
    typeof s.item === "string" ? { item: s.item } : {},
  loader: ({ context }) => context.queryClient.ensureQueryData(inboxQuery()).catch(() => null),
  component: InboxPage,
});

const WEEK = 7 * 24 * 60 * 60 * 1000;

function InboxPage() {
  const { item: highlight } = Route.useSearch();
  const { session } = Route.useRouteContext();
  const inbox = useQuery(inboxQuery());
  const projects = useProjects();
  const work = useQuery({
    ...workListQuery(session.personalOrgId ?? ""),
    enabled: !!session.personalOrgId,
  });
  const projectName = (id: string | null) =>
    projects.data?.find((p) => p.id === id)?.name ?? (id ? "project" : "factory");

  useEffect(() => {
    if (!highlight || !inbox.data) return;
    document
      .querySelector(`[data-testid="card-${CSS.escape(highlight)}"]`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [highlight, inbox.data]);

  if (inbox.isPending) {
    return (
      <Page>
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-36 w-full" />
        <Skeleton className="h-36 w-full" />
      </Page>
    );
  }
  if (inbox.isError) {
    return (
      <Page>
        <h1 className="font-semibold text-2xl tracking-tight">Inbox</h1>
        <p className="text-destructive text-sm">Couldn't load the inbox: {inbox.error.message}</p>
      </Page>
    );
  }
  const data = inbox.data;
  const waiting = data.gates.length + data.questions.length;
  const shipped =
    work.data?.items.filter(
      (i) => i.status === "done" && Date.now() - Date.parse(i.updatedAt) < WEEK,
    ).length ?? 0;
  const groups = groupByProject(data);
  const highlightGone =
    highlight &&
    !data.gates.some((g) => g.workItemId === highlight) &&
    !data.questions.some((q) => q.workItemId === highlight);
  const used = data.runners.reduce((n, r) => n + r.inUse, 0);
  const cap = data.runners.reduce((n, r) => n + r.max, 0);

  return (
    <Page>
      <div>
        <h1 className="font-semibold text-2xl tracking-tight">Inbox</h1>
        <div className="text-muted-foreground text-sm" data-testid="inbox-counts">
          {waiting} {waiting === 1 ? "item" : "items"} waiting on you · {data.running.length}{" "}
          running · {shipped} shipped this week
        </div>
      </div>

      {highlightGone && (
        <div
          className="rounded-md border px-4 py-3 text-sm"
          role="status"
          data-testid="already-decided"
        >
          That item is no longer waiting on you: it has already been decided.{" "}
          <Link to="/work/$id" params={{ id: highlight }} className="underline">
            Open the work item
          </Link>
        </div>
      )}

      {groups.length === 0 && (
        <Card className="items-center gap-1 py-10 text-center">
          <div className="font-medium">Nothing is waiting on you</div>
          <div className="text-muted-foreground text-sm">
            Gates, questions and merges show up here.{" "}
            <Link to="/new" className="underline">
              Send new work
            </Link>
          </div>
        </Card>
      )}

      {groups.map((g) => (
        <section key={g.projectId} className="grid gap-3" data-testid={`group-${g.projectId}`}>
          <div className="flex items-center gap-2 text-muted-foreground text-xs">
            <span className="font-medium text-foreground">{projectName(g.projectId || null)}</span>
            {g.waitingBuilds > 0 && (
              <span className="inline-flex items-center gap-1.5" data-testid="wip-hold">
                <StatusDot status="waiting" />
                {g.waitingBuilds} {g.waitingBuilds === 1 ? "build" : "builds"} waiting on review
              </span>
            )}
          </div>
          {g.gates.map((gate) => (
            <GateCard
              key={gate.id}
              gate={gate}
              projectName={projectName(gate.projectId)}
              highlighted={highlight === gate.workItemId}
            />
          ))}
          {g.questions.map((q) => (
            <QuestionCard
              key={q.id}
              question={q}
              projectName={projectName(q.projectId)}
              highlighted={highlight === q.workItemId}
            />
          ))}
        </section>
      ))}

      <Card className="gap-0 py-0" data-testid="running">
        <div className="flex items-baseline justify-between px-5 pt-5 pb-3">
          <div className="font-semibold">Running</div>
          <div className="text-muted-foreground text-xs">
            {cap ? `${used} of ${cap} slots in use` : "no runner slots"}
          </div>
        </div>
        {data.running.length === 0 ? (
          <div className="px-5 pb-4 text-muted-foreground text-sm">Nothing is running.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <tbody>
                {data.running.map((item) => (
                  <tr key={item.id} className="border-t">
                    <td className="py-2.5 pr-3 pl-5">
                      <StatusBadge
                        status={
                          item.status === "waiting"
                            ? "waiting"
                            : item.status === "paused"
                              ? "idle"
                              : "running"
                        }
                      >
                        {STAGE_LABEL[item.stage] ?? item.stage}
                      </StatusBadge>
                    </td>
                    <td className="w-full py-2.5 pr-3">
                      <Link to="/work/$id" params={{ id: item.id }} className="hover:underline">
                        {item.title}
                      </Link>
                      {item.kind === "incident" && (
                        <span className="ml-2 text-muted-foreground text-xs">factory incident</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap py-2.5 pr-3 text-muted-foreground">
                      {projectName(item.projectId)}
                    </td>
                    <td className="whitespace-nowrap py-2.5 pr-5 font-mono text-muted-foreground text-xs">
                      {item.statusReason ?? item.status} · {ago(item.createdAt).replace(" ago", "")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="border-t px-5 py-3">
          <RunnerHealth runners={data.runners} />
        </div>
      </Card>
    </Page>
  );
}

function Page({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto grid w-full grid-cols-[minmax(0,1fr)] max-w-[1200px] gap-4 p-4 md:p-6">
      {children}
    </main>
  );
}
