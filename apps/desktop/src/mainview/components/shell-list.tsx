// The content panel's parts (spec 41, ADR 0460): a section's nested list (212px) and the page
// beside it. Only these two scroll; the chrome never does.
import { cn } from "@software-factory/ui/lib/utils";
import { Link, type LinkProps } from "@tanstack/react-router";
import type * as React from "react";

export function NestedList({
  title,
  label,
  action,
  children,
}: {
  title: string;
  label?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <nav
      aria-label={label ?? `${title} list`}
      data-nested-list
      className="flex w-[212px] flex-none flex-col gap-px overflow-y-auto border-line-soft border-r px-2 py-3"
    >
      <div className="flex h-7 flex-none items-center px-2 pb-1.5">
        <span className="font-semibold text-[15px] tracking-[-0.01em]">{title}</span>
        {action && <span className="ml-auto">{action}</span>}
      </div>
      {children}
    </nav>
  );
}

export function ListGroup({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2 pt-3 pb-1 font-medium text-[11px] text-ink-muted first-of-type:pt-1">
      {children}
    </div>
  );
}

/** A row in a nested list: a link, current when `active`. One line, or two with `sub`. */
export function ListItem({
  active,
  icon,
  count,
  sub,
  children,
  className,
  ...link
}: LinkProps & {
  active: boolean;
  icon?: React.ReactNode;
  count?: number | null;
  sub?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      {...link}
      data-list-item
      aria-current={active ? "true" : undefined}
      className={cn(
        "flex flex-none rounded-[7px] px-2 text-ink outline-none hover:bg-selected/70 focus-visible:ring-2 focus-visible:ring-ring/40",
        sub ? "min-h-11 flex-col justify-center gap-px py-[5px]" : "h-[31px] items-center gap-2",
        active && "bg-selected hover:bg-selected",
        className,
      )}
    >
      {sub ? (
        <>
          <span className={cn("truncate", active ? "font-semibold" : "font-medium")}>
            {children}
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-ink-muted text-xs">{sub}</span>
        </>
      ) : (
        <>
          {icon && <span className="flex text-ink-3 [&_svg]:size-3.5">{icon}</span>}
          <span className={cn("min-w-0 flex-1 truncate", active && "font-medium")}>{children}</span>
          {count !== undefined && count !== null && (
            <span className="font-mono text-[11.5px] text-ink-muted tabular-nums">{count}</span>
          )}
        </>
      )}
    </Link>
  );
}

/** The page beside the list: the grey-white page area that scrolls on its own. */
export function PageArea({
  children,
  wide = false,
  className,
  ...props
}: React.ComponentProps<"main"> & { wide?: boolean }) {
  return (
    <main
      id="main"
      className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-page"
      data-testid="page"
      {...props}
    >
      <div
        className={cn(
          "mx-auto flex flex-col gap-4 px-[22px] pt-[18px] pb-7",
          wide ? "max-w-none" : "max-w-[1000px]",
          className,
        )}
      >
        {children}
      </div>
    </main>
  );
}

/** A page's header: an optional line above (crumbs, chips), the title and a line under it. */
export function PageHeader({
  above,
  title,
  sub,
  actions,
  testId,
}: {
  above?: React.ReactNode;
  title: React.ReactNode;
  sub?: React.ReactNode;
  actions?: React.ReactNode;
  testId?: string;
}) {
  return (
    <header className="flex flex-wrap items-end gap-2.5">
      <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-1">
        {above && <div className="text-ink-muted text-xs">{above}</div>}
        <h1 className="m-0 font-semibold text-[18px] tracking-[-0.015em]" data-testid={testId}>
          {title}
        </h1>
        {sub && <div className="max-w-[680px] text-[13px] text-ink-3 leading-normal">{sub}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

/** A white card in the page (design: radius 10, the hairline ring). */
export function Panel({
  className,
  needsYou = false,
  ...props
}: React.ComponentProps<"div"> & { needsYou?: boolean }) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-2 rounded-[10px] bg-panel px-3.5 py-3 shadow-panel",
        needsYou && "shadow-needs-you",
        className,
      )}
      {...props}
    />
  );
}

/** A section title in the page, with an optional quiet note after it. */
export function SectionTitle({ children, note }: { children: React.ReactNode; note?: string }) {
  return (
    <h2 className="m-0 flex flex-wrap items-baseline gap-2.5 font-semibold text-[13px]">
      {children}
      {note && <span className="font-normal text-ink-muted text-xs">{note}</span>}
    </h2>
  );
}

/** A small pill: neutral, or a tint (amber "needs you", blue "working", green "done"). */
export function Chip({
  tone = "neutral",
  className,
  ...props
}: React.ComponentProps<"span"> & { tone?: "neutral" | "amber" | "blue" | "green" }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-[5px] whitespace-nowrap rounded-full px-[7px] py-px font-medium text-[11px]",
        tone === "neutral" && "bg-panel text-ink-3 shadow-ring",
        tone === "amber" && "bg-chip-amber text-chip-amber-ink",
        tone === "blue" && "bg-chip-blue text-chip-blue-ink",
        tone === "green" && "bg-chip-green text-chip-green-ink",
        className,
      )}
      {...props}
    />
  );
}

/** A form field: its label above the control (`htmlFor` names the control's id). */
export function Field({
  label,
  htmlFor,
  className,
  children,
}: {
  label: React.ReactNode;
  htmlFor: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("flex flex-col gap-[5px]", className)}>
      <label htmlFor={htmlFor} className="font-medium text-ink-3 text-xs">
        {label}
      </label>
      {children}
    </div>
  );
}
