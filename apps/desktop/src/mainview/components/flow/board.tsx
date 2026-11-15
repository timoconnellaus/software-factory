// A project's board and list (.kim/mockups/board-and-item-panel.html): the header with the
// project's name, its Board and List tabs and its workflow, one column per status with its owner,
// and a card per item. Choosing a card opens the item as a panel on the right.
import {
  chipOf,
  type FlowBoard,
  type FlowItem,
  type FlowProject,
  type FlowStatus,
  flowKey,
  type Names,
  ownerOf,
  when,
} from "@software-factory/client/flow";
import { Button } from "@software-factory/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@software-factory/ui/components/dialog";
import { Input } from "@software-factory/ui/components/input";
import { Label } from "@software-factory/ui/components/label";
import { Skeleton } from "@software-factory/ui/components/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@software-factory/ui/components/table";
import { Textarea } from "@software-factory/ui/components/textarea";
import { cn } from "@software-factory/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { PlusIcon, WorkflowIcon } from "lucide-react";
import { useState } from "react";
import {
  flowBoardQuery,
  flowProjectsQuery,
  flowWorkflowQuery,
  useFlowRefresh,
  useNames,
} from "../../lib/flow-queries.ts";
import { OpError, op, submitKey } from "../../lib/op.ts";
import { useSession } from "../../lib/session.ts";
import { ItemPanel } from "./item.tsx";
import { ChipPill, OwnerMark, PageHeader, Pill, StatusMark } from "./parts.tsx";

export type BoardView = "board" | "list";

export function ProjectPage({
  orgId,
  projectId,
  view,
  itemId,
}: {
  orgId: string;
  projectId: string;
  view: BoardView;
  itemId: string | undefined;
}) {
  const navigate = useNavigate();
  const session = useSession();
  const names = useNames(orgId);
  const projects = useQuery(flowProjectsQuery(orgId));
  const project = projects.data?.projects.find((p) => p.id === projectId);
  const board = useQuery(flowBoardQuery(orgId, projectId));
  const workflow = useQuery({
    ...flowWorkflowQuery(orgId, project?.workflowId ?? ""),
    enabled: !!project,
  });
  const [creating, setCreating] = useState(false);
  const items = board.data?.columns.flatMap((c) => c.items) ?? [];
  const me = session.user.id;
  const working = items.filter((i) => chipOf(i, me) === "working").length;
  const needs = items.filter((i) => chipOf(i, me) === "needs-you").length;

  return (
    <main className="flex min-w-0 flex-1 flex-col" data-testid="project-page">
      <PageHeader
        title={project?.name ?? ""}
        tabs={["Board", "List"]}
        tab={view === "list" ? "List" : "Board"}
        onTab={(t) =>
          void navigate({
            to: "/flow/$orgId/p/$projectId",
            params: { orgId, projectId },
            search: (s) => ({ ...s, view: t === "List" ? ("list" as const) : undefined }),
          })
        }
      >
        {workflow.data && (
          <Pill data-testid="workflow-name">
            <WorkflowIcon />
            {workflow.data.workflow.name}
          </Pill>
        )}
        <span className="flex-1" />
        {working > 0 && (
          <Pill className="border-transparent bg-work-soft text-work" data-testid="working-count">
            {working} working
          </Pill>
        )}
        {needs > 0 && (
          <Pill className="border-need-line bg-need-soft text-need" data-testid="needs-count">
            {needs} need{needs === 1 ? "s" : ""} you
          </Pill>
        )}
        <Button
          variant="ghost"
          size="icon-md"
          aria-label="New item"
          title="New item"
          onClick={() => setCreating(true)}
          data-testid="new-item"
        >
          <PlusIcon />
        </Button>
      </PageHeader>
      {board.error ? (
        <p className="p-6 text-bad">Couldn't load the board. {board.error.message}</p>
      ) : !board.data ? (
        <BoardSkeleton />
      ) : items.length === 0 ? (
        <div className="flex items-center gap-3 p-6 text-ink-muted" data-testid="board-empty">
          No items yet.
          <Button size="md" variant="outline" onClick={() => setCreating(true)}>
            <PlusIcon />
            New item
          </Button>
        </div>
      ) : view === "list" ? (
        <ItemList board={board.data} project={project} names={names} me={me} selected={itemId} />
      ) : (
        <Board board={board.data} project={project} names={names} me={me} selected={itemId} />
      )}
      {itemId && <ItemPanel orgId={orgId} itemId={itemId} project={project} />}
      <NewItemDialog
        orgId={orgId}
        projectId={projectId}
        open={creating}
        onOpenChange={setCreating}
      />
    </main>
  );
}

function BoardSkeleton() {
  return (
    <div className="flex flex-1 gap-3 bg-board px-4 py-3.5" aria-busy="true">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="grid w-[236px] flex-none content-start gap-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-20 w-full" />
        </div>
      ))}
    </div>
  );
}

interface ViewProps {
  board: FlowBoard;
  project: FlowProject | undefined;
  names: Names;
  me: string;
  selected: string | undefined;
}

function Board({ board, project, names, me, selected }: ViewProps) {
  const count = board.columns.length;
  return (
    <div
      className="flex min-h-0 flex-1 gap-3 overflow-auto bg-board px-4 py-3.5"
      data-testid="board"
    >
      {board.columns.map((col, index) => (
        <Column
          key={col.status.id}
          status={col.status}
          items={col.items}
          index={index}
          count={count}
          project={project}
          names={names}
          me={me}
          selected={selected}
        />
      ))}
    </div>
  );
}

function Column({
  status,
  items,
  index,
  count,
  project,
  names,
  me,
  selected,
}: {
  status: FlowStatus;
  items: FlowItem[];
  index: number;
  count: number;
  project: FlowProject | undefined;
  names: Names;
  me: string;
  selected: string | undefined;
}) {
  const owner = ownerOf(names, status.owner);
  return (
    <section className="flex w-[236px] flex-none flex-col gap-2" data-testid="board-column">
      <header className="flex items-center gap-[7px] px-0.5 pb-0.5 font-semibold text-[12.5px]">
        <StatusMark index={index} count={count} />
        <span className="truncate">{status.name}</span>
        <span className="font-normal text-ink-faint" data-testid="column-count">
          {items.length}
        </span>
        <span
          className="ml-auto flex items-center gap-[5px] font-normal text-[11.5px] text-ink-muted"
          data-testid="column-owner"
        >
          <OwnerMark name={owner.name} kind={owner.kind} />
          {owner.name}
        </span>
      </header>
      {items.map((item) => (
        <Card
          key={item.id}
          item={item}
          owner={owner}
          project={project}
          me={me}
          selected={item.id === selected}
        />
      ))}
    </section>
  );
}

function Card({
  item,
  owner,
  project,
  me,
  selected,
}: {
  item: FlowItem;
  owner: ReturnType<typeof ownerOf>;
  project: FlowProject | undefined;
  me: string;
  selected: boolean;
}) {
  return (
    <Link
      to="."
      search={(s: Record<string, unknown>) => ({ ...s, item: item.id })}
      className={cn(
        "flex w-full flex-col gap-1.5 rounded-[10px] border border-line bg-panel px-[11px] py-2.5 text-left hover:border-line-strong",
        selected && "border-work shadow-[0_0_0_2px_var(--work-soft)] hover:border-work",
      )}
      aria-current={selected ? "true" : undefined}
      data-testid="board-card"
    >
      <span className="flex items-center gap-1.5 text-[11.5px] text-ink-faint">
        {flowKey(project, item.number)}
        <ChipPill chip={chipOf(item, me)} className="ml-auto h-[18px] px-[7px] text-[10.5px]" />
      </span>
      <span className="font-medium leading-[1.35]">{item.title}</span>
      <span className="flex items-center gap-1.5 text-[11.5px] text-ink-muted">
        <OwnerMark name={owner.name} kind={owner.kind} />
        {owner.name}
        <time className="ml-auto text-ink-faint">{when(item.updatedAt)}</time>
      </span>
    </Link>
  );
}

function ItemList({ board, project, names, me, selected }: ViewProps) {
  const navigate = useNavigate();
  const rows = board.columns.flatMap((c) => c.items.map((item) => ({ item, status: c.status })));
  return (
    <div className="min-h-0 flex-1 overflow-auto bg-board px-4 py-3.5" data-testid="item-list">
      <div className="overflow-hidden rounded-[10px] border border-line bg-panel">
        <Table className="text-[13px]">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-[90px] text-[11.5px] text-ink-faint">Key</TableHead>
              <TableHead className="text-[11.5px] text-ink-faint">Title</TableHead>
              <TableHead className="text-[11.5px] text-ink-faint">Status</TableHead>
              <TableHead className="text-[11.5px] text-ink-faint">Owner</TableHead>
              <TableHead className="w-[100px] text-[11.5px] text-ink-faint" />
              <TableHead className="w-[90px] text-right text-[11.5px] text-ink-faint">
                Updated
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map(({ item, status }) => {
              const owner = ownerOf(names, status.owner);
              return (
                <TableRow
                  key={item.id}
                  className={cn("cursor-default", item.id === selected && "bg-work-soft")}
                  onClick={() =>
                    void navigate({
                      to: ".",
                      search: (s: Record<string, unknown>) => ({ ...s, item: item.id }),
                    })
                  }
                  data-testid="list-row"
                >
                  <TableCell className="text-ink-muted">{flowKey(project, item.number)}</TableCell>
                  <TableCell className="font-medium">{item.title}</TableCell>
                  <TableCell>{status.name}</TableCell>
                  <TableCell className="text-ink-muted">{owner.name}</TableCell>
                  <TableCell>
                    <ChipPill chip={chipOf(item, me)} />
                  </TableCell>
                  <TableCell className="text-right text-ink-faint">
                    {when(item.updatedAt)}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function NewItemDialog({
  orgId,
  projectId,
  open,
  onOpenChange,
}: {
  orgId: string;
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const refresh = useFlowRefresh(orgId);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const item = await op(
        "flow.item.create",
        { orgId, projectId, title: title.trim(), body },
        { idempotencyKey: submitKey() },
      );
      await refresh();
      onOpenChange(false);
      setTitle("");
      setBody("");
      void navigate({
        to: ".",
        search: (s: Record<string, unknown>) => ({ ...s, item: item.id }),
      });
    } catch (err) {
      setError(err instanceof OpError || err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={create} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>New item</DialogTitle>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="item-title">Title</Label>
            <Input
              id="item-title"
              value={title}
              autoFocus
              maxLength={300}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="item-body">Body</Label>
            <Textarea
              id="item-body"
              value={body}
              rows={5}
              onChange={(e) => setBody(e.target.value)}
            />
          </div>
          {error && <p className="text-bad">{error}</p>}
          <DialogFooter>
            <Button type="submit" disabled={saving || !title.trim()} data-testid="create-item">
              Create item
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
