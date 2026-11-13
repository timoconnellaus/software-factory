// How a plan's split reads (spec 24, design PlanFocus): each child's size and order, in words.
const SIZE = { small: "Small", medium: "Medium", large: "Large" } as const;

export interface SplitChildView {
  key: string;
  title: string;
  size: "small" | "medium" | "large";
  after?: string | undefined;
}

/** "Small · builds first", "Small · waits for “Issue intake”", or the size alone. */
export function splitLines(children: SplitChildView[]) {
  const byKey = new Map(children.map((c) => [c.key, c]));
  const first = children.find((c) => !c.after);
  return children.map((c) => {
    const waitedOn = children.some((o) => o.after === c.key);
    const after = c.after ? byKey.get(c.after) : undefined;
    const order = after
      ? after === first && children.indexOf(after) === 0
        ? "waits for the first"
        : `waits for “${after.title}”`
      : waitedOn
        ? "builds first"
        : null;
    return {
      key: c.key,
      title: c.title,
      detail: [SIZE[c.size], order].filter(Boolean).join(" · "),
    };
  });
}

/** The approve button's words at a gate whose plan splits (design: "Approve plan and 2 work items"). */
export function splitApproveLabel(children: number, kimCount: number | undefined): string | null {
  if (!children) return null;
  const files = kimCount ? `, writing ${kimCount} file${kimCount === 1 ? "" : "s"} to .kim/` : "";
  return `Approve the plan and ${children} work item${children === 1 ? "" : "s"}${files}`;
}

/**
 * A list with each split's children right under their parent (spec 24), when the parent is in the
 * list too; otherwise items keep their order. `depth` 1 marks a child shown under its parent.
 */
export function groupUnderParents<T extends { id: string; parentWorkItemId?: string | null }>(
  items: T[],
): { item: T; depth: 0 | 1 }[] {
  const ids = new Set(items.map((i) => i.id));
  const under = new Map<string, T[]>();
  for (const i of items) {
    const p = i.parentWorkItemId;
    if (p && ids.has(p)) under.set(p, [...(under.get(p) ?? []), i]);
  }
  const out: { item: T; depth: 0 | 1 }[] = [];
  for (const i of items) {
    if (i.parentWorkItemId && ids.has(i.parentWorkItemId)) continue;
    out.push({ item: i, depth: 0 });
    for (const c of under.get(i.id) ?? []) out.push({ item: c, depth: 1 });
  }
  return out;
}
