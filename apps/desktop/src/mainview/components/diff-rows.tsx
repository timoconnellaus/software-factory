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
      {rows.map((r) => (
        <div key={`${r.label}:${r.was}`} className="contents">
          <span className="text-ink-3">{r.label}</span>
          <span className="min-w-0 break-words">
            <span className="text-ink-3 line-through">{r.was}</span>
            {" → "}
            <span className="font-medium">{r.now}</span>
          </span>
        </div>
      ))}
    </div>
  );
}
