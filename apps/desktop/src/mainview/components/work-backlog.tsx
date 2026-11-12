// Backlog, Planning and Ready (spec 50, design WorkBacklog/WorkReady): work before it is released.
// The backlog captures (quick add, one line per item) and acts on a selection (mark ready, set
// priority, release, cancel); Ready releases, one item or every releasable one in priority order,
// and says why an item can't go yet; Planning lists what is being shaped. Every change is an
// operation (`workItem.create/move/update/release/cancel`); the lists come from `workItem.board`.
import type { Project } from "@software-factory/client/ops";
import { Button } from "@software-factory/ui/components/button";
import { Checkbox } from "@software-factory/ui/components/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@software-factory/ui/components/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@software-factory/ui/components/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@software-factory/ui/components/select";
import { StatusDot } from "@software-factory/ui/components/status-dot";
import { Textarea } from "@software-factory/ui/components/textarea";
import { cn } from "@software-factory/ui/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
  age,
  type BacklogItem,
  itemsIn,
  PRIORITIES,
  PRIORITY_LABEL,
  PRIORITY_SHORT,
  type Priority,
  quickAddLines,
  releasable,
  releaseBlocker,
  waitsText,
} from "../lib/backlog.ts";
import { OpError, op, submitKey } from "../lib/op.ts";
import { openItem } from "../lib/places.ts";
import { boardsQuery } from "../lib/queries.ts";
import { useProjects, useSession } from "../lib/session.ts";
import { PageArea, PageHeader, Panel } from "./shell-list.tsx";
import { useOrgScope, useScopedInbox } from "./shell-sidebar.tsx";

interface ViewProps {
  projectId: string | null;
  onProject: (id: string | null) => void;
}

/** The board's items and the projects, within the chosen org. */
function useBoard() {
  const session = useSession();
  const orgId = useOrgScope();
  const board = useQuery(boardsQuery(session.orgs.map((o) => o.id)));
  const projects = useProjects();
  const scoped = (projects.data ?? []).filter((p) => orgId === null || p.orgId === orgId);
  const projectOf = (id: string) => projects.data?.find((p) => p.id === id);
  return { orgId, board, projects: scoped, projectOf, loading: board.isPending };
}

/** After a change: the lists, the counts and the items' own pages. */
function useRefresh() {
  const client = useQueryClient();
  return (ids: string[] = []) =>
    Promise.all([
      client.invalidateQueries({ queryKey: ["work"] }),
      ...ids.map((id) => client.invalidateQueries({ queryKey: ["workItem", id] })),
    ]);
}

const message = (e: unknown, fallback: string) => (e instanceof OpError ? e.message : fallback);

/**
 * Runs one operation per item, in order, and reports once: how many went through and the first
 * refusal (each is the server's own words). Returns the ids that went through.
 */
async function eachItem(
  items: BacklogItem[],
  run: (i: BacklogItem) => Promise<unknown>,
  done: (n: number) => string,
): Promise<string[]> {
  const ok: string[] = [];
  let refusal: string | null = null;
  for (const i of items) {
    try {
      await run(i);
      ok.push(i.id);
    } catch (e) {
      refusal ??= `#${i.number}: ${message(e, "couldn't do that")}`;
    }
  }
  if (ok.length) toast.success(done(ok.length));
  if (refusal) toast.error(refusal);
  return ok;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Release, then say what it does: started when there's room, or waiting in Queued for #n. */
async function releaseAll(items: BacklogItem[]) {
  const waiting: string[] = [];
  const ok = await eachItem(
    items,
    async (i) => {
      const r = await op("workItem.release", { workItemId: i.id });
      const w = waitsText(r.blockedBy);
      if (w) waiting.push(`#${i.number} waits for ${w}`);
    },
    (n) => `Released ${plural(n, "item")} to the factory`,
  );
  if (waiting.length) toast(`In Queued until it lands: ${waiting.join("; ")}`);
  return ok;
}

/** The project switcher: all projects in the chosen org, or one. */
export function ProjectSwitcher({
  projects,
  value,
  onChange,
}: {
  projects: Project[];
  value: string | null;
  onChange: (id: string | null) => void;
}) {
  return (
    <Select value={value ?? "all"} onValueChange={(v) => onChange(v === "all" ? null : v)}>
      <SelectTrigger className="h-7! min-w-[150px]" data-testid="project-switcher">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">All projects</SelectItem>
        {projects.map((p) => (
          <SelectItem key={p.id} value={p.id}>
            {p.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function Pri({ priority }: { priority: Priority }) {
  return (
    <span
      className={cn("font-mono text-[12px]", priority === "urgent" && "font-semibold text-ink")}
      title={PRIORITY_LABEL[priority]}
    >
      {PRIORITY_SHORT[priority]}
    </span>
  );
}

function ItemCell({ item }: { item: BacklogItem }) {
  return (
    <td className="py-2.5 pr-3">
      <Link {...openItem(item.id)} className="font-medium hover:underline">
        <span className="mr-1.5 font-mono font-normal text-[12px] text-ink-muted">
          #{item.number}
        </span>
        {item.title}
      </Link>
    </td>
  );
}

/** "#16, #23" with links, or "none". */
function WaitsFor({ item }: { item: BacklogItem }) {
  if (item.waitsFor.length === 0) return <span className="text-ink-muted">none</span>;
  return (
    <span className="flex flex-wrap gap-x-1.5">
      {item.waitsFor.map((w) => (
        <Link
          key={w.id}
          {...openItem(w.id)}
          title={`${w.title} (${w.status})`}
          className={cn(
            "font-mono text-[12px] hover:underline",
            w.status === "done" && "line-through",
          )}
        >
          #{w.number}
        </Link>
      ))}
    </span>
  );
}

/** Columns a narrow window drops (the item, what it waits for and the action stay). */
const NARROW_HIDDEN = "@max-[620px]:hidden";

const th = "whitespace-nowrap px-0 py-2.5 pr-3 text-left font-medium text-ink-muted text-xs";

function Table({ children, testId }: { children: React.ReactNode; testId: string }) {
  return (
    <div className="@container overflow-x-auto rounded-[10px] bg-panel shadow-panel">
      <table className="w-full" data-testid={testId}>
        {children}
      </table>
    </div>
  );
}

function Empty({ children, testId }: { children: React.ReactNode; testId: string }) {
  return (
    <Panel className="items-start gap-1.5 px-4 py-5 text-ink-3" data-testid={testId}>
      {children}
    </Panel>
  );
}

// —— Backlog ——————————————————————————————————————————————————————————————————————————————

export function BacklogPage({ projectId, onProject }: ViewProps) {
  const { orgId, board, projects, projectOf, loading } = useBoard();
  const refresh = useRefresh();
  const items = itemsIn(board.data?.items ?? [], ["backlog"], { orgId, projectId });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmCancel, setConfirmCancel] = useState(false);
  const chosen = items.filter((i) => selected.has(i.id));
  const allChosen = items.length > 0 && chosen.length === items.length;
  const toggle = (id: string, on: boolean) =>
    setSelected((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const after = async (ids: string[]) => {
    setSelected((s) => new Set([...s].filter((id) => !ids.includes(id))));
    await refresh(ids);
  };

  return (
    <PageArea wide>
      <PageHeader
        title="Backlog"
        testId="work-title"
        sub="Captured, not committed. Nothing here runs until you release it."
        actions={
          <Button asChild size="md">
            <Link to="/new" search={projectId ? { project: projectId } : {}}>
              New work item
            </Link>
          </Button>
        }
      />
      <QuickAdd projects={projects} projectId={projectId} />
      <div className="flex flex-wrap items-center gap-2">
        <ProjectSwitcher projects={projects} value={projectId} onChange={onProject} />
        <span className="flex-1" />
        <span className="text-ink-muted text-xs" data-testid="work-count">
          {plural(items.length, "item")} · in the order the factory takes them
        </span>
      </div>
      {items.length === 0 ? (
        <Empty testId="work-empty">
          {loading ? (
            "Loading…"
          ) : (
            <>
              <span className="font-medium text-ink">The backlog is empty.</span>
              <span>
                Add a line above, or{" "}
                <Link to="/new" className="text-ink underline">
                  write a new work item
                </Link>
                . Nothing in the backlog runs until you release it.
              </span>
            </>
          )}
        </Empty>
      ) : (
        <>
          <Table testId="backlog-list">
            <thead>
              <tr className="border-line-soft border-b">
                <th className="w-10 py-2.5 pl-3.5 align-middle">
                  <Checkbox
                    className="flex"
                    aria-label="Select every item"
                    checked={allChosen ? true : chosen.length > 0 ? "indeterminate" : false}
                    onCheckedChange={(on) =>
                      setSelected(on === true ? new Set(items.map((i) => i.id)) : new Set())
                    }
                  />
                </th>
                <th className={cn(th, "w-12")}>Pri</th>
                <th className={th}>Item</th>
                {!projectId && <th className={cn(th, NARROW_HIDDEN)}>Project</th>}
                <th className={cn(th, NARROW_HIDDEN)}>Size</th>
                <th className={th}>Waits for</th>
                <th className={cn(th, "pr-3.5 text-right")}>Age</th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr
                  key={i.id}
                  className="border-line-soft border-t first:border-t-0 hover:bg-page"
                  data-testid={`row-${i.id}`}
                >
                  <td className="py-2.5 pl-3.5 align-middle">
                    <Checkbox
                      className="flex"
                      aria-label={`Select #${i.number}`}
                      checked={selected.has(i.id)}
                      onCheckedChange={(on) => toggle(i.id, on === true)}
                    />
                  </td>
                  <td className="py-2.5 pr-3">
                    <Pri priority={i.priority} />
                  </td>
                  <ItemCell item={i} />
                  {!projectId && (
                    <td className={cn("whitespace-nowrap py-2.5 pr-3 text-ink-3", NARROW_HIDDEN)}>
                      {projectOf(i.projectId)?.name ?? "project"}
                    </td>
                  )}
                  <td className={cn("whitespace-nowrap py-2.5 pr-3 text-ink-3", NARROW_HIDDEN)}>
                    {i.size ? i.size[0]?.toUpperCase() + i.size.slice(1) : "Not sized"}
                  </td>
                  <td className="py-2.5 pr-3">
                    <WaitsFor item={i} />
                  </td>
                  <td className="whitespace-nowrap py-2.5 pr-3.5 text-right text-ink-muted text-xs">
                    {age(i.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </Table>
          <Panel
            className="flex-row flex-wrap items-center gap-2 px-3.5 py-2.5"
            data-testid="selection-actions"
          >
            <span className="mr-1 text-ink-3">
              {chosen.length ? `${plural(chosen.length, "item")} selected` : "With selected items"}
            </span>
            <Button
              variant="outline"
              size="md"
              disabled={!chosen.length}
              onClick={async () =>
                after(
                  await eachItem(
                    chosen,
                    (i) => op("workItem.move", { workItemId: i.id, to: "ready" }),
                    (n) => `Marked ${plural(n, "item")} ready`,
                  ),
                )
              }
            >
              Mark ready
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild disabled={!chosen.length}>
                <Button variant="outline" size="md">
                  Set priority
                  <ChevronDownIcon />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {PRIORITIES.map((p) => (
                  <DropdownMenuItem
                    key={p}
                    onSelect={async () =>
                      after(
                        await eachItem(
                          chosen,
                          (i) => op("workItem.update", { workItemId: i.id, priority: p }),
                          (n) => `${PRIORITY_SHORT[p]} for ${plural(n, "item")}`,
                        ),
                      )
                    }
                  >
                    {PRIORITY_LABEL[p]}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="outline"
              size="md"
              disabled={!chosen.length}
              onClick={async () => after(await releaseAll(chosen))}
              data-testid="release-selected"
            >
              Release
            </Button>
            <Button
              variant="outline"
              size="md"
              className="text-destructive hover:text-destructive"
              disabled={!chosen.length}
              onClick={() => setConfirmCancel(true)}
            >
              Cancel
            </Button>
          </Panel>
        </>
      )}
      <CancelItems
        open={confirmCancel}
        onOpenChange={setConfirmCancel}
        items={chosen}
        onDone={after}
      />
    </PageArea>
  );
}

/** Quick add: one line per item, straight to the backlog of the switcher's project. */
function QuickAdd({ projects, projectId }: { projects: Project[]; projectId: string | null }) {
  const refresh = useRefresh();
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const target = projectId ?? picked ?? projects[0]?.id ?? null;
  const lines = quickAddLines(text);

  async function add() {
    if (!target || lines.length === 0 || busy) return;
    setBusy(true);
    let added = 0;
    try {
      for (const title of lines) {
        await op(
          "workItem.create",
          { projectId: target, title, source: "app", state: "backlog" },
          { idempotencyKey: submitKey() },
        );
        added++;
      }
      setText("");
    } catch (e) {
      // Keep the lines not added yet, so nothing typed is lost.
      setText(lines.slice(added).join("\n"));
      toast.error(message(e, "Couldn't add it"));
    } finally {
      if (added) toast.success(`Added ${plural(added, "item")} to the backlog`);
      setBusy(false);
      await refresh();
    }
  }

  if (projects.length === 0) return null;
  return (
    <div className="flex flex-col gap-[5px]">
      <label htmlFor="quick-add" className="font-medium text-ink-3 text-xs">
        Quick add: one line per item, saved straight to the backlog
      </label>
      <div className="flex items-start gap-2">
        <Textarea
          id="quick-add"
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void add();
            }
          }}
          placeholder="One item per line"
          className="field-sizing-content max-h-40 min-h-8 flex-1 resize-none py-1.5"
          data-testid="quick-add"
        />
        {!projectId && projects.length > 1 && (
          <Select value={target ?? ""} onValueChange={setPicked}>
            <SelectTrigger className="h-8! min-w-[140px]" aria-label="Project for quick add">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {projects.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <Button
          variant="outline"
          className="h-8!"
          disabled={!target || lines.length === 0 || busy}
          onClick={add}
          data-testid="quick-add-button"
        >
          {lines.length > 1 ? `Add ${lines.length}` : "Add"}
        </Button>
      </div>
    </div>
  );
}

/** Cancelling backlog work: it stops (and shows under Stopped); nothing ran, so nothing to undo. */
function CancelItems({
  open,
  onOpenChange,
  items,
  onDone,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  items: BacklogItem[];
  onDone: (ids: string[]) => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cancel {plural(items.length, "item")}?</DialogTitle>
          <DialogDescription>
            {items.map((i) => `#${i.number}`).join(", ")} leave the backlog and show under Done, as
            cancelled. This can't be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Keep them
          </Button>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const ok = await eachItem(
                items,
                (i) =>
                  op("workItem.cancel", { workItemId: i.id, reason: "cancelled from the backlog" }),
                (n) => `Cancelled ${plural(n, "item")}`,
              );
              setBusy(false);
              onOpenChange(false);
              await onDone(ok);
            }}
          >
            Cancel {plural(items.length, "item")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// —— Ready ————————————————————————————————————————————————————————————————————————————————

export function ReadyPage({ projectId, onProject }: ViewProps) {
  const { orgId, board, projects, projectOf, loading } = useBoard();
  const { inbox } = useScopedInbox();
  const refresh = useRefresh();
  const [busy, setBusy] = useState<string | null>(null);
  const items = itemsIn(board.data?.items ?? [], ["ready"], { orgId, projectId });
  const free = releasable(items, projectOf);
  // Builds held while too many items wait at gates (ADR 0040): released work waits in Queued.
  const holds = (inbox?.wipHolds ?? []).filter(
    (h) => projects.some((p) => p.id === h.projectId) && (!projectId || h.projectId === projectId),
  );

  async function release(list: BacklogItem[], key: string) {
    setBusy(key);
    const ok = await releaseAll(list);
    setBusy(null);
    await refresh(ok);
  }

  return (
    <PageArea wide>
      <PageHeader
        title="Ready"
        testId="work-title"
        sub="Shaped and waiting for you. Releasing an item hands it to the factory, which starts it when the project has room."
        actions={
          <Button
            variant="outline"
            size="md"
            disabled={free.length === 0 || busy !== null}
            onClick={() => release(free, "all")}
            data-testid="release-all"
          >
            Release in priority order
          </Button>
        }
      />
      {holds.map((h) => (
        <Panel
          key={h.projectId}
          className="flex-row flex-wrap items-center gap-x-2.5 gap-y-1 px-3.5 py-2.5"
          data-testid="wip-hold"
        >
          <StatusDot status="waiting" />
          <span className="font-medium">
            Builds are held on {projectOf(h.projectId)?.name ?? "this project"}
          </span>
          <span className="text-ink-3 text-xs">
            {plural(h.waitingBuilds, "build")} wait while decisions wait on people. Released items
            sit in Queued until one is made.
          </span>
          <Link to="/" className="text-xs underline">
            Open the inbox
          </Link>
        </Panel>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <ProjectSwitcher projects={projects} value={projectId} onChange={onProject} />
        <span className="flex-1" />
        <span className="text-ink-muted text-xs" data-testid="work-count">
          {plural(items.length, "item")} · in the order the factory takes them
        </span>
      </div>
      {items.length === 0 ? (
        <Empty testId="work-empty">
          {loading ? (
            "Loading…"
          ) : (
            <>
              <span className="font-medium text-ink">Nothing is ready.</span>
              <span>
                Mark items ready in the{" "}
                <Link to="/work" search={{ view: "backlog" }} className="text-ink underline">
                  backlog
                </Link>{" "}
                once they're clear enough to build.
              </span>
            </>
          )}
        </Empty>
      ) : (
        <>
          <Table testId="ready-list">
            <thead>
              <tr className="border-line-soft border-b">
                <th className={cn(th, "w-12 pl-3.5")}>Pri</th>
                <th className={th}>Item</th>
                {!projectId && <th className={cn(th, NARROW_HIDDEN)}>Project</th>}
                <th className={cn(th, NARROW_HIDDEN)}>Size</th>
                <th className={th}>Waits for</th>
                <th className={cn(th, "pr-3.5 text-right")}>
                  <span className="sr-only">Release</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((i) => {
                const blocker = releaseBlocker(i, projectOf(i.projectId));
                const waits = waitsText(i.blockedBy);
                return (
                  <tr
                    key={i.id}
                    className="border-line-soft border-t align-middle first:border-t-0 hover:bg-page"
                    data-testid={`row-${i.id}`}
                  >
                    <td className="py-2.5 pr-3 pl-3.5">
                      <Pri priority={i.priority} />
                    </td>
                    <ItemCell item={i} />
                    {!projectId && (
                      <td className={cn("whitespace-nowrap py-2.5 pr-3 text-ink-3", NARROW_HIDDEN)}>
                        {projectOf(i.projectId)?.name ?? "project"}
                      </td>
                    )}
                    <td className={cn("whitespace-nowrap py-2.5 pr-3 text-ink-3", NARROW_HIDDEN)}>
                      {i.size ? i.size[0]?.toUpperCase() + i.size.slice(1) : "Not sized"}
                    </td>
                    <td className="py-2.5 pr-3">
                      <WaitsFor item={i} />
                    </td>
                    <td className="py-2 pr-3.5 text-right">
                      {blocker ? (
                        <span
                          className="inline-flex max-w-[220px] items-start gap-1.5 text-left text-ink-3 text-xs"
                          data-testid="release-blocker"
                        >
                          <StatusDot status="waiting" className="mt-1" />
                          {blocker}
                        </span>
                      ) : (
                        <Button
                          size="md"
                          variant={waits ? "outline" : "default"}
                          disabled={busy !== null}
                          title={
                            waits
                              ? `It waits in Queued until ${waits} ${i.blockedBy.length === 1 ? "is" : "are"} done`
                              : "Hand it to the factory"
                          }
                          onClick={() => release([i], i.id)}
                          data-testid={`release-${i.id}`}
                        >
                          Release
                        </Button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
          <p className="m-0 text-ink-3 text-xs">
            An item that waits for another one can be released now. It stays in Queued until the
            other is done.
          </p>
        </>
      )}
    </PageArea>
  );
}

// —— Planning ——————————————————————————————————————————————————————————————————————————————

/** Items being shaped (spec 50 part C): their workflow's shaping stages run before release. */
export function PlanningPage({ projectId, onProject }: ViewProps) {
  const { orgId, board, projects, projectOf, loading } = useBoard();
  const items = itemsIn(board.data?.items ?? [], ["shaping"], { orgId, projectId });
  return (
    <PageArea wide>
      <PageHeader
        title="Planning"
        testId="work-title"
        sub="Being shaped before release: triage and, when the size needs one, a plan with you. They come to Ready when shaping is done."
      />
      <div className="flex flex-wrap items-center gap-2">
        <ProjectSwitcher projects={projects} value={projectId} onChange={onProject} />
      </div>
      {items.length === 0 ? (
        <Empty testId="work-empty">{loading ? "Loading…" : "Nothing is being shaped."}</Empty>
      ) : (
        <Table testId="planning-list">
          <tbody>
            {items.map((i) => (
              <tr key={i.id} className="border-line-soft border-t first:border-t-0 hover:bg-page">
                <td className="w-12 py-2.5 pr-3 pl-3.5">
                  <Pri priority={i.priority} />
                </td>
                <ItemCell item={i} />
                {!projectId && (
                  <td className="whitespace-nowrap py-2.5 pr-3 text-ink-3">
                    {projectOf(i.projectId)?.name ?? "project"}
                  </td>
                )}
                <td className="py-2.5 pr-3.5 text-ink-3">{i.statusReason ?? i.stage}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </PageArea>
  );
}
