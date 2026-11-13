// The work items a plan splits into (spec 24, design PlanFocus: "Splits into · 2 work items,
// approved together"), under the plan, and the split's parent and children on an item.
import type { PlanningView } from "@software-factory/client/planning";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@software-factory/ui/components/collapsible";
import { cn } from "@software-factory/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { splitLines } from "../lib/splits.ts";

type Child = NonNullable<PlanningView["spec"]>["children"][number];

export function SplitList({ items, unreadable = false }: { items: Child[]; unreadable?: boolean }) {
  if (unreadable) {
    return (
      <div
        className="rounded-md bg-status-failed/10 px-3 py-2 text-xs"
        data-testid="split-unreadable"
      >
        This plan's split can't be read, so it can't be approved: request changes so the planner
        revises it.
      </div>
    );
  }
  if (!items.length) return null;
  const lines = splitLines(items);
  const byKey = new Map(items.map((c) => [c.key, c]));
  return (
    <div data-testid="split">
      <div className="flex items-baseline gap-2">
        <b>Splits into</b>
        <span className="text-muted-foreground text-xs">
          {items.length} work item{items.length === 1 ? "" : "s"}, approved together
        </span>
      </div>
      <ul className="mt-1.5 grid gap-1.5">
        {items.map((c, i) => (
          <li
            key={c.key}
            className="rounded-md border border-line-soft bg-panel"
            data-testid="split-child"
          >
            {/* What is approved is shown (review of #173): each child's whole slice. */}
            <Collapsible>
              <CollapsibleTrigger className="group flex w-full items-start gap-2 px-3 py-2 text-left">
                <ChevronRightIcon className="mt-0.5 size-3.5 flex-none transition-transform group-data-[state=open]:rotate-90" />
                <span className="grid gap-0.5">
                  <span className="font-medium">{c.title}</span>
                  <span className="text-muted-foreground text-xs">{lines[i]?.detail}</span>
                </span>
              </CollapsibleTrigger>
              <CollapsibleContent className="grid gap-2 px-3 pb-2.5 pl-8 text-xs">
                <div>
                  <div className="font-medium">Goal</div>
                  <p className="m-0">{c.goal}</p>
                </div>
                <div>
                  <div className="font-medium">Scope</div>
                  <ul className="m-0 list-disc pl-4">
                    {c.scope.map((x) => (
                      <li key={x}>{x}</li>
                    ))}
                  </ul>
                </div>
                <div>
                  <div className="font-medium">Acceptance criteria</div>
                  <ul className="m-0 list-disc pl-4">
                    {c.acceptanceCriteria.map((x) => (
                      <li key={x}>{x}</li>
                    ))}
                  </ul>
                </div>
                {c.after && (
                  <div className="text-muted-foreground">
                    Waits for “{byKey.get(c.after)?.title ?? c.after}” to merge first.
                  </div>
                )}
              </CollapsibleContent>
            </Collapsible>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** On a work item: the plan it was split off, and the work items its plan split into. */
export function SplitLinks({
  split,
}: {
  split:
    | {
        parent: { id: string; number: number; title: string; status: string } | null;
        children: { id: string; number: number; title: string; status: string; stage: string }[];
      }
    | undefined;
}) {
  if (!split || (!split.parent && split.children.length === 0)) return null;
  return (
    <div className="grid gap-1.5 text-sm" data-testid="split-links">
      {split.parent && (
        <div className="text-muted-foreground text-xs">
          Split off{" "}
          <Link
            to="/work/$id"
            params={{ id: split.parent.id }}
            className="font-medium text-ink hover:underline"
          >
            #{split.parent.number} {split.parent.title}
          </Link>
        </div>
      )}
      {split.children.length > 0 && (
        <div>
          <b>Its plan split into {split.children.length} work items</b>
          <ul className="mt-1.5 grid gap-1">
            {split.children.map((c) => (
              <li key={c.id} className="flex items-center gap-2" data-testid="split-item">
                <span className="font-mono text-muted-foreground text-xs">#{c.number}</span>
                <Link
                  to="/work/$id"
                  params={{ id: c.id }}
                  className="min-w-0 grow truncate hover:underline"
                >
                  {c.title}
                </Link>
                <span
                  className={cn(
                    "flex-none text-xs",
                    ["failed", "rejected", "cancelled"].includes(c.status)
                      ? "text-status-failed"
                      : "text-muted-foreground",
                  )}
                >
                  {/* An ended child shows how it ended, not the stage it stopped in. */}
                  {["done", "failed", "rejected", "cancelled"].includes(c.status)
                    ? c.status
                    : c.stage}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
