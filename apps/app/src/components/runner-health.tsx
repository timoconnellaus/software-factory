// The runner health line (spec 12): each of your runners with a status dot: online, busy n/cap,
// rate-limited until T, offline since T.
import { type Status, StatusDot } from "@software-factory/ui/components/status-dot";
import { cn } from "@software-factory/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { ago, clock } from "#/lib/format";
import type { Inbox } from "#/lib/ops";

type Runner = Inbox["runners"][number];

const DOT: Record<Runner["state"], Status> = {
  online: "done",
  busy: "running",
  "rate-limited": "waiting",
  offline: "failed",
  draining: "idle",
};

export function runnerLabel(r: Runner): string {
  switch (r.state) {
    case "online":
      return `online · ${r.inUse}/${r.max}`;
    case "busy":
      return `busy ${r.inUse}/${r.max}`;
    case "rate-limited":
      return r.rateLimitedUntil
        ? `rate-limited until ${clock(r.rateLimitedUntil)}`
        : "rate-limited";
    case "offline":
      return r.lastSeenAt
        ? `offline since ${clock(r.lastSeenAt)} (${ago(r.lastSeenAt)})`
        : "offline · never seen";
    case "draining":
      return `draining · ${r.inUse}/${r.max}`;
  }
}

export function RunnerHealth({
  runners,
  compact = false,
}: {
  runners: Runner[] | undefined;
  compact?: boolean;
}) {
  if (!runners) return null;
  if (runners.length === 0) {
    return (
      <div
        className={cn("text-muted-foreground text-xs", compact && "px-2")}
        data-testid="runner-health"
      >
        No runners.{" "}
        <Link to="/setup" className="underline">
          Register one
        </Link>
      </div>
    );
  }
  return (
    <div
      className={cn("flex flex-wrap gap-x-4 gap-y-1 text-xs", compact && "flex-col px-2")}
      data-testid="runner-health"
    >
      {runners.map((r) => (
        <span
          key={r.id}
          className={cn("inline-flex items-center gap-1.5", compact && "min-w-0")}
          data-state={r.state}
          title={`${r.name}: ${runnerLabel(r)}`}
        >
          <StatusDot status={DOT[r.state]} />
          <span className="shrink-0 font-mono">{r.name}</span>
          <span className={cn("text-muted-foreground", compact && "truncate")}>
            {runnerLabel(r)}
          </span>
        </span>
      ))}
    </div>
  );
}
