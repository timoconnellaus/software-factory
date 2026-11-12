// Work (spec 41, design WorkActive/WorkDone): the items in the factory, done or stopped, for every
// project or one, as a board by stage or a list. Lanes are the factory's stages; a project's own
// workflow lanes come with spec 50 (slice 2).

import { ago, STAGE_LABEL } from "@software-factory/client/format";
import { StatusDot } from "@software-factory/ui/components/status-dot";
import { ToggleGroup, ToggleGroupItem } from "@software-factory/ui/components/toggle-group";
import { cn } from "@software-factory/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { createRoute, Link, useNavigate } from "@tanstack/react-router";
import { Chip } from "../components/shell-list.tsx";
import { useOrgScope, useScopedInbox } from "../components/shell-sidebar.tsx";
import { openItem } from "../lib/places.ts";
import { workListsQuery } from "../lib/queries.ts";
import { useProjects, useSession } from "../lib/session.ts";
import {
  cardState,
  lanes,
  VIEW_LABEL,
  type WorkItemSummary,
  type WorkView,
  workItemsFor,
} from "../lib/work-board.ts";
import { workLayout } from "./_work.tsx";

type Layout = "board" | "list";
interface Search {
  view?: WorkView;
  project?: string;
  layout?: Layout;
}

export const Route = createRoute({
  getParentRoute: () => workLayout,
  path: "/work",
  validateSearch: (s: Record<string, unknown>): Search => ({
    ...(s.view === "active" || s.view === "done" || s.view === "stopped" ? { view: s.view } : {}),
    ...(typeof s.project === "string" ? { project: s.project } : {}),
    ...(s.layout === "board" || s.layout === "list" ? { layout: s.layout } : {}),
  }),
  loader: ({ context: { queryClient, session } }) =>
    queryClient.ensureQueryData(workListsQuery(session.orgs.map((o) => o.id))).catch(() => null),
  component: WorkPage,
});

function WorkPage() {
  const search = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const session = useSession();
  const orgId = useOrgScope();
  const projects = useProjects();
  const { inbox } = useScopedInbox();
  const all = useQuery(workListsQuery(session.orgs.map((o) => o.id)));
  // A project shows what's in the factory by default; Done and Stopped are list-only.
  const view = search.view ?? "active";
  const layout: Layout = view === "active" ? (search.layout ?? "board") : "list";
  const items = workItemsFor(all.data ?? [], { view, projectId: search.project, orgId });
  const project = projects.data?.find((p) => p.id === search.project);
  const needsYou = new Set(
    [
      ...(inbox?.gates.map((g) => g.workItemId) ?? []),
      ...(inbox?.questions.map((q) => q.workItemId) ?? []),
    ].filter((x): x is string => !!x),
  );
  const waitingHere = items.filter((i) => needsYou.has(i.id)).length;
  const projectName = (id: string) => projects.data?.find((p) => p.id === id)?.name ?? "project";

  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-page" data-testid="page">
      <div className="flex h-12 flex-none items-center gap-2.5 border-line-soft border-b bg-panel px-3.5">
        <span className="size-2.5 flex-none rounded-[3px] bg-ink" />
        <h1 className="m-0 font-semibold text-[14px]" data-testid="work-title">
          {project ? project.name : VIEW_LABEL[view]}
        </h1>
        {project?.repo && (
          <Chip className="font-mono">
            {project.repo.owner}/{project.repo.name}
          </Chip>
        )}
        <span className="text-ink-muted" data-testid="work-count">
          {items.length} {items.length === 1 ? "item" : "items"}
        </span>
        {view === "active" && (
          <>
            <span aria-hidden className="mx-1 h-4 w-px bg-line" />
            <ToggleGroup
              type="single"
              value={layout}
              onValueChange={(v) =>
                v && void navigate({ search: { ...search, layout: v as Layout } })
              }
              className="rounded-[7px] bg-selected p-0.5"
            >
              <ToggleGroupItem
                value="board"
                className="h-6 rounded-[6px] px-2.5 text-[13px] data-[state=on]:bg-panel data-[state=on]:shadow-panel"
              >
                Board
              </ToggleGroupItem>
              <ToggleGroupItem
                value="list"
                className="h-6 rounded-[6px] px-2.5 text-[13px] data-[state=on]:bg-panel data-[state=on]:shadow-panel"
              >
                List
              </ToggleGroupItem>
            </ToggleGroup>
          </>
        )}
        <span className="flex-1" />
        {waitingHere > 0 && (
          <Chip tone="amber" className="px-2.5 py-1 text-xs">
            {waitingHere} waiting on you
          </Chip>
        )}
      </div>
      {items.length === 0 ? (
        <div className="p-6 text-ink-muted" data-testid="work-empty">
          {all.isPending
            ? "Loading…"
            : view === "active"
              ? "Nothing is in the factory right now."
              : `Nothing ${view === "done" ? "done" : "stopped"} yet.`}{" "}
          <Link to="/new" className="text-ink underline">
            Send new work
          </Link>
        </div>
      ) : layout === "board" ? (
        <Board items={items} needsYou={needsYou} />
      ) : (
        <List items={items} needsYou={needsYou} projectName={projectName} showProject={!project} />
      )}
    </main>
  );
}

function Board({ items, needsYou }: { items: WorkItemSummary[]; needsYou: Set<string> }) {
  return (
    <div className="flex min-h-0 flex-1 gap-2 overflow-x-auto p-3" data-testid="board">
      {lanes(items).map((lane) =>
        lane.items.length === 0 ? (
          <div
            key={lane.stage}
            className="flex w-10 flex-none flex-col items-center gap-2 rounded-[10px] bg-window py-2.5"
            data-testid={`lane-${lane.stage}`}
            data-empty
          >
            <span className="font-semibold text-[13px]">0</span>
            <span className="text-ink-3 [writing-mode:vertical-rl]">{STAGE_LABEL[lane.stage]}</span>
          </div>
        ) : (
          <section
            key={lane.stage}
            className="flex w-[212px] flex-none flex-col gap-2 overflow-y-auto rounded-[10px] bg-window p-1.5"
            data-testid={`lane-${lane.stage}`}
          >
            <div className="flex items-center gap-1.5 px-1.5 pt-1 pb-1">
              <span className="font-semibold text-[13px]">{STAGE_LABEL[lane.stage]}</span>
              <span className="text-ink-muted">{lane.items.length}</span>
            </div>
            {lane.items.map((i) => (
              <BoardCard key={i.id} item={i} needsYou={needsYou} />
            ))}
          </section>
        ),
      )}
    </div>
  );
}

function BoardCard({ item, needsYou }: { item: WorkItemSummary; needsYou: Set<string> }) {
  const state = cardState(item, needsYou);
  return (
    <Link
      {...openItem(item.id)}
      className={cn(
        "flex flex-col gap-1.5 rounded-lg bg-panel px-2.5 py-2 shadow-panel hover:brightness-[0.99]",
        state.needsYou && "shadow-needs-you",
      )}
      data-testid={`card-${item.id}`}
    >
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11.5px] text-ink-muted">#{item.number}</span>
        {item.kind !== "change" && (
          <span className="text-ink-muted text-xs">
            {item.kind === "incident" ? "incident" : "attached PR"}
          </span>
        )}
        <Chip tone={state.tone} className="ml-auto">
          {state.tone === "blue" && <StatusDot status="running" />}
          {state.label}
        </Chip>
      </div>
      <div className="font-medium leading-snug">{item.title}</div>
      <div className="flex items-center gap-1.5 text-ink-muted text-xs">
        <span className="truncate">{item.statusReason ?? item.status}</span>
        <span className="ml-auto flex-none">{ago(item.updatedAt).replace(" ago", "")}</span>
      </div>
    </Link>
  );
}

function List({
  items,
  needsYou,
  projectName,
  showProject,
}: {
  items: WorkItemSummary[];
  needsYou: Set<string>;
  projectName: (id: string) => string;
  showProject: boolean;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-3.5">
      <div className="overflow-hidden rounded-[10px] bg-panel shadow-panel">
        <table className="w-full" data-testid="work-list">
          <tbody>
            {items.map((i) => {
              const state = cardState(i, needsYou);
              return (
                <tr key={i.id} className="border-line-soft border-t first:border-t-0 hover:bg-page">
                  <td className="w-14 py-2.5 pl-3.5 font-mono text-[12px] text-ink-muted">
                    #{i.number}
                  </td>
                  <td className="py-2.5 pr-3">
                    <Link {...openItem(i.id)} className="font-medium hover:underline">
                      {i.title}
                    </Link>
                    {i.kind === "incident" && (
                      <span className="ml-2 text-ink-muted text-xs">factory incident</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap py-2.5 pr-3 text-ink-3">
                    {STAGE_LABEL[i.stage] ?? i.stage}
                  </td>
                  <td className="py-2.5 pr-3">
                    <Chip tone={state.tone}>{state.label}</Chip>
                  </td>
                  {showProject && (
                    <td className="whitespace-nowrap py-2.5 pr-3 text-ink-3">
                      {projectName(i.projectId)}
                    </td>
                  )}
                  <td className="whitespace-nowrap py-2.5 pr-3.5 text-right text-ink-muted text-xs">
                    {ago(i.updatedAt)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
