// A plain list of work items (the board is R2).
import { Card } from "@software-factory/ui/components/card";
import { type Status, StatusBadge } from "@software-factory/ui/components/status-dot";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { ago, STAGE_LABEL } from "@software-factory/client/format";
import { workListQuery } from "#/lib/queries";
import { useProjects, useSession } from "#/lib/session";

export const Route = createFileRoute("/_app/work/")({
  validateSearch: (s: Record<string, unknown>): { project?: string } =>
    typeof s.project === "string" ? { project: s.project } : {},
  loader: ({ context: { queryClient, session } }) =>
    session.personalOrgId
      ? queryClient.ensureQueryData(workListQuery(session.personalOrgId)).catch(() => null)
      : null,
  component: WorkList,
});

const DOT: Record<string, Status> = {
  running: "running",
  waiting: "waiting",
  paused: "idle",
  done: "done",
  failed: "failed",
  rejected: "failed",
  cancelled: "idle",
};

function WorkList() {
  const { project } = Route.useSearch();
  const session = useSession();
  const projects = useProjects();
  const work = useQuery({
    ...workListQuery(session.personalOrgId ?? ""),
    enabled: !!session.personalOrgId,
  });
  const items = (work.data?.items ?? []).filter((i) => !project || i.projectId === project);
  const projectName = (id: string) => projects.data?.find((p) => p.id === id)?.name ?? "project";
  return (
    <main className="mx-auto grid w-full grid-cols-[minmax(0,1fr)] max-w-[1200px] gap-4 p-4 md:p-6">
      <div>
        <h1 className="font-semibold text-2xl tracking-tight">Work</h1>
        <div className="text-muted-foreground text-sm">
          {project ? `${projectName(project)} · ` : ""}
          {items.length} work items, newest activity first
        </div>
      </div>
      <Card className="gap-0 overflow-x-auto py-0">
        {items.length === 0 ? (
          <div className="px-5 py-6 text-muted-foreground text-sm">
            {work.isPending ? "Loading…" : "No work items yet."}{" "}
            <Link to="/new" className="underline">
              Send new work
            </Link>
          </div>
        ) : (
          <table className="w-full text-sm">
            <tbody>
              {items.map((i) => (
                <tr key={i.id} className="border-t first:border-t-0">
                  <td className="py-2.5 pr-3 pl-5 font-mono text-muted-foreground text-xs">
                    #{i.number}
                  </td>
                  <td className="w-full py-2.5 pr-3">
                    <Link to="/work/$id" params={{ id: i.id }} className="hover:underline">
                      {i.title}
                    </Link>
                    {i.kind === "incident" && (
                      <span className="ml-2 text-muted-foreground text-xs">factory incident</span>
                    )}
                  </td>
                  <td className="py-2.5 pr-3">
                    <StatusBadge status={DOT[i.status] ?? "idle"}>
                      {STAGE_LABEL[i.stage] ?? i.stage} · {i.status}
                    </StatusBadge>
                  </td>
                  <td className="whitespace-nowrap py-2.5 pr-3 text-muted-foreground">
                    {projectName(i.projectId)}
                  </td>
                  <td className="whitespace-nowrap py-2.5 pr-5 text-muted-foreground text-xs">
                    {ago(i.updatedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </main>
  );
}
