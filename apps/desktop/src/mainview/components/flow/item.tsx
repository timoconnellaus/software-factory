// An item, as a panel over the board and as a full page (.kim/mockups/board-and-item-panel.html,
// item-as-a-full-page.html): its title, properties and body, then one timeline that ends with what
// waits on you, and a comment box. Both read the same three things (the item, its timeline, its
// project's workflow) and send the same writes.
import {
  buildTimeline,
  chipOf,
  type Decision,
  decisionFor,
  type FlowProject,
  type FlowStatus,
  flowKey,
  ownerOf,
  when,
} from "@software-factory/client/flow";
import { Button } from "@software-factory/ui/components/button";
import { Skeleton } from "@software-factory/ui/components/skeleton";
import { Textarea } from "@software-factory/ui/components/textarea";
import { cn } from "@software-factory/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CircleDotIcon,
  Maximize2Icon,
  Minimize2Icon,
  XIcon,
} from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import {
  flowItemQuery,
  flowTimelineQuery,
  flowWorkflowQuery,
  useFlowRefresh,
  useNames,
} from "../../lib/flow-queries.ts";
import { OpError, op, submitKey } from "../../lib/op.ts";
import { useSession } from "../../lib/session.ts";
import { ChipPill, OwnerMark, Pill, StatusMark } from "./parts.tsx";
import { Timeline } from "./timeline.tsx";

/** Everything an item's views show, and the writes they send. */
function useItem(orgId: string, itemId: string, project: FlowProject | undefined) {
  const session = useSession();
  const names = useNames(orgId);
  const item = useQuery(flowItemQuery(orgId, itemId));
  const timeline = useQuery(flowTimelineQuery(orgId, itemId));
  const workflow = useQuery({
    ...flowWorkflowQuery(orgId, project?.workflowId ?? ""),
    enabled: !!project,
  });
  const refresh = useFlowRefresh(orgId);
  const [busy, setBusy] = useState(false);
  const statuses: FlowStatus[] = workflow.data?.workflow.statuses ?? [];
  const data = item.data;
  const me = session.user.id;

  async function send(run: () => Promise<unknown>, failed: string) {
    setBusy(true);
    try {
      await run();
    } catch (error) {
      toast.error(error instanceof OpError || error instanceof Error ? error.message : failed);
    } finally {
      await refresh();
      setBusy(false);
    }
  }

  return {
    item: data,
    loading: item.isPending,
    failed: item.error,
    workflowName: workflow.data?.workflow.name ?? null,
    statuses,
    status: data ? statuses.findIndex((s) => s.id === data.statusId) : -1,
    names,
    rows: timeline.data ? buildTimeline(timeline.data.entries, statuses, names) : [],
    decision: data ? decisionFor(data, statuses, me) : null,
    chip: data ? chipOf(data, me) : null,
    busy,
    act: (a: Decision["actions"][number]) =>
      send(
        () =>
          a.op === "flow.item.finish"
            ? op(
                "flow.item.finish",
                { orgId, itemId, ...(a.input as { outcome: "done" | "rejected" }) },
                { idempotencyKey: submitKey() },
              )
            : op(
                "flow.item.decide",
                { orgId, itemId, ...(a.input as { decision: "approve" | "reject" }) },
                { idempotencyKey: submitKey() },
              ),
        "Couldn't send that",
      ),
    retry: () =>
      send(
        () => op("flow.item.retry", { orgId, itemId }, { idempotencyKey: submitKey() }),
        "Couldn't retry it",
      ),
    comment: (text: string) =>
      send(
        () => op("flow.item.comment", { orgId, itemId, text }, { idempotencyKey: submitKey() }),
        "Couldn't add the comment",
      ),
  };
}

type ItemView = ReturnType<typeof useItem>;

/** The item over the board, on the right. */
export function ItemPanel({
  orgId,
  itemId,
  project,
}: {
  orgId: string;
  itemId: string;
  project: FlowProject | undefined;
}) {
  const view = useItem(orgId, itemId, project);
  const decisionRef = useRef<HTMLDivElement>(null);
  const { item } = view;
  const key = item ? flowKey(project, item.number) : "";

  return (
    <aside
      className="absolute top-2 right-2 bottom-2 z-10 flex w-[452px] max-w-[calc(100%-16px)] flex-col rounded-xl border border-line bg-panel shadow-[0_12px_40px_rgba(20,20,20,0.12)] dark:shadow-[0_12px_40px_rgba(0,0,0,0.5)]"
      data-testid="item-panel"
    >
      <header className="flex items-center gap-2 border-line-soft border-b px-3.5 py-2 text-[12px] text-ink-muted">
        <span className="truncate">
          {project?.name ?? ""} <span className="px-1">›</span> {key}
        </span>
        <span className="flex-1" />
        <ChipPill chip={view.chip === "needs-you" ? null : view.chip} />
        <Button asChild variant="ghost" size="icon-md" title="Open as a page">
          <Link
            to="/flow/$orgId/p/$projectId/i/$itemId"
            params={{ orgId, projectId: project?.id ?? item?.projectId ?? "", itemId }}
            aria-label="Open as a page"
            data-testid="expand-item"
          >
            <Maximize2Icon />
          </Link>
        </Button>
        <Button asChild variant="ghost" size="icon-md" title="Close">
          <Link
            to="."
            search={(s: Record<string, unknown>) => ({ ...s, item: undefined })}
            aria-label="Close"
            data-testid="close-item"
          >
            <XIcon />
          </Link>
        </Button>
      </header>
      {view.decision && (
        <div
          className="flex items-center gap-2 border-need-line border-b bg-need-soft px-3.5 py-[7px] font-medium text-[12px] text-need"
          data-testid="waiting-on-you"
        >
          <CircleDotIcon className="size-4" />
          <span className="truncate">Waiting on you: {view.decision.question}</span>
          <Button
            variant="ghost"
            size="xs"
            className="ml-auto font-semibold text-need hover:bg-need-line/40 hover:text-need"
            onClick={() => {
              const card = decisionRef.current;
              card?.scrollIntoView({ behavior: "smooth", block: "center" });
              card?.animate(
                [{ boxShadow: "0 0 0 4px var(--need-line)" }, { boxShadow: "0 0 0 0 transparent" }],
                { duration: 1200 },
              );
            }}
            data-testid="jump-to-decision"
          >
            Jump to it <ArrowDownIcon />
          </Button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-[18px] pt-4 pb-2">
        <ItemBody view={view} project={project} decisionRef={decisionRef} size="panel" />
      </div>
      {item && <CommentBox onSend={view.comment} busy={view.busy} className="m-3.5 mt-2.5" />}
    </aside>
  );
}

/** The same item as a full page: the timeline in the middle, its properties on the right. */
export function ItemPage({
  orgId,
  itemId,
  project,
}: {
  orgId: string;
  itemId: string;
  project: FlowProject | undefined;
}) {
  const view = useItem(orgId, itemId, project);
  const decisionRef = useRef<HTMLDivElement>(null);
  const { item } = view;
  const owner =
    item && view.status >= 0
      ? ownerOf(view.names, view.statuses[view.status]?.owner ?? { kind: "none" })
      : null;
  return (
    <main className="flex min-w-0 flex-1 flex-col" data-testid="item-page">
      <header className="flex h-12 flex-none items-center gap-3 border-line-soft border-b px-[18px]">
        <span className="text-ink-muted">{project?.name ?? ""} ›</span>
        <b className="font-semibold text-[14px]">{item ? flowKey(project, item.number) : ""}</b>
        <span className="flex-1" />
        {view.decision ? (
          <Pill className="border-need-line bg-need-soft text-need" data-testid="chip-needs-you">
            Waiting on you
          </Pill>
        ) : (
          <ChipPill chip={view.chip} />
        )}
        <Button asChild variant="ghost" size="icon-md" title="Back to the board">
          <Link
            to="/flow/$orgId/p/$projectId"
            params={{ orgId, projectId: project?.id ?? item?.projectId ?? "" }}
            search={{ item: itemId }}
            aria-label="Back to the board"
            data-testid="collapse-item"
          >
            <Minimize2Icon />
          </Link>
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto bg-board px-[22px] py-5">
        <div className="mx-auto flex max-w-[1000px] items-start gap-[18px]">
          <div className="min-w-0 flex-1">
            <ItemBody view={view} project={project} decisionRef={decisionRef} size="page" />
            {item && <CommentBox onSend={view.comment} busy={view.busy} className="mt-3" />}
          </div>
          {item && (
            <aside className="w-[250px] flex-none" data-testid="item-properties">
              <div className="mb-[7px] font-semibold text-[12px] text-ink-muted">Properties</div>
              <dl className="grid grid-cols-[90px_1fr] gap-x-3 gap-y-[7px] text-[12.5px]">
                <dt className="text-ink-muted">Status</dt>
                <dd className="flex items-center gap-1.5">
                  {view.status >= 0 && (
                    <StatusMark index={view.status} count={view.statuses.length} />
                  )}
                  {view.statuses[view.status]?.name ?? item.statusId}
                </dd>
                <dt className="text-ink-muted">Owner</dt>
                <dd>{owner?.name ?? ""}</dd>
                <dt className="text-ink-muted">Project</dt>
                <dd>{project?.name ?? ""}</dd>
                <dt className="text-ink-muted">Workflow</dt>
                <dd>{view.workflowName ?? ""}</dd>
                <dt className="text-ink-muted">Created</dt>
                <dd>{when(item.createdAt)}</dd>
                <dt className="text-ink-muted">Updated</dt>
                <dd>{when(item.updatedAt)}</dd>
              </dl>
            </aside>
          )}
        </div>
      </div>
    </main>
  );
}

function ItemBody({
  view,
  project,
  decisionRef,
  size,
}: {
  view: ItemView;
  project: FlowProject | undefined;
  decisionRef: React.RefObject<HTMLDivElement | null>;
  size: "panel" | "page";
}) {
  const { item } = view;
  if (view.failed)
    return <p className="text-bad">Couldn't load this item. {view.failed.message}</p>;
  if (!item)
    return (
      <div className="grid gap-3" aria-busy="true">
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  const status = view.statuses[view.status];
  const owner = status ? ownerOf(view.names, status.owner) : null;
  return (
    <>
      <h2
        className={cn(
          "mb-[9px] font-semibold tracking-[-0.01em]",
          size === "panel" ? "text-[17px]" : "text-[20px]",
        )}
        data-testid="item-title"
      >
        {item.title}
      </h2>
      {size === "panel" && (
        <div className="mb-3 flex flex-wrap gap-[5px]" data-testid="item-props">
          <Pill className="rounded-[7px] text-ink">
            {view.status >= 0 && <StatusMark index={view.status} count={view.statuses.length} />}
            {status?.name ?? item.statusId}
          </Pill>
          {owner && owner.kind !== "none" && (
            <Pill className="rounded-[7px] text-ink">
              <OwnerMark name={owner.name} kind={owner.kind} />
              {owner.name}
            </Pill>
          )}
          {project && <Pill className="rounded-[7px] text-ink">{project.name}</Pill>}
        </div>
      )}
      {item.body && <p className="mb-3.5 whitespace-pre-wrap text-body-ink">{item.body}</p>}
      <div className={cn(size === "panel" && "border-line-soft border-t pt-3")}>
        <Timeline
          rows={view.rows}
          decision={view.decision}
          error={item.error}
          busy={view.busy}
          onAction={view.act}
          onRetry={view.retry}
          decisionRef={decisionRef}
        />
      </div>
    </>
  );
}

function CommentBox({
  onSend,
  busy,
  className,
}: {
  onSend: (text: string) => Promise<void>;
  busy: boolean;
  className?: string;
}) {
  const [text, setText] = useState("");
  async function send() {
    const t = text.trim();
    if (!t) return;
    await onSend(t);
    setText("");
  }
  return (
    <form
      className={cn(
        "flex items-end gap-2 rounded-[10px] border border-line bg-panel py-1.5 pr-1.5 pl-3",
        className,
      )}
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
      data-testid="comment-box"
    >
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send();
          }
        }}
        placeholder="Leave a comment…"
        rows={1}
        className="min-h-7 resize-none border-0 bg-transparent p-0 py-1 shadow-none focus-visible:ring-0 dark:bg-transparent"
        aria-label="Comment"
      />
      <Button
        type="submit"
        variant="ghost"
        size="icon-md"
        disabled={busy || !text.trim()}
        aria-label="Send"
        className="text-ink-faint"
      >
        <ArrowUpIcon />
      </Button>
    </form>
  );
}
