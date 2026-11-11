import { cn } from "@software-factory/ui/lib/utils";
import type * as React from "react";

/** The factory status tokens (design system): status is a dot, never a fill. */
export type Status = "waiting" | "running" | "done" | "failed" | "idle" | "local";

const COLOR: Record<Status, string> = {
  waiting: "bg-status-waiting",
  running: "bg-status-running",
  done: "bg-status-done",
  failed: "bg-status-failed",
  idle: "bg-status-idle",
  local: "bg-status-local",
};

function StatusDot({
  status,
  className,
  ...props
}: React.ComponentProps<"span"> & { status: Status }) {
  return (
    <span
      data-slot="status-dot"
      data-status={status}
      aria-hidden
      className={cn("inline-block size-1.5 flex-none rounded-full", COLOR[status], className)}
      {...props}
    />
  );
}

/** A small outline badge with a status dot, e.g. "● Spec approval". */
function StatusBadge({
  status,
  className,
  children,
  ...props
}: React.ComponentProps<"span"> & { status: Status }) {
  return (
    <span
      data-slot="status-badge"
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border px-2 py-0.5 font-medium text-xs",
        className,
      )}
      {...props}
    >
      <StatusDot status={status} />
      {children}
    </span>
  );
}

export { StatusBadge, StatusDot };
