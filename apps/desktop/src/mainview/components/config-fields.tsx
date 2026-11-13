// The small presentational pieces of the config editors (no reads): a change's class, a one-of-a-
// few picker, and an instructions counter. Kept apart from config-editor.tsx so a page can use them
// without the draft hook's reads (the loaders test follows a page's component imports).

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@software-factory/ui/components/alert-dialog";
import { ToggleGroup, ToggleGroupItem } from "@software-factory/ui/components/toggle-group";
import { cn } from "@software-factory/ui/lib/utils";
import { useBlocker } from "@tanstack/react-router";
import { Chip } from "./shell-list.tsx";

type Doc = Record<string, unknown>;

/** The cap on any instructions text (project and org agents and steps: the schemas' max). */
export const INSTRUCTIONS_MAX = 4_000;

/** How a change moves the config, as the engine classified it. */
export function ImpactChip({ value }: { value: string }) {
  return (
    <Chip
      tone={value === "loosens" ? "amber" : value === "tightens" ? "green" : "neutral"}
      data-impact={value}
    >
      {value}
    </Chip>
  );
}

/** One of a few: a ToggleGroup that can't be cleared. */
export function Segmented({
  options,
  value,
  label,
  onChange,
}: {
  options: readonly string[];
  value: string;
  label: string;
  onChange: (v: string) => void;
}) {
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      aria-label={label}
      value={value}
      onValueChange={(v) => v && onChange(v)}
    >
      {options.map((o) => (
        <ToggleGroupItem
          key={o}
          value={o}
          className="px-3 capitalize data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
        >
          {o}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

/** "1,234 / 4,000" under an instructions box, amber near the cap, so it is seen before the error. */
export function CharCount({ value, max = INSTRUCTIONS_MAX }: { value: string; max?: number }) {
  const n = value.length;
  return (
    <span
      className={cn(
        "self-end text-[11px] tabular-nums",
        n > max
          ? "font-medium text-chip-amber-ink"
          : n > max * 0.9
            ? "text-chip-amber-ink"
            : "text-ink-muted",
      )}
      data-testid="char-count"
    >
      {n.toLocaleString("en")} / {max.toLocaleString("en")}
      {n > max ? ": too long to save" : ""}
    </span>
  );
}

/** The value at a dotted path of a config document, or undefined. */
export function valueAt(doc: Doc | null, path: string): unknown {
  let v: unknown = doc;
  for (const key of path.split(".")) {
    if (!v || typeof v !== "object") return undefined;
    v = (v as Doc)[key];
  }
  return v;
}

/** A setting's value, short enough for one line. */
export function shown(v: unknown): string {
  if (v === undefined || v === null) return "not set";
  if (typeof v === "string") return v || "empty";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v) && v.every((x) => typeof x !== "object"))
    return v.length ? v.join(", ") : "none";
  const json = JSON.stringify(v);
  return json.length > 120 ? `${json.slice(0, 117)}…` : json;
}

/**
 * What differs, before and after, for each path the engine says changed: the change itself, beside
 * its class, so a person approves what they can see. A path the documents don't both have a value
 * for (a whole new section) shows the engine's words only.
 */
export function ChangeDiff({
  before,
  after,
  changes,
  testId,
}: {
  before: Doc | null;
  after: Doc | null;
  changes: { path: string; summary: string; class: string }[];
  testId?: string;
}) {
  const paths = [...new Set(changes.map((c) => c.path))].filter((p) => p !== "*");
  const rows = paths
    .map((path) => ({ path, was: valueAt(before, path), now: valueAt(after, path) }))
    .filter((r) => JSON.stringify(r.was) !== JSON.stringify(r.now));
  if (rows.length === 0) return null;
  return (
    <div
      className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-lg bg-page px-3 py-2 text-xs"
      data-testid={testId}
    >
      {rows.map((r) => (
        <div key={r.path} className="contents">
          <span className="font-mono text-ink-3">{r.path}</span>
          <span className="min-w-0 break-words">
            <span className="text-ink-3 line-through">{shown(r.was)}</span>
            {" → "}
            <span className="font-medium">{shown(r.now)}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

/** The changes a draft (or a waiting proposal) makes, each with its class. */
export function ImpactList({
  changes,
  testId,
}: {
  changes: { path: string; summary: string; class: string }[];
  testId?: string;
}) {
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[13px]" data-testid={testId}>
      {changes.map((c) => (
        <li key={`${c.path}-${c.summary}`} className="flex items-start gap-2">
          <ImpactChip value={c.class} />
          <span className="min-w-0">{c.summary}</span>
        </li>
      ))}
    </ul>
  );
}

/** Asks before unsaved changes are lost, for any editor (`dirty` while it differs from saved). */
export function LeaveGuard({ dirty }: { dirty: boolean }) {
  const blocker = useBlocker({ shouldBlockFn: () => dirty, withResolver: true });
  return (
    <AlertDialog open={blocker.status === "blocked"} onOpenChange={(o) => !o && blocker.reset?.()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Discard your unsaved changes?</AlertDialogTitle>
          <AlertDialogDescription>
            Nothing has been saved. Leaving now drops them.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => blocker.reset?.()}>Keep editing</AlertDialogCancel>
          <AlertDialogAction onClick={() => blocker.proceed?.()}>Discard</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
