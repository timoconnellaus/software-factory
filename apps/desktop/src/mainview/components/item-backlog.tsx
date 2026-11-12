// A work item before release (spec 50, design ItemBacklog): what to do next with it (mark ready,
// release, back to the backlog, take a release back), its details with what it waits for, and the
// edit dialog (`workItem.update`, `workItem.link`, `workItem.unlink`). Once shaping has started only
// the priority can change (ADR 0493), and the dialog says so.
import { ago, capitalise } from "@software-factory/client/format";
import type { WorkItemDetail } from "@software-factory/client/ops";
import { Button } from "@software-factory/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@software-factory/ui/components/dialog";
import { Input } from "@software-factory/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@software-factory/ui/components/select";
import { StatusDot } from "@software-factory/ui/components/status-dot";
import { Textarea } from "@software-factory/ui/components/textarea";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { XIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
  PRIORITIES,
  PRIORITY_LABEL,
  type Priority,
  releaseBlocker,
  waitsText,
} from "../lib/backlog.ts";
import { OpError, op } from "../lib/op.ts";
import { openItem } from "../lib/places.ts";
import { boardsQuery } from "../lib/queries.ts";
import { useProjects, useSession } from "../lib/session.ts";
import { Field, Panel } from "./shell-list.tsx";

/** Statuses before the pipeline starts (spec 50): no runs, no stages, the item is still yours. */
export const PRE_RELEASE = ["backlog", "shaping", "ready", "queued"] as const;
export const isPreRelease = (status: string) => (PRE_RELEASE as readonly string[]).includes(status);

const SIZES = ["small", "medium", "large"] as const;

function useRefresh(id: string) {
  const client = useQueryClient();
  return () =>
    Promise.all([
      client.invalidateQueries({ queryKey: ["workItem", id] }),
      client.invalidateQueries({ queryKey: ["work"] }),
    ]);
}

const refused = (e: unknown, fallback: string) =>
  toast.error(e instanceof OpError ? e.message : fallback);

/** The next step for an item before release: the design's "Next step" card. */
export function NextStep({ detail }: { detail: WorkItemDetail }) {
  const { item } = detail;
  const projects = useProjects();
  const refresh = useRefresh(item.id);
  const [busy, setBusy] = useState(false);
  const project = projects.data?.find((p) => p.id === item.projectId);
  const blocker = releaseBlocker(
    { status: item.status, repositoryId: item.repositoryId ?? null },
    project,
  );
  const blocked = (detail.waitsFor ?? []).filter((w) => w.status !== "done");
  const waits = waitsText(blocked);

  async function run(f: () => Promise<unknown>, fallback: string) {
    setBusy(true);
    try {
      await f();
    } catch (e) {
      refused(e, fallback);
    } finally {
      setBusy(false);
      await refresh();
    }
  }
  const move = (to: "backlog" | "ready", done: string) =>
    run(async () => {
      await op("workItem.move", { workItemId: item.id, to });
      toast.success(done);
    }, "Couldn't move it");
  const release = () =>
    run(async () => {
      const r = await op("workItem.release", { workItemId: item.id });
      const w = waitsText(r.blockedBy);
      toast.success(w ? `Released: it waits in Queued for ${w}` : "Released to the factory");
      if (r.plan?.behindBy) {
        toast(`Its plan was written ${r.plan.behindBy} commits ago on the default branch`);
      }
    }, "Couldn't release it");

  return (
    <Panel className="gap-2.5" data-testid="next-step">
      <h2 className="m-0 font-semibold text-[13px]">Next step</h2>
      {item.status === "backlog" && (
        <>
          <Button
            className="w-full"
            disabled={busy}
            onClick={() => move("ready", "Marked ready")}
            data-testid="mark-ready"
          >
            Mark ready
          </Button>
          <Button
            variant="outline"
            className="w-full"
            disabled={busy || !!blocker}
            onClick={release}
            data-testid="release"
          >
            Release to the factory
          </Button>
        </>
      )}
      {item.status === "ready" && (
        <>
          <Button
            className="w-full"
            disabled={busy || !!blocker}
            onClick={release}
            data-testid="release"
          >
            Release to the factory
          </Button>
          {!detail.shaping && (
            <Button
              variant="outline"
              className="w-full"
              disabled={busy}
              onClick={() => move("backlog", "Back in the backlog")}
            >
              Back to the backlog
            </Button>
          )}
        </>
      )}
      {item.status === "queued" && (
        <>
          <p className="m-0 text-ink-2 leading-normal">
            Released. The factory starts it when the project has a free slot
            {waits ? ` and ${waits} ${blocked.length === 1 ? "is" : "are"} done` : ""}.
          </p>
          <Button
            variant="outline"
            className="w-full"
            disabled={busy}
            onClick={() => move("ready", "Taken back to ready")}
            data-testid="unrelease"
          >
            Take it back to ready
          </Button>
        </>
      )}
      {item.status === "shaping" && (
        <p className="m-0 text-ink-2 leading-normal">
          Being shaped: triage and, when its size needs one, a plan with you. It comes to Ready when
          shaping is done.
        </p>
      )}
      {blocker && (
        <p
          className="m-0 flex items-start gap-1.5 text-ink-3 text-xs"
          data-testid="release-blocker"
        >
          <StatusDot status="waiting" className="mt-1" />
          {blocker}.
        </p>
      )}
      {!blocker && waits && item.status !== "queued" && (
        <p className="m-0 text-ink-3 text-xs" data-testid="waits-note">
          It waits for {waits}. You can release it now: it stays in Queued until{" "}
          {blocked.length === 1 ? "that is" : "those are"} done.
        </p>
      )}
    </Panel>
  );
}

function LinkList({ links }: { links: NonNullable<WorkItemDetail["waitsFor"]> }) {
  if (links.length === 0) return <span className="text-ink-3">nothing</span>;
  return (
    <span className="flex flex-col gap-0.5">
      {links.map((w) => (
        <Link key={w.id} {...openItem(w.id)} className="hover:underline">
          <span className="font-mono text-[12px] text-ink-muted">#{w.number}</span> {w.title}
          {w.status === "done" ? (
            <span className="text-ink-muted"> · done</span>
          ) : (
            <span className="text-ink-muted"> · {w.status}</span>
          )}
        </Link>
      ))}
    </span>
  );
}

/** The details column for an item before release. */
export function BacklogDetails({ detail }: { detail: WorkItemDetail }) {
  const me = useSession().user.id;
  const projects = useProjects();
  const [editing, setEditing] = useState(false);
  const { item } = detail;
  const project = projects.data?.find((p) => p.id === item.projectId);
  const repository = project?.repositories.find((r) => r.id === item.repositoryId);
  const priority = (item.priority ?? "normal") as Priority;
  return (
    <Panel className="gap-2.5" data-testid="details">
      <h2 className="m-0 font-semibold text-[13px]">Details</h2>
      <dl className="m-0 grid grid-cols-[96px_minmax(0,1fr)] gap-x-3 gap-y-2">
        <dt className="text-ink-3">Project</dt>
        <dd className="m-0">{project?.name ?? "project"}</dd>
        <dt className="text-ink-3">Priority</dt>
        <dd className="m-0" title={PRIORITY_LABEL[priority]}>
          {PRIORITY_LABEL[priority]}
        </dd>
        <dt className="text-ink-3">Size</dt>
        <dd className="m-0">{item.size ? capitalise(item.size) : "Not sized yet"}</dd>
        <dt className="text-ink-3">Repository</dt>
        <dd
          className="m-0 truncate font-mono text-[12px]"
          title={repository ? `${repository.owner}/${repository.name}` : undefined}
        >
          {repository ? `${repository.owner}/${repository.name}` : "none"}
        </dd>
        <dt className="text-ink-3">From</dt>
        <dd className="m-0">
          {item.requesterUserId === me ? "You" : "Someone else"}, in {item.source}
        </dd>
        <dt className="text-ink-3">Waits for</dt>
        <dd className="m-0" data-testid="waits-for">
          <LinkList links={detail.waitsFor ?? []} />
        </dd>
        {(detail.waitedOnBy ?? []).length > 0 && (
          <>
            <dt className="text-ink-3">Waited on by</dt>
            <dd className="m-0">
              <LinkList links={detail.waitedOnBy ?? []} />
            </dd>
          </>
        )}
        <dt className="text-ink-3">Added</dt>
        <dd className="m-0">{ago(item.createdAt)}</dd>
        {item.releasedAt && (
          <>
            <dt className="text-ink-3">Released</dt>
            <dd className="m-0">{ago(item.releasedAt)}</dd>
          </>
        )}
      </dl>
      <Button
        variant="outline"
        size="md"
        className="w-fit"
        onClick={() => setEditing(true)}
        data-testid="edit-item"
      >
        Edit
      </Button>
      {editing && <EditItem detail={detail} onClose={() => setEditing(false)} />}
    </Panel>
  );
}

/** Edit an item before its pipeline starts: the fields `workItem.update` takes, and its links. */
function EditItem({ detail, onClose }: { detail: WorkItemDetail; onClose: () => void }) {
  const { item } = detail;
  const session = useSession();
  const projects = useProjects();
  const board = useQuery(boardsQuery(session.orgs.map((o) => o.id)));
  const refresh = useRefresh(item.id);
  const shaped = !!detail.shaping;
  const project = projects.data?.find((p) => p.id === item.projectId);
  const repoChangeable = !shaped && (item.status === "backlog" || item.status === "ready");
  const [title, setTitle] = useState(item.title);
  const [body, setBody] = useState(item.body);
  const [priority, setPriority] = useState<Priority>((item.priority ?? "normal") as Priority);
  const [size, setSize] = useState<string>(item.size ?? "none");
  const [repositoryId, setRepositoryId] = useState<string>(item.repositoryId ?? "none");
  const [waitsFor, setWaitsFor] = useState<string[]>((detail.waitsFor ?? []).map((w) => w.id));
  const [busy, setBusy] = useState(false);
  // What it may wait for: work in the same org that isn't finished (the board's items).
  const candidates = (board.data?.items ?? []).filter(
    (i) => i.orgId === item.orgId && i.id !== item.id && !waitsFor.includes(i.id),
  );
  const known = new Map(
    [...(detail.waitsFor ?? []), ...(board.data?.items ?? [])].map((i) => [i.id, i]),
  );

  async function save() {
    setBusy(true);
    try {
      const changes = shaped
        ? { ...(priority !== item.priority ? { priority } : {}) }
        : {
            ...(title.trim() !== item.title ? { title: title.trim() } : {}),
            ...(body !== item.body ? { body } : {}),
            ...(priority !== item.priority ? { priority } : {}),
            ...(size !== (item.size ?? "none")
              ? { size: size === "none" ? null : (size as (typeof SIZES)[number]) }
              : {}),
            ...(repoChangeable && repositoryId !== (item.repositoryId ?? "none")
              ? { repositoryId: repositoryId === "none" ? null : repositoryId }
              : {}),
          };
      if (Object.keys(changes).length) {
        await op("workItem.update", { workItemId: item.id, ...changes });
      }
      const before = (detail.waitsFor ?? []).map((w) => w.id);
      for (const id of before.filter((x) => !waitsFor.includes(x))) {
        await op("workItem.unlink", { workItemId: item.id, waitsFor: id });
      }
      for (const id of waitsFor.filter((x) => !before.includes(x))) {
        await op("workItem.link", { workItemId: item.id, waitsFor: id });
      }
      toast.success("Saved");
      onClose();
    } catch (e) {
      refused(e, "Couldn't save it");
    } finally {
      setBusy(false);
      await refresh();
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-[560px]" data-testid="edit-dialog">
        <DialogHeader>
          <DialogTitle>Edit #{item.number}</DialogTitle>
          <DialogDescription>
            {shaped
              ? "It has been shaped, so its plan is fixed: only the priority can change. Cancel it and capture it again to change the rest."
              : "Nothing runs until it is released, so all of this can still change."}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Field htmlFor="edit-title" label="Title">
            <Input
              id="edit-title"
              value={title}
              disabled={shaped}
              onChange={(e) => setTitle(e.target.value)}
            />
          </Field>
          <Field htmlFor="edit-body" label="What should change, and why">
            <Textarea
              id="edit-body"
              value={body}
              disabled={shaped}
              onChange={(e) => setBody(e.target.value)}
              className="min-h-[96px] resize-y"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field htmlFor="edit-priority" label="Priority">
              <Select value={priority} onValueChange={(v) => setPriority(v as Priority)}>
                <SelectTrigger id="edit-priority" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRIORITIES.map((p) => (
                    <SelectItem key={p} value={p}>
                      {PRIORITY_LABEL[p]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field htmlFor="edit-size" label="Size">
              <Select value={size} onValueChange={setSize} disabled={shaped}>
                <SelectTrigger id="edit-size" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">Not sized</SelectItem>
                  {SIZES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {capitalise(s)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          {project && project.repositories.length > 0 && (
            <Field htmlFor="edit-repo" label="Repository">
              <Select
                value={repositoryId}
                onValueChange={setRepositoryId}
                disabled={!repoChangeable}
              >
                <SelectTrigger id="edit-repo" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None chosen</SelectItem>
                  {project.repositories.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.owner}/{r.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          <Field htmlFor="edit-waits" label="Waits for">
            <div className="flex flex-col gap-1.5">
              {waitsFor.map((id) => {
                const w = known.get(id);
                return (
                  <div key={id} className="flex items-center gap-2" data-testid="waits-row">
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-mono text-[12px] text-ink-muted">#{w?.number}</span>{" "}
                      {w?.title}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon-md"
                      aria-label={`Stop waiting for #${w?.number}`}
                      disabled={shaped}
                      onClick={() => setWaitsFor((l) => l.filter((x) => x !== id))}
                    >
                      <XIcon />
                    </Button>
                  </div>
                );
              })}
              {!shaped && (
                <Select value="" onValueChange={(v) => setWaitsFor((l) => [...l, v])}>
                  <SelectTrigger id="edit-waits" className="w-full">
                    <SelectValue placeholder="Add an item it waits for…" />
                  </SelectTrigger>
                  <SelectContent>
                    {candidates.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        #{c.number} {c.title}
                        <span className="text-ink-muted"> · {c.status}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={busy || (!shaped && !title.trim())}
            onClick={save}
            data-testid="save-edit"
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The work-management states an item passes before its workflow runs (spec 50, fixed). */
export const PRE_STATES = ["backlog", "ready", "queued"] as const;
export const PRE_STATE_LABEL: Record<string, string> = {
  backlog: "Backlog",
  shaping: "Planning",
  ready: "Ready",
  queued: "Queued",
};
