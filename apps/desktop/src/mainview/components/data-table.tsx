// A table in a white card (design: the Factory and Settings tables) and a figure tile, from
// packages/ui's Table and the shell's Panel. Header cells are quiet and small; rows are 13px.

import { ago } from "@software-factory/client/format";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@software-factory/ui/components/table";
import { cn } from "@software-factory/ui/lib/utils";
import type * as React from "react";
import { Panel } from "./shell-list.tsx";

/** A column that only shows in a wide window: the narrow window keeps what identifies a row. */
export const WIDE = "max-[1100px]:hidden";

/** A header cell: its label, or the label with a class (`WIDE`). */
type Head = React.ReactNode | { label: React.ReactNode; className: string };
const isClassed = (h: Head): h is { label: React.ReactNode; className: string } =>
  typeof h === "object" && h !== null && "className" in h && "label" in h;

export function TablePanel({
  head,
  fixed = false,
  children,
  className,
  ...props
}: {
  head: Head[];
  /** A fixed layout: the header cells' widths size the columns, so sibling tables line up. */
  fixed?: boolean;
  children: React.ReactNode;
  className?: string;
  "data-testid"?: string;
}) {
  return (
    <Panel className={cn("overflow-hidden p-0", className)} {...props}>
      <Table className={cn("text-[13px]", fixed && "table-fixed")}>
        <TableHeader>
          <TableRow className="border-line-soft hover:bg-transparent">
            {head.map((h, i) => (
              <TableHead
                // biome-ignore lint/suspicious/noArrayIndexKey: the header is fixed per table.
                key={i}
                className={cn(
                  "h-8 px-3 font-medium text-ink-muted text-xs",
                  isClassed(h) && h.className,
                )}
              >
                {isClassed(h) ? h.label : h}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>{children}</TableBody>
      </Table>
    </Panel>
  );
}

export function Row({ className, ...props }: React.ComponentProps<typeof TableRow>) {
  return <TableRow className={cn("border-line-soft hover:bg-transparent", className)} {...props} />;
}

export function Cell({ className, ...props }: React.ComponentProps<typeof TableCell>) {
  return <TableCell className={cn("h-9 px-3 py-2", className)} {...props} />;
}

/** One figure: a label, the number, and a line under it. */
export function Stat({
  label,
  value,
  sub,
  needsYou = false,
  ...props
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  needsYou?: boolean;
  "data-testid"?: string;
}) {
  return (
    <Panel className="gap-1 px-3.5 py-3" needsYou={needsYou} {...props}>
      <div className="text-ink-3 text-xs">{label}</div>
      <div className="font-semibold text-[20px] tabular-nums tracking-[-0.015em]">{value}</div>
      {sub && <div className="truncate text-ink-muted text-xs">{sub}</div>}
    </Panel>
  );
}

/** A quiet line for an empty table or section. */
export function Empty({ children }: { children: React.ReactNode }) {
  return <Panel className="text-ink-muted text-[13px]">{children}</Panel>;
}

/** The full date and time of a moment: "Thursday 12 November 2026 at 9:58 am". */
export const fullDate = (iso: string) =>
  new Date(iso).toLocaleString("en-AU", { dateStyle: "full", timeStyle: "short" });

/** A moment as "3h ago", with the full date and time on hover. */
export function When({ iso, className }: { iso: string; className?: string }) {
  return (
    <time dateTime={iso} title={fullDate(iso)} className={className}>
      {ago(iso)}
    </time>
  );
}
