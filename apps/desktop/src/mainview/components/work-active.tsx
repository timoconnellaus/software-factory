// In the factory and Done (spec 41 slice 2, design WorkActive/WorkActiveAll/WorkDone). A project's
// board has Queued (the lane every workflow has) then one lane per stage of the project's workflow,
// in the order `project.workflow` reports them, empty lanes collapsed; each card has who it waits
// on and its live state, and there is a list layout. Across projects the board's columns are by
// phase (the owner's decision, 2026-11-12): Backlog, Shaping, Ready, Queued, Delivery, Done, so
// every workflow's items share them; its list sorts by who each item waits on. Done is everything
// that finished, with its outcome.

import { ago } from "@software-factory/client/format";
import { Button } from "@software-factory/ui/components/button";
import { Skeleton } from "@software-factory/ui/components/skeleton";
import { StatusDot } from "@software-factory/ui/components/status-dot";
import { ToggleGroup, ToggleGroupItem } from "@software-factory/ui/components/toggle-group";
import { cn } from "@software-factory/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { itemsIn, PRIORITY_SHORT, type Priority } from "../lib/backlog.ts";
import { ExternalLink } from "../lib/external.tsx";
import { peekItem } from "../lib/places.ts";
import { boardsQuery, workflowQuery, workListsQuery } from "../lib/queries.ts";
import { useProjects, useSession } from "../lib/session.ts";
import { groupUnderParents } from "../lib/splits.ts";
import { agentWorking, stageWait } from "../lib/stage-wait.ts";
import {
  type ActiveItem,
  boardLanes,
  cardState,
  cutList,
  FINISHED,
  laneLabel,
  outcomeOf,
  PHASE_COLUMNS,
  type PhaseColumn,
  phaseColumn,
  waitingOn,
  waitingOrder,
} from "../lib/work-board.ts";
import { HeldChip } from "./babysitter.tsx";
import { Chip, PageArea, PageHeader, Panel } from "./shell-list.tsx";
import { useOrgScope, useScopedInbox } from "./shell-sidebar.tsx";
import { ProjectSwitcher } from "./work-backlog.tsx";

export type Layout = "board" | "list";
const IN_FACTORY = ["queued", "running", "waiting", "paused"];
const ON_BOARD = ["backlog", "shaping", "ready", ...IN_FACTORY];

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

/**
 * The board's items in some states, within the chosen org (one project's when given: the read is
 * that project's), and whether the server's 500-item cap cut them.
 */
function useBoardItems(projectId: string | null, states: string[]) {
  const session = useSession();
  const orgId = useOrgScope();
  const board = useQuery(
    boardsQuery(
      session.orgs.map((o) => o.id),
      projectId,
    ),
  );
  // A read that failed keeps its last data: what each item waited on then may no longer be true.
  const all = board.isError
    ? (board.data?.items ?? []).map((i) => ({ ...i, waitingOn: null }))
    : (board.data?.items ?? []);
  const items = itemsIn(all, states, { orgId, projectId });
  // The read returns at most 500 of the states it was asked for; its counts are every item's.
  const cut = board.data
    ? cutList(board.data.counts, itemsIn(all, ON_BOARD, { orgId, projectId }).length, {
        states: ON_BOARD,
        orgId,
        projectId,
      })
    : null;
  return { items, counts: board.data?.counts ?? [], loading: board.isPending, cut };
}

/** "Showing 500 of 612": said on the board when the read was cut, never dropped silently. */
function CutNote({ cut }: { cut: { shown: number; of: number } | null }) {
  if (!cut) return null;
  return (
    <span className="whitespace-nowrap text-status-waiting text-xs" data-testid="cut-note">
      Showing {cut.shown} of {cut.of}: the board reads at most 500, in priority order
    </span>
  );
}

/** The item open in the side panel (`?item=`), so its card and row show as current. */
function useOpenItem(): string | undefined {
  return useRouterState({ select: (s) => (s.location.search as { item?: string }).item });
}

/** "14 min", "3 h": how long since it last changed. */
const since = (iso: string) => ago(iso).replace(" ago", "");

function Empty({ loading, children }: { loading: boolean; children: React.ReactNode }) {
  return (
    <div className="p-6 text-ink-muted" data-testid="work-empty">
      {loading ? "Loading…" : children}
    </div>
  );
}

function LayoutToggle({ layout, onLayout }: { layout: Layout; onLayout: (l: Layout) => void }) {
  return (
    <ToggleGroup
      type="single"
      value={layout}
      onValueChange={(v) => v && onLayout(v as Layout)}
      className="flex-none rounded-[7px] bg-selected p-0.5"
      data-testid="layout"
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
  );
}

/**
 * A row of columns that scrolls sideways, with a visible way to: the edge that has more fades and
 * shows an arrow button (the window hides scrollbars until you scroll).
 */
function ScrollRow({ children, testId }: { children: React.ReactNode; testId: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState({ left: false, right: false });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () =>
      setMore({
        left: el.scrollLeft > 1,
        right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1,
      });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    for (const child of el.children) observer.observe(child);
    el.addEventListener("scroll", measure, { passive: true });
    return () => {
      observer.disconnect();
      el.removeEventListener("scroll", measure);
    };
  }, []);
  const by = (dx: number) => ref.current?.scrollBy({ left: dx, behavior: "smooth" });
  return (
    <div className="relative flex min-h-0 flex-1">
      <div ref={ref} className="flex min-h-0 flex-1 gap-2 overflow-x-auto p-3" data-testid={testId}>
        {children}
      </div>
      {more.left && (
        <div className="pointer-events-none absolute inset-y-0 left-0 flex w-12 items-center bg-gradient-to-r from-page to-transparent pl-1.5">
          <Button
            variant="outline"
            size="icon-md"
            className="pointer-events-auto rounded-full bg-panel shadow-panel"
            aria-label="Scroll left"
            onClick={() => by(-320)}
          >
            <ChevronLeftIcon />
          </Button>
        </div>
      )}
      {more.right && (
        <div
          className="pointer-events-none absolute inset-y-0 right-0 flex w-12 items-center justify-end bg-gradient-to-l from-page to-transparent pr-1.5"
          data-testid="scroll-more"
        >
          <Button
            variant="outline"
            size="icon-md"
            className="pointer-events-auto rounded-full bg-panel shadow-panel"
            aria-label="Scroll right"
            onClick={() => by(320)}
          >
            <ChevronRightIcon />
          </Button>
        </div>
      )}
    </div>
  );
}

/** A collapsed lane: its count and its name, written down the side. */
function CollapsedLane({ label, n, testId }: { label: string; n: number; testId: string }) {
  return (
    <div
      className="flex w-10 flex-none flex-col items-center gap-2 rounded-[10px] bg-window py-2.5"
      data-testid={testId}
      data-empty
    >
      <span className="font-semibold text-[13px]">{n}</span>
      <span className="text-ink-3 [writing-mode:vertical-rl]">{label}</span>
    </div>
  );
}

/** A lane's frame: about 160px, sharing the room, so four fit beside each other at 1200 wide. */
const LANE =
  "flex min-w-[156px] max-w-[280px] flex-[1_0_160px] flex-col gap-2 overflow-y-auto rounded-[10px] bg-window p-1.5";

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
  const workflow = useQuery(workflowQuery(projectId));
  const { items, loading, cut } = useBoardItems(projectId, IN_FACTORY);
  const project = projects.data?.find((p) => p.id === projectId);
  const waiting = items.filter((i) => needsYou.has(i.id)).length;
  const stages = workflow.data?.stages ?? [];
  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-page" id="main" data-testid="page">
      <div className="flex h-12 flex-none items-center gap-2.5 overflow-hidden border-line-soft border-b bg-panel px-3.5">
        <span className="size-2.5 flex-none rounded-[3px] bg-ink" />
        <h1 className="m-0 truncate font-semibold text-[14px]" data-testid="work-title">
          <Link to="/work" search={{ project: projectId }} className="hover:underline">
            {project?.name ?? "Project"}
          </Link>
        </h1>
        {workflow.data?.workflow && (
          <Chip className="flex-none" data-testid="board-workflow">
            {workflow.data.workflow.label}
          </Chip>
        )}
        <span className="whitespace-nowrap text-ink-muted" data-testid="work-count">
          {items.length} {items.length === 1 ? "item" : "items"}
        </span>
        <span aria-hidden className="mx-1 h-4 w-px flex-none bg-line" />
        <LayoutToggle layout={layout} onLayout={onLayout} />
        <CutNote cut={cut} />
        <span className="flex-1" />
        {waiting > 0 && (
          <Chip tone="amber" className="px-2.5 py-1 text-xs">
            {waiting} waiting on you
          </Chip>
        )}
      </div>
      {items.length === 0 && !loading ? (
        <Empty loading={false}>
          Nothing from {project?.name ?? "this project"} is in the factory.{" "}
          <Link
            to="/work"
            search={{ view: "ready", project: projectId }}
            className="text-ink underline"
          >
            Release ready work
          </Link>
        </Empty>
      ) : layout === "list" ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-3.5">
          <ActiveTable items={items} needsYou={needsYou} showProject={false} stages={stages} />
        </div>
      ) : workflow.isPending || loading ? (
        <div className="flex min-h-0 flex-1 gap-2 p-3" data-testid="board-loading">
          {[0, 1, 2, 3].map((n) => (
            <Skeleton key={n} className="h-40 min-w-[156px] flex-[1_0_160px] rounded-[10px]" />
          ))}
        </div>
      ) : (
        <ScrollRow testId="board">
          {boardLanes(items, stages).map((lane) =>
            lane.items.length === 0 ? (
              <CollapsedLane key={lane.key} label={lane.label} n={0} testId={`lane-${lane.key}`} />
            ) : (
              <section key={lane.key} className={LANE} data-testid={`lane-${lane.key}`}>
                <div className="flex items-center gap-1.5 px-1.5 pt-1 pb-1">
                  <span className="font-semibold text-[13px]">{lane.label}</span>
                  <span className="text-ink-muted">{lane.items.length}</span>
                </div>
                {lane.items.map((i) => (
                  <BoardCard key={i.id} item={i} needsYou={needsYou} />
                ))}
              </section>
            ),
          )}
        </ScrollRow>
      )}
    </main>
  );
}

function BoardCard({ item, needsYou }: { item: ActiveItem; needsYou: Set<string> }) {
  const open = useOpenItem() === item.id;
  // No agent working on it: what it waits on, not "Working" (stage-wait.ts).
  const wait = stageWait(item);
  const state =
    item.status === "queued"
      ? { label: "Queued", tone: "neutral" as const, needsYou: false }
      : wait && !needsYou.has(item.id)
        ? { label: "Waiting", tone: "neutral" as const, needsYou: false }
        : cardState(item, needsYou);
  const who =
    wait && !needsYou.has(item.id)
      ? { label: wait, status: "waiting" as const }
      : waitingOn(item, needsYou);
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
            {item.kind === "incident"
              ? "incident"
              : item.kind === "attached"
                ? "attached PR"
                : item.kind === "autopilot"
                  ? "autopilot run"
                  : item.kind}
          </span>
        )}
        <Chip tone={state.tone} className="ml-auto">
          {state.tone === "blue" && <StatusDot status="running" />}
          {state.label}
        </Chip>
      </div>
      <div className="font-medium leading-snug">{item.title}</div>
      <HeldChip projectId={item.projectId} workItemId={item.id} enabled={item.stage === "merge"} />
      <div className="flex items-start gap-1.5 text-ink-muted text-xs" data-testid="card-who">
        <StatusDot status={who.status} className="mt-1" />
        <span className="min-w-0 flex-1" data-testid={wait ? "stage-wait" : undefined}>
          {wait && !needsYou.has(item.id) ? wait : (item.statusReason ?? who.label)}
        </span>
        <span className="ml-auto flex-none">{since(item.updatedAt)}</span>
      </div>
    </Link>
  );
}

/** The list's "Waiting on" cell: what the stage waits on when no agent works on it (stage-wait.ts). */
function WhoCell({
  item,
  who,
  needsYou,
}: {
  item: ActiveItem;
  who: { label: string; status: "waiting" | "running" | "idle" };
  needsYou: boolean;
}) {
  const wait = stageWait(item);
  const shown = wait && !needsYou ? { label: wait, status: "waiting" as const } : who;
  return (
    <span className="inline-flex items-center gap-1.5">
      <StatusDot status={shown.status} />
      {shown.label}
    </span>
  );
}

function ActiveTable({
  items,
  needsYou,
  showProject,
  stages,
}: {
  items: ActiveItem[];
  needsYou: Set<string>;
  showProject: boolean;
  /** The project's workflow stages, for the Stage column; across projects, its phase instead. */
  stages: { stage: string; label: string }[] | null;
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
            <th className={cn(th, "w-full pl-3.5")}>Item</th>
            <th className={th}>{stages ? "Stage" : "Phase"}</th>
            <th className={th}>Waiting on</th>
            {showProject && <th className={cn(th, "@max-[560px]:hidden")}>Project</th>}
            <th className={cn(th, "pr-3.5 text-right")}>For</th>
          </tr>
        </thead>
        <tbody>
          {groupUnderParents(items).map(({ item: i, depth }) => {
            const who = waitingOn(i, needsYou);
            return (
              <tr
                key={i.id}
                className={cn(
                  "border-line-soft border-t first:border-t-0 hover:bg-page",
                  openId === i.id && "bg-selected hover:bg-selected",
                )}
                aria-current={openId === i.id ? "true" : undefined}
                data-testid={`row-${i.id}`}
              >
                <td className={cn("py-2.5 pr-3 pl-3.5", depth === 1 && "pl-9")}>
                  {depth === 1 && (
                    <>
                      <span className="mr-1.5 text-ink-muted" aria-hidden>
                        ↳
                      </span>
                      <span className="sr-only">Part of the item above: </span>
                    </>
                  )}
                  <Link {...peekItem(i.id)} className="font-medium hover:underline">
                    <span className="mr-1.5 font-mono font-normal text-[12px] text-ink-muted">
                      #{i.number}
                    </span>
                    {i.title}
                  </Link>
                </td>
                <td className="whitespace-nowrap py-2.5 pr-3 text-ink-3">
                  {stages
                    ? laneLabel(i, stages)
                    : PHASE_COLUMNS.find((c) => c.key === phaseColumn(i))?.label}
                </td>
                <td className="whitespace-nowrap py-2.5 pr-3">
                  <WhoCell item={i} who={who} needsYou={needsYou.has(i.id)} />
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

/** How many cards a phase column shows before "N more" (the column's view has them all). */
const COLUMN_CAP = 20;

export function ActiveAll({ layout, onLayout }: { layout: Layout; onLayout: (l: Layout) => void }) {
  const needsYou = useNeedsYou();
  const session = useSession();
  const orgId = useOrgScope();
  const { items: onBoard, counts, loading, cut } = useBoardItems(null, ON_BOARD);
  const recent = useQuery(workListsQuery(session.orgs.map((o) => o.id)));
  const inFactory = onBoard.filter((i) => IN_FACTORY.includes(i.status));
  const sorted = [...inFactory].sort(
    (a, b) =>
      waitingOrder(a, needsYou) - waitingOrder(b, needsYou) ||
      Date.parse(a.updatedAt) - Date.parse(b.updatedAt),
  );
  const count = (f: (i: ActiveItem) => boolean) => inFactory.filter(f).length;
  const cards: [string, number, string][] = [
    ["Waiting on you", count((i) => needsYou.has(i.id)), "a gate or a question"],
    // Only an item a runner has claimed a job for (the board's waitingOn): a running item between
    // jobs, waiting on CI or a runner, is waiting.
    ["Agent working", count((i) => !needsYou.has(i.id) && agentWorking(i)), "on a runner now"],
    [
      "Waiting",
      count(
        (i) =>
          !needsYou.has(i.id) &&
          !agentWorking(i) &&
          (i.status === "running" || i.status === "waiting" || i.status === "paused"),
      ),
      "on someone else or an event",
    ],
    ["Queued", count((i) => i.status === "queued"), "released, not started"],
  ];
  // Each column's true size, from the board's counts (the list itself may be cut).
  const total = (key: PhaseColumn) =>
    counts
      .filter((c) => orgId === null || c.orgId === orgId)
      .filter((c) => phaseColumn({ status: c.status }) === key)
      .reduce((n, c) => n + c.n, 0);
  const finished = (recent.data ?? []).filter(
    (i) => FINISHED.includes(i.status) && (orgId === null || i.orgId === orgId),
  );
  return (
    <main className="flex min-h-0 min-w-0 flex-1 flex-col bg-page" id="main" data-testid="page">
      <div className="flex flex-none flex-col gap-4 px-[22px] pt-[18px] pb-1">
        <PageHeader
          title="In the factory"
          testId="work-title"
          sub="Every project's work by phase: before release (Backlog, Shaping, Ready), released (Queued, Delivery), then Done. Open a project to see its board by stage."
          actions={
            <>
              <CutNote cut={cut} />
              <LayoutToggle layout={layout} onLayout={onLayout} />
            </>
          }
        />
        {layout === "list" && (
          <div className="flex flex-wrap gap-2.5" data-testid="active-counts">
            {cards.map(([label, n, sub]) => (
              <Panel key={label} className="min-w-[140px] flex-1 gap-1 px-3.5 py-3">
                <span className="text-ink-3 text-xs">{label}</span>
                <span className="font-semibold text-[20px] tabular-nums leading-tight">{n}</span>
                <span className="text-ink-muted text-xs">{sub}</span>
              </Panel>
            ))}
          </div>
        )}
      </div>
      {layout === "board" ? (
        loading ? (
          <div className="flex min-h-0 flex-1 gap-2 p-3" data-testid="board-loading">
            {PHASE_COLUMNS.map((c) => (
              <Skeleton
                key={c.key}
                className="h-40 min-w-[156px] flex-[1_0_160px] rounded-[10px]"
              />
            ))}
          </div>
        ) : (
          <ScrollRow testId="phase-board">
            {PHASE_COLUMNS.map((c) => {
              const list =
                c.key === "done" ? finished : onBoard.filter((i) => phaseColumn(i) === c.key);
              const n = c.key === "done" ? total("done") : Math.max(total(c.key), list.length);
              if (list.length === 0) {
                return (
                  <CollapsedLane key={c.key} label={c.label} n={n} testId={`column-${c.key}`} />
                );
              }
              const shown = list.slice(0, COLUMN_CAP);
              return (
                <section key={c.key} className={LANE} data-testid={`column-${c.key}`}>
                  <div className="flex items-center gap-1.5 px-1.5 pt-1 pb-1">
                    <span className="font-semibold text-[13px]">{c.label}</span>
                    <span className="text-ink-muted">{n}</span>
                  </div>
                  {shown.map((i) => (
                    <PhaseCard key={i.id} item={i} needsYou={needsYou} column={c.key} />
                  ))}
                  {n > shown.length && (
                    <Link
                      to="/work"
                      search={{ view: c.view }}
                      className="px-1.5 py-1 text-ink-3 text-xs underline"
                    >
                      {n - shown.length} more in {c.label}
                    </Link>
                  )}
                </section>
              );
            })}
          </ScrollRow>
        )
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-[22px] pt-3 pb-7">
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
            <ActiveTable items={sorted} needsYou={needsYou} showProject stages={null} />
          )}
        </div>
      )}
    </main>
  );
}

/** A card on the phase board: the item, its project, and what it waits on or how it ended. */
function PhaseCard({
  item,
  needsYou,
  column,
}: {
  item: {
    id: string;
    number: number;
    title: string;
    status: string;
    statusReason: string | null;
    projectId: string;
    updatedAt: string;
    stage?: string;
    priority?: string | null;
    blockedBy?: ActiveItem["blockedBy"];
    waitingOn?: ActiveItem["waitingOn"];
  };
  needsYou: Set<string>;
  column: PhaseColumn;
}) {
  const projects = useProjects();
  const open = useOpenItem() === item.id;
  const project = projects.data?.find((p) => p.id === item.projectId)?.name ?? "project";
  const wait = item.stage ? stageWait({ ...item, stage: item.stage }) : null;
  const line =
    wait && column === "delivery" && !needsYou.has(item.id)
      ? { label: wait, status: "waiting" as const }
      : column === "done"
        ? outcomeOf(item)
        : column === "queued" || column === "delivery"
          ? waitingOn({ ...item, blockedBy: item.blockedBy ?? [] }, needsYou)
          : {
              label: `${PRIORITY_SHORT[(item.priority ?? "normal") as Priority]}${item.statusReason ? ` · ${item.statusReason}` : ""}`,
              status: "idle" as const,
            };
  return (
    <Link
      {...peekItem(item.id)}
      className={cn(
        "flex flex-col gap-1 rounded-lg bg-panel px-2.5 py-2 shadow-panel hover:brightness-[0.99]",
        needsYou.has(item.id) && "shadow-needs-you",
        open && "ring-2 ring-ink/50",
      )}
      aria-current={open ? "true" : undefined}
      data-testid={`card-${item.id}`}
    >
      <div className="flex items-center gap-2 text-ink-muted text-xs">
        <span className="font-mono text-[11.5px]">#{item.number}</span>
        <span className="truncate">{project}</span>
      </div>
      <div className="font-medium leading-snug">{item.title}</div>
      <HeldChip projectId={item.projectId} workItemId={item.id} enabled={item.stage === "merge"} />
      <div className="flex items-start gap-1.5 text-ink-muted text-xs">
        <StatusDot status={line.status} className="mt-1" />
        <span className="min-w-0 flex-1">{line.label}</span>
        <span className="ml-auto flex-none">{since(item.updatedAt)}</span>
      </div>
    </Link>
  );
}

// —— Done ——————————————————————————————————————————————————————————————————————————————————

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
                <th className={cn(th, "w-full pl-3.5")}>Item</th>
                {!projectId && <th className={cn(th, "@max-[600px]:hidden")}>Project</th>}
                <th className={th}>Last updated</th>
                <th className={cn(th, "w-[240px] min-w-[180px]")}>Result</th>
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
