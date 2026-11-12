// A work item (spec 13; restyled for spec 41, design ItemOverview/ItemPlan/ItemRuns/ItemReview/
// ItemActivity): the crumbs and title, the stage strip, then Overview, Plan, Runs, Review and
// Activity. Plan is docked in the page; F gives it the whole window (focus mode, Esc to leave).

import {
  ago,
  capitalise,
  duration,
  errorMessage,
  STAGE_LABEL,
} from "@software-factory/client/format";
import type { WorkItemDetail } from "@software-factory/client/ops";
import { parsePacket } from "@software-factory/client/packet";
import { agentTime, stageSteps, yourTime } from "@software-factory/client/work-item";
import { Button } from "@software-factory/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@software-factory/ui/components/dialog";
import { Kbd } from "@software-factory/ui/components/kbd";
import { Skeleton } from "@software-factory/ui/components/skeleton";
import { StatusDot } from "@software-factory/ui/components/status-dot";
import { cn } from "@software-factory/ui/lib/utils";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createRoute, Link, useNavigate } from "@tanstack/react-router";
import { Maximize2Icon, PinIcon, PinOffIcon, XIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import { toast } from "sonner";
import { Attachments } from "../components/attachments.tsx";
import {
  BacklogDetails,
  isPreRelease,
  NextStep,
  PRE_STATE_LABEL,
  PRE_STATES,
} from "../components/item-backlog.tsx";
import { OpenTerminal } from "../components/open-terminal.tsx";
import { Planning } from "../components/planning.tsx";
import { ReviewPacket } from "../components/review-packet.tsx";
import { CriteriaList } from "../components/review-parts.tsx";
import { Chip, PageArea, Panel, SectionTitle } from "../components/shell-list.tsx";
import { Timeline } from "../components/timeline.tsx";
import { ExternalLink } from "../lib/external.tsx";
import { OpError, op } from "../lib/op.ts";
import { closeTerminal } from "../lib/open-terminals.ts";
import {
  PANEL_FULL_BELOW,
  PANEL_MIN,
  panelWidth,
  rememberWidth,
  storedWidth,
} from "../lib/panel.ts";
import {
  attachmentsQuery,
  boardsQuery,
  planningQuery,
  runnersQuery,
  timelineQuery,
  useRefreshAfterDecision,
  workItemQuery,
} from "../lib/queries.ts";
import { useProjects, useSession } from "../lib/session.ts";
import { isTypingTarget } from "../lib/shortcuts.ts";
import { togglePin, updateViewState, useViewState } from "../lib/view-state.ts";
import { workLayout } from "./_work.tsx";

export const TABS = ["overview", "plan", "runs", "review", "activity"] as const;
export type Tab = (typeof TABS)[number];
/** The tab names before spec 41, which links and bookmarks may still carry. */
const OLD: Record<string, Tab> = { timeline: "activity", planning: "plan" };

/** Before release an item has no runs or review yet (design ItemBacklog). */
export const PRE_RELEASE_TABS: readonly Tab[] = ["overview", "plan", "activity"];
export const tabsFor = (status: string): readonly Tab[] =>
  isPreRelease(status) ? PRE_RELEASE_TABS : TABS;

export function parseTab(v: unknown): Tab | undefined {
  if (typeof v !== "string") return undefined;
  if ((TABS as readonly string[]).includes(v)) return v as Tab;
  return OLD[v];
}

export const Route = createRoute({
  getParentRoute: () => workLayout,
  path: "/work/$id",
  validateSearch: (s: Record<string, unknown>): { tab?: Tab } => {
    const tab = parseTab(s.tab);
    return tab ? { tab } : {};
  },
  // Everything the page renders, in one request: the item (with its spec, questions, gates, runs
  // and packet), its timeline, the runners (for runner names), and the planning view (spec 20).
  loader: ({ context: { queryClient, session }, params }) =>
    Promise.all([
      // The org's board: what an item before release can wait for (its edit dialog).
      queryClient.ensureQueryData(boardsQuery(session.orgs.map((o) => o.id))).catch(() => null),
      queryClient.ensureQueryData(workItemQuery(params.id)),
      queryClient.ensureQueryData(timelineQuery(params.id)).catch(() => null),
      queryClient.ensureQueryData(runnersQuery()).catch(() => null),
      queryClient.ensureQueryData(attachmentsQuery(params.id)).catch(() => null),
      queryClient.ensureQueryData(planningQuery(params.id)).catch(() => null),
    ]),
  pendingComponent: () => (
    <PageArea>
      <Skeleton className="h-6 w-60" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-64 w-full" />
    </PageArea>
  ),
  errorComponent: WorkItemError,
  component: WorkItemPage,
});

function WorkItemError({ error }: { error: unknown }) {
  // An OpError carries its code (an own property).
  const code = (error as { code?: unknown } | null)?.code;
  const notFound = code === "not_found" || code === "forbidden";
  return (
    <PageArea>
      <h1 className="m-0 font-semibold text-[18px]">
        {notFound ? "Work item not found" : "Couldn't load this work item"}
      </h1>
      <p className="text-ink-muted">
        {notFound ? "It doesn't exist, or it isn't in one of your orgs." : errorMessage(error)}{" "}
        <Link to="/" className="text-ink underline">
          Back to the inbox
        </Link>
      </p>
    </PageArea>
  );
}

function WorkItemPage() {
  const { id } = Route.useParams();
  const { tab: asked = "overview" } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { data: d } = useSuspenseQuery(workItemQuery(id));
  const focus = useViewState((s) => s.focus);
  const tab = asked;

  // Focus mode: the planning has the whole window (the shell hides its chrome).
  if (focus === id) return <Planning detail={d} mode="focus" />;

  const go = (t: Tab) => navigate({ search: { tab: t }, replace: true });
  return <ItemView detail={d} tab={tab} onTab={go} />;
}

/** The side panel's own controls (spec 41 slice 7): back to full size, and close. */
export interface PanelControls {
  onExpand: () => void;
  onClose: () => void;
}

/**
 * A work item: its header, stage strip, tabs and the open tab. The page renders it full size; the
 * Work board renders the same view in its side panel (`panel`), with Expand and Close in the header.
 */
export function ItemView({
  detail: d,
  tab: asked,
  onTab,
  panel,
}: {
  detail: WorkItemDetail;
  tab: Tab;
  onTab: (t: Tab) => void;
  panel?: PanelControls;
}) {
  const tab = tabsFor(d.item.status).includes(asked) ? asked : "overview";
  const scroller = useRef<HTMLDivElement>(null);
  // Expanded from the side panel: the page opens where the panel was scrolled to.
  useLayoutEffect(() => {
    if (panel || carried?.id !== d.item.id) return;
    if (scroller.current) scroller.current.scrollTop = carried.top;
    carried = null;
  }, [panel, d.item.id]);
  const head = (
    <div className={cn("flex flex-col gap-3 pt-[18px]", panel ? "px-[18px]" : "px-[22px]")}>
      <Header detail={d} inPanel={!!panel} />
      <StageStrip detail={d} />
      <TabBar detail={d} tab={tab} onTab={onTab} />
    </div>
  );
  // In the panel the view is the panel's content, not the page: one main landmark (the list's).
  const Body = panel ? "div" : "main";

  if (tab === "plan") {
    return (
      <Body
        className="flex min-h-0 min-w-0 flex-1 flex-col bg-page"
        data-testid={panel ? "panel-body" : "page"}
      >
        {head}
        <div className="flex min-h-0 flex-1 flex-col">
          <Planning detail={d} mode="docked" />
        </div>
      </Body>
    );
  }
  return (
    <Body
      ref={scroller}
      className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-page"
      data-testid={panel ? "panel-body" : "page"}
    >
      {head}
      <div className={cn("flex flex-col gap-4 pt-4 pb-7", panel ? "px-[18px]" : "px-[22px]")}>
        {tab === "overview" && <Overview detail={d} onTab={onTab} />}
        {tab === "runs" && <Runs detail={d} />}
        {tab === "review" && <ReviewPacket detail={d} />}
        {tab === "activity" && <Activity detail={d} />}
      </div>
    </Body>
  );
}

/** Where the panel was scrolled when it expanded, for the page to open there. */
let carried: { id: string; top: number } | null = null;

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The item side panel (spec 41 slice 7, design WorkActivePanel, README "The item side panel"): the
 * same view as the page, beside the Work list, which stays readable. A complementary region named
 * by the item; it opens at once with its skeleton and loads inside. Opening moves focus into it,
 * Tab stays inside it (and its terminal) while it is open, and the list returns focus to the card
 * when it closes. Esc closes it and ⌘↵ expands it to the page, neither while typing in a field, a
 * dialog is open, or the terminal has the keyboard (the terminal dock takes Esc first). Its left
 * edge drags to resize; the width is remembered. Closing it, or showing another item, closes its
 * terminal and so releases the socket; expanding keeps the tab, the scroll and the terminal.
 */
export function ItemPanel({
  id,
  tab,
  onTab,
  onClose,
  onExpand,
}: {
  id: string;
  tab: Tab;
  onTab: (t: Tab) => void;
  onClose: () => void;
  onExpand: () => void;
}) {
  const item = useQuery(workItemQuery(id));
  const projects = useProjects();
  const aside = useRef<HTMLElement>(null);
  const [wanted, setWanted] = useState(storedWidth);
  const [room, setRoom] = useState({ page: 1000, list: 0 });
  const expanding = useRef(false);
  const expand = () => {
    expanding.current = true;
    const body = aside.current?.querySelector<HTMLElement>("[data-testid=panel-body]");
    carried = { id, top: body?.scrollTop ?? 0 };
    onExpand();
  };
  // Focus mode (F, or Focus on the Plan tab) gives planning the whole window: from the panel, the
  // page opens first and focus applies there.
  const focus = useViewState((s) => s.focus);
  const keys = useRef({ onClose, expand });
  keys.current = { onClose, expand };
  useEffect(() => {
    if (focus === id) keys.current.expand();
  }, [focus, id]);
  // Opening moves focus into the panel. Closing it, or showing another item (the list remounts the
  // panel per item), closes this item's terminal: its socket is released. Expanding keeps it.
  useEffect(() => {
    aside.current?.focus({ preventScroll: true });
    return () => {
      if (!expanding.current) closeTerminal(id);
    };
  }, [id]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (document.querySelector("[role=dialog], [data-radix-popper-content-wrapper]")) return;
      if (isTypingTarget(e.target as Element | null)) return;
      if (e.key === "Escape") {
        e.preventDefault();
        keys.current.onClose();
      } else if (e.key === "Enter" && e.metaKey) {
        e.preventDefault();
        keys.current.expand();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  // The room it has: the page area it sits over, and the list beside it.
  useEffect(() => {
    const host = aside.current?.parentElement;
    if (!host) return;
    const measure = () =>
      setRoom({
        page: host.clientWidth,
        list: document.querySelector<HTMLElement>("[data-nested-list]")?.offsetWidth ?? 0,
      });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);
  const full = room.page < PANEL_FULL_BELOW;
  const width = panelWidth(wanted, room.page, room.list);

  /** Tab and Shift-Tab cycle inside the panel and its terminal while it is open. */
  const trapTab = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab" || !aside.current) return;
    const dock = document.querySelector<HTMLElement>("[data-testid=terminal-dock]");
    const all = [
      ...aside.current.querySelectorAll<HTMLElement>(FOCUSABLE),
      ...(dock ? dock.querySelectorAll<HTMLElement>(FOCUSABLE) : []),
    ].filter((el) => el.offsetParent !== null);
    const first = all[0];
    const last = all.at(-1);
    if (!first || !last) return;
    const at = document.activeElement;
    if (e.shiftKey && (at === first || at === aside.current)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && at === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const right = aside.current?.getBoundingClientRect().right ?? window.innerWidth;
    let next = wanted;
    const move = (m: PointerEvent) => {
      next = Math.round(right - m.clientX);
      setWanted(next);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      remember(panelWidth(next, room.page, room.list));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const remember = (w: number) => {
    setWanted(w);
    rememberWidth(w);
  };
  const title = item.data ? `#${item.data.item.number} ${item.data.item.title}` : "Work item";
  const project = projects.data?.find((p) => p.id === item.data?.item.projectId);

  return (
    <aside
      ref={aside}
      aria-label={title}
      tabIndex={-1}
      onKeyDown={trapTab}
      className="absolute inset-y-2 right-2 z-30 flex flex-col overflow-hidden rounded-xl bg-page shadow-[0_0_0_1px_var(--line),0_16px_48px_rgba(0,0,0,0.18)] outline-none"
      style={{ width: full ? "calc(100% - 16px)" : width }}
      data-testid="item-panel"
      data-terminal-host=""
      data-width={full ? "full" : width}
    >
      {!full && (
        // biome-ignore lint/a11y/useSemanticElements: a draggable splitter has no native element.
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize the panel"
          aria-valuenow={width}
          aria-valuemin={PANEL_MIN}
          aria-valuemax={Math.floor((room.page + room.list) / 2)}
          tabIndex={0}
          onPointerDown={startResize}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") remember(panelWidth(width + 40, room.page, room.list));
            if (e.key === "ArrowRight") remember(panelWidth(width - 40, room.page, room.list));
          }}
          className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize hover:bg-line focus-visible:bg-ring/40 focus-visible:outline-none"
          data-testid="panel-resize"
        />
      )}
      <div className="flex h-11 flex-none items-center gap-2 border-line-soft border-b px-3.5">
        <span className="min-w-0 truncate text-ink-3 text-xs" data-testid="panel-crumbs">
          {project?.name ?? "Project"} <span className="text-ink-muted">›</span>{" "}
          <span className="font-mono">{item.data ? `#${item.data.item.number}` : ""}</span>
        </span>
        <span className="flex-1" />
        <Button
          variant="ghost"
          size="md"
          title="Open it full size (⌘↵)"
          onClick={expand}
          data-testid="panel-expand"
        >
          <Maximize2Icon />
          Expand
          <Kbd className="ml-0.5">⌘↵</Kbd>
        </Button>
        <span aria-hidden className="mx-0.5 h-4 w-px bg-line" />
        <Button
          variant="ghost"
          size="icon-md"
          aria-label="Close the panel (Esc)"
          title="Close (Esc)"
          onClick={onClose}
          data-testid="panel-close"
        >
          <XIcon />
        </Button>
      </div>
      {item.data ? (
        <ItemView
          detail={item.data}
          tab={tab}
          onTab={onTab}
          panel={{ onClose, onExpand: expand }}
        />
      ) : item.error ? (
        <div className="flex flex-col gap-2 p-5">
          <p className="m-0 text-ink-3">{errorMessage(item.error)}</p>
          <Button variant="outline" size="md" className="w-fit" onClick={onClose}>
            Close
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-3 p-5" data-testid="panel-loading">
          <Skeleton className="h-6 w-60" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      )}
    </aside>
  );
}

/** The item's title and actions. In the side panel its bar has the crumbs and Close already. */
function Header({ detail, inPanel = false }: { detail: WorkItemDetail; inPanel?: boolean }) {
  const { item } = detail;
  const projects = useProjects();
  const project = projects.data?.find((p) => p.id === item.projectId);
  const pinned = useViewState((s) => s.pins.includes(item.id));
  const [cancel, setCancel] = useState(false);
  const active = ["running", "waiting", "paused"].includes(item.status);
  const pre = isPreRelease(item.status);
  return (
    <header className="flex flex-wrap items-end gap-2.5">
      <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-1">
        <div className={cn("text-ink-3 text-xs", inPanel && "sr-only")} data-testid="crumbs">
          <Link to="/work" className="underline">
            Work
          </Link>{" "}
          /{" "}
          <Link to="/work" search={{ project: item.projectId }} className="underline">
            {project?.name ?? "project"}
          </Link>{" "}
          / <span className="font-mono">#{item.number}</span>
          {item.kind === "incident" && <Chip className="ml-2">factory incident</Chip>}
          {item.kind === "attached" && <Chip className="ml-2">attached PR</Chip>}
          {detail.mergeQueue && (
            <Chip className="ml-2" data-testid="merge-queue">
              {detail.mergeQueue.position === 1
                ? "Landing: next in the merge queue"
                : `Queued to merge behind ${detail.mergeQueue.ahead.map((n) => `#${n}`).join(", ")}`}
            </Chip>
          )}
        </div>
        <h1
          className="m-0 font-semibold text-[18px] tracking-[-0.015em]"
          data-testid="work-item-title"
        >
          #{item.number} {item.title}
        </h1>
      </div>
      <div className="flex flex-wrap items-center gap-2" data-testid="item-actions">
        <Button
          variant="outline"
          size="icon-md"
          aria-label={pinned ? "Unpin" : "Pin to the sidebar"}
          title={pinned ? "Unpin" : "Pin to the sidebar"}
          onClick={() => updateViewState((s) => togglePin(s, item.id))}
          data-testid="pin"
        >
          {pinned ? <PinOffIcon className="size-3.5" /> : <PinIcon className="size-3.5" />}
        </Button>
        <OpenTerminal detail={detail} />
        {(active || pre) && (detail.viewer.isRequester || detail.viewer.isApprover) && (
          <Button
            variant="outline"
            size="md"
            className="text-destructive hover:text-destructive"
            onClick={() => setCancel(true)}
            data-testid="cancel"
          >
            Cancel item
          </Button>
        )}
      </div>
      <CancelDialog
        open={cancel}
        onOpenChange={setCancel}
        workItemId={item.id}
        started={!pre || item.status === "shaping"}
      />
    </header>
  );
}

function CancelDialog({
  open,
  onOpenChange,
  workItemId,
  started,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  workItemId: string;
  /** Whether its Workflow runs (in the factory, or shaping): else nothing has run yet. */
  started: boolean;
}) {
  const refresh = useRefreshAfterDecision();
  const [busy, setBusy] = useState(false);
  async function confirm() {
    setBusy(true);
    try {
      const r = await op("workItem.cancel", { workItemId, reason: "cancelled from the app" });
      toast.success(r.cancelled ? "Cancelled" : "It had already finished");
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof OpError ? error.message : "Couldn't cancel");
    } finally {
      setBusy(false);
      await refresh(workItemId);
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cancel this work item?</DialogTitle>
          <DialogDescription>
            {started
              ? "Its Workflow and runs stop, its runner slot is freed and its open gates close. This can't be undone."
              : "Nothing has run yet. It leaves the list and shows under Stopped. This can't be undone."}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Keep it
          </Button>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={confirm}
            data-testid="confirm-cancel"
          >
            Cancel work item
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The stages as a strip of dots: done, now, to come, skipped (with triage's reason). */
export function StageStrip({ detail }: { detail: WorkItemDetail }) {
  if (isPreRelease(detail.item.status)) return <PreReleaseStrip detail={detail} />;
  const steps = stageSteps(detail);
  const waiting = detail.item.status === "waiting";
  return (
    <div
      className="flex flex-wrap items-center gap-x-[18px] gap-y-1 rounded-[10px] bg-panel px-3.5 py-2.5 shadow-panel"
      data-testid="stage-steps"
    >
      {steps.map((s) => (
        <span
          key={s.stage}
          data-state={s.state}
          title={s.reason ?? undefined}
          className={cn(
            "inline-flex items-center gap-1.5",
            s.state === "todo" && "text-ink-3",
            s.state === "now" && "font-semibold",
            s.state === "skipped" && "text-ink-muted line-through",
          )}
        >
          <StatusDot
            status={
              s.state === "done"
                ? "done"
                : s.state === "now"
                  ? waiting
                    ? "waiting"
                    : "running"
                  : s.state === "failed"
                    ? "failed"
                    : "idle"
            }
          />
          {STAGE_LABEL[s.stage]}
        </span>
      ))}
      {steps
        .filter((s) => s.state === "skipped")
        .map((s) => (
          <span key={s.stage} className="text-ink-muted text-xs" data-testid="skip-reason">
            {STAGE_LABEL[s.stage]} skipped: {s.reason}
          </span>
        ))}
    </div>
  );
}

/**
 * Before release: the fixed work-management states (spec 50), the one it is in now, then the
 * workflow's stages to come. Planning shows only while it is being shaped.
 */
function PreReleaseStrip({ detail }: { detail: WorkItemDetail }) {
  const status = detail.item.status;
  const states: string[] =
    status === "shaping" ? ["backlog", "shaping", "ready", "queued"] : [...PRE_STATES];
  const at = states.indexOf(status);
  const toCome = stageSteps(detail).filter((s) => s.stage !== "intake");
  return (
    <div
      className="flex flex-wrap items-center gap-x-[18px] gap-y-1 rounded-[10px] bg-panel px-3.5 py-2.5 shadow-panel"
      data-testid="stage-steps"
    >
      {states.map((s, i) => (
        <span
          key={s}
          data-state={i < at ? "done" : i === at ? "now" : "todo"}
          className={cn(
            "inline-flex items-center gap-1.5",
            i > at && "text-ink-3",
            i === at && "font-semibold",
          )}
        >
          <StatusDot status={i < at ? "done" : i === at ? "running" : "idle"} />
          {PRE_STATE_LABEL[s]}
        </span>
      ))}
      {toCome.map((s) => (
        <span
          key={s.stage}
          data-state="todo"
          className="inline-flex items-center gap-1.5 text-ink-3"
        >
          <StatusDot status="idle" />
          {STAGE_LABEL[s.stage]}
        </span>
      ))}
    </div>
  );
}

function TabBar({
  detail,
  tab,
  onTab,
}: {
  detail: WorkItemDetail;
  tab: Tab;
  onTab: (t: Tab) => void;
}) {
  const planWaits =
    detail.questions.some((q) => q.status === "open") ||
    detail.gates.some((g) => g.kind === "spec" && g.status === "pending");
  const reviewWaits = detail.gates.some((g) => g.kind === "merge" && g.status === "pending");
  return (
    <div className="flex gap-1 border-line border-b" role="tablist" data-testid="item-tabs">
      {tabsFor(detail.item.status).map((t) => (
        <button
          key={t}
          type="button"
          role="tab"
          aria-selected={tab === t}
          onClick={() => onTab(t)}
          className={cn(
            "-mb-px inline-flex items-center gap-1.5 border-b-2 border-transparent px-2.5 pt-1 pb-2 text-ink-3 hover:text-ink",
            tab === t && "border-ink font-medium text-ink",
          )}
          data-testid={`tab-${t}`}
        >
          {capitalise(t)}
          {((t === "plan" && planWaits) || (t === "review" && reviewWaits)) && (
            <StatusDot status="waiting" />
          )}
        </button>
      ))}
    </div>
  );
}

function Overview({ detail, onTab }: { detail: WorkItemDetail; onTab: (t: Tab) => void }) {
  const me = useSession().user.id;
  const session = useSession();
  const role = session.orgs.find((o) => o.id === detail.item.orgId)?.role;
  const packet = detail.reviewPacket ? parsePacket(detail.reviewPacket) : null;
  const criteria = detail.spec?.acceptanceCriteria ?? [];
  const mergeGate = detail.gates.find((g) => g.kind === "merge" && g.status === "pending");
  const specGate = detail.gates.find((g) => g.kind === "spec" && g.status === "pending");
  const openQuestions = detail.questions.filter((q) => q.status === "open").length;
  return (
    <div className="flex flex-wrap items-start gap-[18px]">
      <div className="flex min-w-0 flex-[999_1_360px] flex-col gap-[18px]">
        {mergeGate && packet && (
          <Panel needsYou className="gap-2.5 px-3.5 py-3.5" data-testid="waiting-on-you">
            <div className="flex items-center gap-2 font-semibold text-[17px]">
              <StatusDot status="waiting" className="!size-2" />
              Waiting on you to merge or send back
            </div>
            <div className="text-ink-2">
              Verify {packet.verdict === "pass" ? "passed" : "failed"}. The packet was built at
              commit {packet.headSha.slice(0, 7)}.
            </div>
            <Button className="w-fit" onClick={() => onTab("review")}>
              Open the review
            </Button>
          </Panel>
        )}
        {!mergeGate && (specGate || openQuestions > 0) && (
          <Panel needsYou className="gap-2.5 px-3.5 py-3.5" data-testid="waiting-on-you">
            <div className="flex items-center gap-2 font-semibold text-[17px]">
              <StatusDot status="waiting" className="!size-2" />
              {specGate ? "Waiting on you to approve the spec" : "Waiting on your answers"}
            </div>
            {openQuestions > 0 && (
              <div className="text-ink-2">
                {openQuestions} open question{openQuestions === 1 ? "" : "s"}.
              </div>
            )}
            <Button className="w-fit" onClick={() => onTab("plan")}>
              Open the plan
            </Button>
          </Panel>
        )}
        <section className="flex flex-col gap-2">
          <SectionTitle>Description</SectionTitle>
          <Panel className="leading-normal [&_code]:font-mono [&_code]:text-xs [&_p]:my-0.5">
            {detail.item.body ? <Markdown>{detail.item.body}</Markdown> : "No description."}
          </Panel>
        </section>
        <section className="flex flex-col gap-2" data-testid="criteria-section">
          <SectionTitle note="Set in the spec, proven in verify">Acceptance criteria</SectionTitle>
          {packet ? (
            <CriteriaList packet={packet} />
          ) : criteria.length ? (
            <div className="overflow-hidden rounded-[10px] bg-panel shadow-panel">
              {criteria.map((c) => (
                <div
                  key={c}
                  className="flex gap-3 border-line-soft border-t px-3.5 py-3 first:border-t-0"
                >
                  <span className="min-w-0 flex-1 font-medium">{c}</span>
                  <span className="flex items-center gap-1.5 text-ink-muted">
                    <StatusDot status="idle" />
                    Not checked yet
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <Panel className="text-ink-muted">
              {isPreRelease(detail.item.status)
                ? "None yet: they come with its plan, when it is shaped or once it is released."
                : "None yet: they come with the spec."}
            </Panel>
          )}
        </section>
        <Attachments
          workItemId={detail.item.id}
          meId={me}
          isAdmin={role === "owner" || role === "admin"}
        />
      </div>
      <aside className="flex min-w-[260px] flex-[1_1_272px] flex-col gap-3">
        {isPreRelease(detail.item.status) ? (
          <>
            <NextStep detail={detail} />
            <BacklogDetails detail={detail} />
          </>
        ) : (
          <>
            <Details detail={detail} />
            <Taken detail={detail} onTab={onTab} />
          </>
        )}
      </aside>
    </div>
  );
}

function Rows({ children }: { children: React.ReactNode }) {
  return <dl className="m-0 grid grid-cols-[116px_minmax(0,1fr)] gap-x-3 gap-y-2">{children}</dl>;
}
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-ink-3">{label}</dt>
      <dd className="m-0 min-w-0">{children}</dd>
    </>
  );
}

function Details({ detail }: { detail: WorkItemDetail }) {
  const me = useSession().user.id;
  const projects = useProjects();
  const { item } = detail;
  return (
    <Panel className="gap-2.5" data-testid="details">
      <h2 className="m-0 font-semibold text-[13px]">Details</h2>
      <Rows>
        <Row label="Project">
          {projects.data?.find((p) => p.id === item.projectId)?.name ?? "project"}
        </Row>
        {item.size && <Row label="Size">{capitalise(item.size)}</Row>}
        <Row label="From">
          {item.requesterUserId === me ? "You" : "Someone else"}, in {item.source}
        </Row>
        {(detail.workflows.length > 0 || item.workflow) && (
          <Row label="Workflow">
            <WorkflowLine detail={detail} />
          </Row>
        )}
        <Row label="Approvers">
          {detail.approvers.users
            .map((u) => (u.id === me ? "you" : (u.githubLogin ?? u.name)))
            .join(", ") || "nobody"}
        </Row>
        <Row label="Branch">
          <span className="break-all font-mono text-[12px]">{item.branch}</span>
        </Row>
        {item.prUrl && (
          <Row label="Pull request">
            <ExternalLink href={item.prUrl} className="font-mono text-[12px] underline">
              #{item.prNumber}
            </ExternalLink>
          </Row>
        )}
        <Row label="Started">{ago(item.createdAt)}</Row>
        {item.statusReason && <Row label="Now">{item.statusReason}</Row>}
      </Rows>
    </Panel>
  );
}

function Taken({ detail, onTab }: { detail: WorkItemDetail; onTab: (t: Tab) => void }) {
  const me = useSession().user.id;
  const byStage = new Map<string, number>();
  for (const r of detail.runs) byStage.set(r.stage, (byStage.get(r.stage) ?? 0) + 1);
  return (
    <Panel className="gap-2.5">
      <h2 className="m-0 font-semibold text-[13px]">What it has taken</h2>
      <Rows>
        <Row label="Runs">{[...byStage].map(([s, n]) => `${n} ${s}`).join(", ") || "none yet"}</Row>
        <Row label="Agent time">{duration(agentTime(detail)) || "0s"}</Row>
        <Row label="Your time">
          <span data-testid="your-time">{duration(yourTime(detail, me)) || "0s"}</span>
        </Row>
      </Rows>
      <button type="button" className="w-fit underline" onClick={() => onTab("runs")}>
        See every run
      </button>
    </Panel>
  );
}

/**
 * The workflow the item follows: its project's, pinned when its pipeline started (ADR 0492). There
 * is no per-item override, so it is shown, not chosen; the project's workflow is set in Settings.
 */
function WorkflowLine({ detail }: { detail: WorkItemDetail }) {
  const { item } = detail;
  return (
    <span data-testid="work-item-workflow">
      {item.workflow ?? "The skeleton alone"}
      {item.workflowReason && (
        <span className="mt-0.5 block text-ink-3 text-xs">{item.workflowReason}</span>
      )}
    </span>
  );
}

function Runs({ detail }: { detail: WorkItemDetail }) {
  const runners = useQuery(runnersQuery());
  if (detail.runs.length === 0) {
    return <Panel className="text-ink-muted">No runs yet.</Panel>;
  }
  return (
    <div className="overflow-hidden rounded-[10px] bg-panel shadow-panel">
      <table className="w-full" data-testid="runs">
        <thead>
          <tr className="text-left text-ink-muted text-xs">
            <th className="px-3.5 py-2.5 font-medium">Run</th>
            <th className="px-2 py-2.5 font-medium">Stage</th>
            <th className="px-2 py-2.5 font-medium">Runner</th>
            <th className="px-2 py-2.5 font-medium">Time</th>
            <th className="px-3.5 py-2.5 font-medium">Result</th>
          </tr>
        </thead>
        <tbody>
          {[...detail.runs].reverse().map((r) => (
            <tr key={r.id} className="border-line-soft border-t align-top">
              <td className="px-3.5 py-2.5 font-mono text-[12px]">#{r.runNo}</td>
              <td className="px-2 py-2.5">{capitalise(r.stage)}</td>
              <td className="px-2 py-2.5">
                {runners.data?.runners.find((x) => x.id === r.runnerId)?.name ?? r.runnerId}
                <div className="text-ink-muted text-xs">Claude Code</div>
              </td>
              <td className="whitespace-nowrap px-2 py-2.5 font-mono text-[12px]">
                {duration(
                  (r.endedAt ? Date.parse(r.endedAt) : Date.now()) - Date.parse(r.startedAt),
                )}
              </td>
              <td className="px-3.5 py-2.5">
                <span className="inline-flex items-center gap-1.5">
                  <StatusDot
                    status={
                      r.endedAt
                        ? r.outcome === "succeeded" || r.outcome === "ok"
                          ? "done"
                          : "failed"
                        : "running"
                    }
                  />
                  {r.endedAt ? capitalise(r.outcome ?? r.status) : "Running"}
                </span>
                {r.summary && <div className="mt-0.5 text-ink-3 text-xs">{r.summary}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Activity({ detail }: { detail: WorkItemDetail }) {
  const timeline = useQuery(timelineQuery(detail.item.id));
  const me = useSession().user.id;
  return (
    <Panel className="px-4 py-3.5">
      {timeline.data ? (
        <Timeline entries={timeline.data.entries} gates={detail.gates} me={me} />
      ) : (
        <Skeleton className="h-24 w-full" />
      )}
    </Panel>
  );
}
