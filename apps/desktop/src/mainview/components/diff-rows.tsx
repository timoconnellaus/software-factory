// A change's difference as rows (lib/org-diff.ts): a label, what was, what will be.
import { changedRegion, type DiffRow } from "../lib/org-diff.ts";

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
          <Region was={r.was} now={r.now} />
        </div>
      ))}
    </div>
  );
}

/**
 * Where two values differ: the shared context shortened, the differing part marked on each side,
 * and spaces, tabs and invisible characters shown, so no change is invisible (review of #159).
 */
function Region({ was, now }: { was: string; now: string }) {
  const r = changedRegion(was, now);
  return (
    <span className="flex min-w-0 flex-col gap-0.5 whitespace-pre-wrap break-words font-mono text-[11px]">
      <span className="text-ink-3" data-testid="diff-was">
        {r.before}
        <mark className="bg-chip-amber text-chip-amber-ink line-through">{r.was || "∅"}</mark>
        {r.after}
      </span>
      <span data-testid="diff-now">
        {r.before}
        <mark className="bg-chip-green text-chip-green-ink">{r.now || "∅"}</mark>
        {r.after}
      </span>
    </span>
  );
}
