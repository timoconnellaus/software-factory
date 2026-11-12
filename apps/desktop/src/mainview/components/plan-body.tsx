// The plan in the Planning tab (spec 27, ADR 0471, second review of #85): rendered block by block
// from `planBlocks`, the server's own segmentation, with Edit and Comment on each block and the
// list of people's edits the planner keeps, each of which a person can release.
import { ago, errorMessage } from "@software-factory/client/format";
import {
  dedent,
  isChanged,
  markTags,
  type PlanningQuestion,
  type PlanningView,
  planBlocks,
} from "@software-factory/client/planning";
import { Button } from "@software-factory/ui/components/button";
import { Kbd } from "@software-factory/ui/components/kbd";
import { Textarea } from "@software-factory/ui/components/textarea";
import { cn } from "@software-factory/ui/lib/utils";
import { MessageSquareIcon, MessageSquarePlusIcon, PencilIcon } from "lucide-react";
import { type CSSProperties, type ReactNode, useMemo, useState } from "react";
import Markdown, { type Components } from "react-markdown";
import { toast } from "sonner";
import { op, submitKey } from "../lib/op.ts";
import { commentsOn, editOf } from "../lib/plan-blocks.ts";

/** Lines of the plan a comment is about (spec 27). */
export type Anchor = { specId: string; lineStart: number; lineEnd: number; quote: string };

/** Lets the planner reword a person's edit: it stops standing (spec 27, ADR 0471). */
export async function releaseEdit(workItemId: string, editId: string) {
  try {
    await op("spec.releaseEdit", { workItemId, editId }, { idempotencyKey: submitKey() });
  } catch (error) {
    toast.error(errorMessage(error));
  }
}

/**
 * One block of the plan, with Edit and Comment (spec 27, design PlanFocus): Edit opens its source
 * lines in place and saves them as the person's edit; Comment starts a chat message anchored to
 * them. An edited block says who edited it and that the planner keeps their wording.
 */
function PlanBlock({
  Tag,
  className,
  style,
  data,
  raw,
  anchor,
  workItemId,
  edit,
  settled,
  comments,
  me,
  onComment,
  children,
}: {
  Tag: "li" | "div";
  className: string;
  style?: CSSProperties;
  data: Record<string, string | undefined>;
  raw: string;
  anchor: Anchor;
  workItemId: string;
  edit: PlanningView["edits"][number] | undefined;
  settled: PlanningQuestion[];
  comments: number;
  me: string | null;
  onComment: (anchor: Anchor) => void;
  children: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(raw);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      await op(
        "spec.edit",
        {
          workItemId,
          specId: anchor.specId,
          lineStart: anchor.lineStart,
          lineEnd: anchor.lineEnd,
          before: raw,
          after: value,
        },
        { idempotencyKey: submitKey() },
      );
      setEditing(false);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };
  const updated = edit ? settled.filter((q) => q.answeredViaEdit === edit.id) : [];
  return (
    <Tag
      className={cn(
        "group/block relative",
        className,
        edit && "-ml-2 rounded-md bg-status-running/8 pl-2 ring-1 ring-status-running/30",
      )}
      style={style}
      {...data}
      data-edited={edit ? "true" : undefined}
    >
      {editing ? (
        <span className="grid gap-1.5 py-1" data-testid="plan-block-editor">
          <Textarea
            rows={Math.max(1, value.split("\n").length)}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && e.metaKey) void save();
              if (e.key === "Escape") setEditing(false);
            }}
            aria-label="Edit this part of the plan"
            className="font-mono text-[12.5px]"
            autoFocus
          />
          <span className="flex items-center gap-1.5 text-[11px] text-ink-muted">
            The planner keeps your wording and updates the answers to match.
            <span className="grow" />
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button size="sm" disabled={saving || value === raw} onClick={save}>
              Save <Kbd className="bg-transparent text-primary-foreground/70">⌘↵</Kbd>
            </Button>
          </span>
        </span>
      ) : (
        children
      )}
      {!editing && (
        <span className="absolute top-0 -right-1 hidden translate-x-full gap-0.5 pl-1 group-hover/block:flex">
          <Button
            variant="ghost"
            size="icon-xs"
            title="Edit this block"
            aria-label="Edit this block"
            className="text-ink-3"
            onClick={() => {
              setValue(raw);
              setEditing(true);
            }}
            data-testid="plan-block-edit"
          >
            <PencilIcon className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            title="Comment on this block"
            aria-label="Comment on this block"
            className="text-ink-3"
            onClick={() => onComment(anchor)}
            data-testid="plan-block-comment"
          >
            <MessageSquarePlusIcon className="size-3.5" />
          </Button>
        </span>
      )}
      {comments > 0 && !editing && (
        <Button
          variant="ghost"
          size="xs"
          onClick={() => onComment(anchor)}
          className="absolute top-0.5 -left-9 h-5 gap-0.5 rounded-full bg-status-waiting/15 px-1.5 text-[10.5px] text-status-waiting hover:bg-status-waiting/25"
          data-testid="plan-block-comments"
        >
          <MessageSquareIcon className="size-2.5" />
          {comments}
        </Button>
      )}
      {edit && !editing && (
        <span
          className="mt-0.5 flex items-center gap-1 text-[11.5px] text-status-running"
          data-testid="plan-block-edited"
        >
          <PencilIcon className="size-3" />
          {edit.authorId === me ? "You" : edit.authorName} edited this {ago(edit.createdAt)}. The
          planner keeps the wording
          {updated.length > 0
            ? ` and updated ${updated.map((q) => `Q${q.number ?? "?"}`).join(", ")} to match`
            : ""}
          .
          <Button
            variant="link"
            size="xs"
            className="ml-1 h-auto p-0 text-current underline"
            title="Let the planner reword it"
            onClick={() => releaseEdit(workItemId, edit.id)}
            data-testid="plan-block-release"
          >
            Let it reword
          </Button>
        </span>
      )}
    </Tag>
  );
}

/**
 * The plan's body, block by block from `planBlocks` (second review of #85): each block's own source
 * lines rendered as Markdown, indented by how deep in a list it sits. A block on screen is a block
 * on the server by construction, so its Edit and Comment always name lines the server knows.
 */
export function PlanBody({
  view,
  bodyMd,
  specId,
  previous,
  components,
  workItemId,
  me,
  onComment,
}: {
  view: PlanningView;
  bodyMd: string;
  specId: string;
  previous: Set<string> | null;
  components: Components;
  workItemId: string;
  me: string | null;
  onComment: (anchor: Anchor) => void;
}) {
  const parts = useMemo(() => planBlocks(bodyMd), [bodyMd]);
  const lines = bodyMd.split("\n");
  const settled = view.questions.filter((q) => q.answeredViaEdit !== null);
  return (
    <>
      {parts.map((b) => {
        const raw = lines.slice(b.lineStart, b.lineEnd + 1).join("\n");
        const marked = markTags(raw);
        const changed = raw.split("\n").some((l) => isChanged(markTags(l), previous));
        const assumption = marked.includes("⟦assumption⟧");
        return (
          <PlanBlock
            key={`${b.lineStart}:${b.text}`}
            Tag="div"
            className={cn(
              assumption && "rounded bg-status-waiting/10 px-1",
              changed && "border-status-running border-l-2 pl-2",
              "[&_ol]:my-0 [&_p]:my-1 [&_pre]:my-1 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-selected [&_pre]:p-2 [&_ul]:my-0",
            )}
            style={{ marginLeft: `${b.indent * 0.5}rem` }}
            data={{
              "data-changed": changed ? "true" : undefined,
              "data-assumption": assumption ? "true" : undefined,
              "data-block": b.kind,
            }}
            raw={raw}
            anchor={{ specId, lineStart: b.lineStart, lineEnd: b.lineEnd, quote: raw }}
            workItemId={workItemId}
            edit={editOf(view, b)}
            settled={settled}
            comments={commentsOn(view, b, parts).length}
            me={me}
            onComment={onComment}
          >
            <Markdown components={components}>
              {markTags(dedent(raw.split("\n"), b.indent).join("\n"))}
            </Markdown>
          </PlanBlock>
        );
      })}
    </>
  );
}

/**
 * Every standing edit to the plan, kept or not, with Release (second review of #85): a person can
 * always let the planner reword one, so an edit the plan can't keep never holds the gate for good.
 */
export function YourEdits({
  view,
  workItemId,
  me,
}: {
  view: PlanningView;
  workItemId: string;
  me: string | null;
}) {
  if (view.edits.length === 0) return null;
  return (
    <div
      className="grid gap-1.5 rounded-lg border border-line-soft px-3 py-2 text-xs"
      data-testid="your-edits"
    >
      <b className="font-medium">Edits the planner keeps word for word</b>
      {view.edits.map((e) => (
        <div key={e.id} className="flex items-start gap-2" data-testid={`edit-${e.id}`}>
          <PencilIcon className="mt-0.5 size-3 flex-none text-status-running" />
          <span className="grid min-w-0 grow gap-0.5">
            <span className="line-clamp-2 whitespace-pre-wrap">
              {e.after.trim() || `Removed: ${e.before.trim()}`}
            </span>
            <span className="text-muted-foreground">
              {e.authorId === me ? "You" : e.authorName}, {ago(e.createdAt)}
              {e.blocks[0]?.section ? ` · ${e.blocks[0].section}` : ""}
              {!e.kept && (
                <span className="text-destructive">
                  {" "}
                  · not in the plan as written: holds the gate
                </span>
              )}
            </span>
          </span>
          <Button
            variant="outline"
            size="xs"
            onClick={() => releaseEdit(workItemId, e.id)}
            title="Let the planner reword it"
            data-testid={`edit-release-${e.id}`}
          >
            Release
          </Button>
        </div>
      ))}
    </div>
  );
}
