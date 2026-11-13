// The work items a plan splits into (spec 24, design PlanFocus: "Splits into · 2 work items,
// approved together"), under the plan, and the split's parent and children on an item.
import type { PlanningView } from "@software-factory/client/planning";
import { Link } from "@tanstack/react-router";
import { splitLines } from "../lib/splits.ts";

type Child = NonNullable<PlanningView["spec"]>["children"][number];

export function SplitList({ items }: { items: Child[] }) {
  if (!items.length) return null;
  const lines = splitLines(items);
  return (
    <div data-testid="split">
      <div className="flex items-baseline gap-2">
        <b>Splits into</b>
        <span className="text-muted-foreground text-xs">
          {items.length} work item{items.length === 1 ? "" : "s"}, approved together
        </span>
      </div>
      <ul className="mt-1.5 grid gap-1.5">
        {lines.map((l) => (
          <li
            key={l.key}
            className="rounded-md border border-line-soft bg-panel px-3 py-2"
            data-testid="split-child"
          >
            <div className="font-medium">{l.title}</div>
            <div className="text-muted-foreground text-xs">{l.detail}</div>
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
                <span className="flex-none text-muted-foreground text-xs">
                  {c.status === "done" || c.status === "cancelled" ? c.status : c.stage}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
