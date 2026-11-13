// A change's difference as rows (lib/org-diff.ts): a label, what was, what will be.
import type { DiffRow } from "../lib/org-diff.ts";

/** Difference rows: a label, what was, what will be. */
export function DiffRows({ rows, testId }: { rows: DiffRow[]; testId?: string }) {
  if (rows.length === 0) return null;
  return (
    <div
      className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-lg bg-page px-3 py-2 text-xs"
      data-testid={testId}
    >
      {rows.map((r, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: two stages may share a name; rows are a fixed list.
        <div key={i} className="contents">
          <span className="text-ink-3">{r.label}</span>
          <span className="flex min-w-0 flex-col gap-0.5">
            <span className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-ink-3 line-through">
              {r.was}
            </span>
            <span className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-medium">
              {r.now}
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}
