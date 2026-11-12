// In the factory and Done (spec 41 slice 2, design WorkActive/WorkActiveAll/WorkDone). A project's
// board has one lane per stage of its workflow as the server reports them (Queued first, the one
// lane every workflow has), each card with its stage, who it waits on and its live state, and a
// list layout. Across projects stages differ by workflow, so All projects is a list sorted by who
// each item waits on. Done is everything that left the factory, with its outcome.
import { ago, STAGE_LABEL } from "@software-factory/client/format";
import { StatusDot } from "@software-factory/ui/components/status-dot";
import { ToggleGroup, ToggleGroupItem } from "@software-factory/ui/components/toggle-group";
import { cn } from "@software-factory/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import { itemsIn } from "../lib/backlog.ts";
import { ExternalLink } from "../lib/external.tsx";
import { peekItem } from "../lib/places.ts";
import { boardsQuery, workListsQuery } from "../lib/queries.ts";
import { useProjects, useSession } from "../lib/session.ts";
import {
  type ActiveItem,
  boardLanes,
  cardState,
  outcomeOf,
  waitingOn,
  waitingOrder,
} from "../lib/work-board.ts";
import { Chip, PageArea, PageHeader, Panel } from "./shell-list.tsx";
import { useOrgScope, useScopedInbox } from "./shell-sidebar.tsx";
import { ProjectSwitcher } from "./work-backlog.tsx";

export type Layout = "board" | "list";
const IN_FACTORY = ["queued", "running", "waiting", "paused"];

/** Items with a gate or question waiting on you (the inbox, scoped to the chosen org). */
function useNeedsYou(): Set<string> {
  const { inbox } = useScopedInbox();
  return new Set(
    [
      ...(inbox?.gates.map((g) => g.workItemId) ?? []),
      ...(inbox?.questions.map((q) => q.workItemId) ?? []),
    ].filter((x): x is string => !!x),
  );
}

function useActive(projectId: string | null) {
  const session = useSession();
  const orgId = useOrgScope();
  const board = useQuery(boardsQuery(session.orgs.map((o) => o.id)));
  const items = itemsIn(board.data?.items ?? [], IN_FACTORY, { orgId, projectId });
  return { items, loading: board.isPending };
}

const stageLabel = (i: ActiveItem) =>
  i.status === "queued" ? "Queued" : (STAGE_LABEL[i.stage] ?? i.stage);

/** "14 min", "3 h": how long since it last changed. */
const since = (iso: string) => ago(iso).replace(" ago", "");

function Empty({ loading, children }: { loading: boolean; children: React.ReactNode }) {
  return (
    <div className="p-6 text-ink-muted" data-testid="work-empty">
      {loading ? "Loading…" : children}
    </div>
  );
}

// —— A project's board ——————————————————————————————————————————————————————————————————————

export function ProjectBoard({
  projectId,
  layout,
  onLayout,
}: {
  projectId: string;
  layout: Layout;
  onLayout: (l: Layout) => void;
}) {
  const projects = useProjects();
  const needsYou = useNeedsYou();
  const { items, loading } = useActive(projectId);
  const project = projects.data?.find((p) => p.id === projectId);
  const waiting = items.filter((i) => needsYou.has(i.id)).length;
  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-page" data-testid="page">
      <div className="flex h-12 flex-none items-center gap-2.5 overflow-hidden border-line-soft border-b bg-panel px-3.5">
        <span className="size-2.5 flex-none rounded-[3px] bg-ink" />
        <h1 className="m-0 truncate font-semibold text-[14px]" data-testid="work-title">
          <Link to="/work" search={{ project: projectId }} className="hover:underline">
            {project?.name ?? "Project"}
          </Link>
        </h1>
        <span className="whitespace-nowrap text-ink-muted" data-testid="work-count">
          {items.length} {items.length === 1 ? "item" : "items"}
        </span>
        <span aria-hidden className="mx-1 h-4 w-px flex-none bg-line" />
        <ToggleGroup
          type="single"
          value={layout}
          onValueChange={(v) => v && onLayout(v as Layout)}
          className="flex-none rounded-[7px] bg-selected p-0.5"
        >
          {(["board", "list"] as const).map((l) => (
            <ToggleGroupItem
              key={l}
              value={l}
              className="h-6 rounded-[6px] px-2.5 text-[13px] data-[state=on]:bg-panel data-[state=on]:shadow-panel"
            >
              {l === "board" ? "Board" : "List"}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <span className="flex-1" />
        {waiting > 0 && (
          <Chip tone="amber" className="px-2.5 py-1 text-xs">
            {waiting} waiting on you
          </Chip>
        )}
      </div>
      {items.length === 0 ? (
        <Empty loading={loading}>
          Nothing from {project?.name ?? "this project"} is in the factory.{" "}
          <Link
            to="/work"
            search={{ view: "ready", project: projectId }}
            className="text-ink underline"
          >
            Release ready work
          </Link>
        </Empty>
      ) : layout === "board" ? (
        <Board items={items} needsYou={needsYou} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-3.5">
          <ActiveTable items={items} needsYou={needsYou} showProject={false} />
        </div>
      )}
    </main>
  );
}

function Board({ items, needsYou }: { items: ActiveItem[]; needsYou: Set<string> }) {
  return (
    <div className="flex min-h-0 flex-1 gap-2 overflow-x-auto p-3" data-testid="board">
      {boardLanes(items, STAGE_LABEL).map((lane) =>
        lane.items.length === 0 ? (
          <div
            key={lane.key}
            className="flex w-10 flex-none flex-col items-center gap-2 rounded-[10px] bg-window py-2.5"
            data-testid={`lane-${lane.key}`}
            data-empty
          >
            <span className="font-semibold text-[13px]">0</span>
            <span className="text-ink-3 [writing-mode:vertical-rl]">{lane.label}</span>
          </div>
        ) : (
          <section
            key={lane.key}
            className="flex w-[212px] flex-none flex-col gap-2 overflow-y-auto rounded-[10px] bg-window p-1.5"
            data-testid={`lane-${lane.key}`}
            data-phase={lane.phase}
          >
            <div className="flex items-center gap-1.5 px-1.5 pt-1 pb-1">
              <span className="font-semibold text-[13px]">{lane.label}</span>
              <span className="text-ink-muted">{lane.items.length}</span>
              {lane.phase === "shaping" && (
                <span className="ml-auto text-ink-muted text-xs">shaping</span>
              )}
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

/** The item open in the side panel (`?item=`), so its card and row show as current. */
function useOpenItem(): string | undefined {
  return useRouterState({ select: (s) => (s.location.search as { item?: string }).item });
}

function BoardCard({ item, needsYou }: { item: ActiveItem; needsYou: Set<string> }) {
  const open = useOpenItem() === item.id;
  const state =
    item.status === "queued"
      ? { label: "Queued", tone: "neutral" as const, needsYou: false }
      : cardState(item, needsYou);
  const who = waitingOn(item, needsYou);
  return (
    <Link
      {...peekItem(item.id)}
      className={cn(
        "flex flex-col gap-1.5 rounded-lg bg-panel px-2.5 py-2 shadow-panel hover:brightness-[0.99]",
        state.needsYou && "shadow-needs-you",
        open && "ring-2 ring-ink/50",
      )}
      aria-current={open ? "true" : undefined}
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
      <div className="flex items-center gap-1.5 text-ink-muted text-xs" data-testid="card-who">
        <StatusDot status={who.status} />
        <span className="truncate">{item.statusReason ?? who.label}</span>
        <span className="ml-auto flex-none">{since(item.updatedAt)}</span>
      </div>
    </Link>
  );
}

function ActiveTable({
  items,
  needsYou,
  showProject,
}: {
  items: ActiveItem[];
  needsYou: Set<string>;
  showProject: boolean;
}) {
  const projects = useProjects();
  const name = (id: string) => projects.data?.find((p) => p.id === id)?.name ?? "project";
  const openId = useOpenItem();
  const th = "whitespace-nowrap py-2.5 pr-3 text-left font-medium text-ink-muted text-xs";
  return (
    <div className="@container overflow-hidden rounded-[10px] bg-panel shadow-panel">
      <table className="w-full" data-testid="work-list">
        <thead>
          <tr className="border-line-soft border-b">
            <th className={cn(th, "pl-3.5")}>Item</th>
            <th className={th}>Stage</th>
            <th className={th}>Waiting on</th>
            {showProject && <th className={cn(th, "@max-[560px]:hidden")}>Project</th>}
            <th className={cn(th, "pr-3.5 text-right")}>For</th>
          </tr>
        </thead>
        <tbody>
          {items.map((i) => {
            const who = waitingOn(i, needsYou);
            return (
              <tr
                key={i.id}
                className={cn(
                  "border-line-soft border-t first:border-t-0 hover:bg-page",
                  openId === i.id && "bg-selected hover:bg-selected",
                )}
                data-testid={`row-${i.id}`}
              >
                <td className="py-2.5 pr-3 pl-3.5">
                  <Link {...peekItem(i.id)} className="font-medium hover:underline">
                    <span className="mr-1.5 font-mono font-normal text-[12px] text-ink-muted">
                      #{i.number}
                    </span>
                    {i.title}
                  </Link>
                </td>
                <td className="whitespace-nowrap py-2.5 pr-3 text-ink-3">{stageLabel(i)}</td>
                <td className="py-2.5 pr-3">
                  <span className="inline-flex items-center gap-1.5">
                    <StatusDot status={who.status} />
                    {who.label}
                  </span>
                </td>
                {showProject && (
                  <td className="whitespace-nowrap py-2.5 pr-3 text-ink-3 @max-[560px]:hidden">
                    {name(i.projectId)}
                  </td>
                )}
                <td className="whitespace-nowrap py-2.5 pr-3.5 text-right font-mono text-[12px] text-ink-muted">
                  {since(i.updatedAt)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// —— All projects ——————————————————————————————————————————————————————————————————————————

export function ActiveAll() {
  const needsYou = useNeedsYou();
  const { items, loading } = useActive(null);
  const sorted = [...items].sort(
    (a, b) =>
      waitingOrder(a, needsYou) - waitingOrder(b, needsYou) ||
      Date.parse(a.updatedAt) - Date.parse(b.updatedAt),
  );
  const count = (f: (i: ActiveItem) => boolean) => items.filter(f).length;
  const cards: [string, number, string][] = [
    ["Waiting on you", count((i) => needsYou.has(i.id)), "a gate or a question"],
    [
      "Agent working",
      count((i) => !needsYou.has(i.id) && i.status === "running"),
      "on a runner now",
    ],
    [
      "Waiting",
      count((i) => !needsYou.has(i.id) && (i.status === "waiting" || i.status === "paused")),
      "on someone else or an event",
    ],
    ["Queued", count((i) => i.status === "queued"), "released, not started"],
  ];
  return (
    <PageArea wide>
      <PageHeader
        title="In the factory"
        testId="work-title"
        sub="Everything released, across projects. Stages differ by workflow, so this view sorts by what each item is waiting on. Open a project to see its board."
      />
      <div className="flex flex-wrap gap-2.5" data-testid="active-counts">
        {cards.map(([label, n, sub]) => (
          <Panel key={label} className="min-w-[140px] flex-1 gap-1 px-3.5 py-3">
            <span className="text-ink-3 text-xs">{label}</span>
            <span className="font-semibold text-[20px] tabular-nums leading-tight">{n}</span>
            <span className="text-ink-muted text-xs">{sub}</span>
          </Panel>
        ))}
      </div>
      {sorted.length === 0 ? (
        <Panel className="text-ink-3" data-testid="work-empty">
          {loading ? (
            "Loading…"
          ) : (
            <span>
              Nothing is in the factory right now.{" "}
              <Link to="/work" search={{ view: "ready" }} className="text-ink underline">
                Release ready work
              </Link>{" "}
              or{" "}
              <Link to="/new" className="text-ink underline">
                send new work
              </Link>
              .
            </span>
          )}
        </Panel>
      ) : (
        <ActiveTable items={sorted} needsYou={needsYou} showProject />
      )}
    </PageArea>
  );
}

// —— Done ——————————————————————————————————————————————————————————————————————————————————

const FINISHED = ["done", "failed", "rejected", "cancelled"];

export function DoneList({
  projectId,
  onProject,
}: {
  projectId: string | null;
  onProject: (id: string | null) => void;
}) {
  const session = useSession();
  const orgId = useOrgScope();
  const projects = useProjects();
  const all = useQuery(workListsQuery(session.orgs.map((o) => o.id)));
  const scoped = (projects.data ?? []).filter((p) => orgId === null || p.orgId === orgId);
  const items = (all.data ?? []).filter(
    (i) =>
      FINISHED.includes(i.status) &&
      (orgId === null || i.orgId === orgId) &&
      (!projectId || i.projectId === projectId),
  );
  const name = (id: string) => projects.data?.find((p) => p.id === id)?.name ?? "project";
  const th = "whitespace-nowrap py-2.5 pr-3 text-left font-medium text-ink-muted text-xs";
  return (
    <PageArea wide>
      <PageHeader
        title="Done"
        testId="work-title"
        sub="Everything that left the factory, with how it ended."
        actions={<ProjectSwitcher projects={scoped} value={projectId} onChange={onProject} />}
      />
      {items.length === 0 ? (
        <Panel className="text-ink-3" data-testid="work-empty">
          {all.isPending ? "Loading…" : "Nothing has finished yet."}
        </Panel>
      ) : (
        <div className="@container overflow-hidden rounded-[10px] bg-panel shadow-panel">
          <table className="w-full" data-testid="work-list">
            <thead>
              <tr className="border-line-soft border-b">
                <th className={cn(th, "pl-3.5")}>Item</th>
                {!projectId && <th className={cn(th, "@max-[600px]:hidden")}>Project</th>}
                <th className={th}>Finished</th>
                <th className={th}>Result</th>
                <th className={cn(th, "pr-3.5")}>Pull request</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => {
                const out = outcomeOf(i);
                return (
                  <tr
                    key={i.id}
                    className="border-line-soft border-t align-top first:border-t-0 hover:bg-page"
                    data-testid={`row-${i.id}`}
                  >
                    <td className="py-2.5 pr-3 pl-3.5">
                      <Link {...peekItem(i.id)} className="font-medium hover:underline">
                        <span className="mr-1.5 font-mono font-normal text-[12px] text-ink-muted">
                          #{i.number}
                        </span>
                        {i.title}
                      </Link>
                    </td>
                    {!projectId && (
                      <td className="whitespace-nowrap py-2.5 pr-3 text-ink-3 @max-[600px]:hidden">
                        {name(i.projectId)}
                      </td>
                    )}
                    <td className="whitespace-nowrap py-2.5 pr-3 text-ink-3">{ago(i.updatedAt)}</td>
                    <td className="py-2.5 pr-3" data-testid="outcome">
                      <span className="inline-flex items-start gap-1.5">
                        <StatusDot status={out.status} className="mt-1.5" />
                        {out.label}
                      </span>
                    </td>
                    <td className="whitespace-nowrap py-2.5 pr-3.5 font-mono text-[12px]">
                      {i.prUrl ? (
                        <ExternalLink href={i.prUrl} className="underline">
                          PR #{/\/pull\/(\d+)/.exec(i.prUrl)?.[1] ?? ""}
                        </ExternalLink>
                      ) : (
                        <span className="text-ink-muted">none</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </PageArea>
  );
}
