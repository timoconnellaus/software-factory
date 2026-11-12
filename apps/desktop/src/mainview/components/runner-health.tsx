// The runner health line (spec 12, ported from sf-app for spec 40 M3): each of your runners with a status dot: online, busy n/cap,
// rate-limited until T, offline since T.
import { StatusDot } from "@software-factory/ui/components/status-dot";
import { cn } from "@software-factory/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import type { Inbox } from "@software-factory/client/ops";
import { RUNNER_DOT, runnerLabel, updateLabel } from "@software-factory/client/runners";

export { runnerLabel, updateLabel };

type Runner = Inbox["runners"][number];

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
          title={`${r.name}: ${runnerLabel(r)}${updateLabel(r) ? ` · ${updateLabel(r)}` : ""}`}
        >
          <StatusDot status={RUNNER_DOT[r.state]} />
          <span className="shrink-0 font-mono">{r.name}</span>
          <span className={cn("text-muted-foreground", compact && "truncate")}>
            {runnerLabel(r)}
          </span>
          {r.update && (
            <span
              className={cn(
                "text-xs",
                r.update.state === "behind" ? "text-muted-foreground" : "text-destructive",
                compact && "truncate",
              )}
              data-testid="runner-update"
            >
              · {updateLabel(r)}
            </span>
          )}
        </span>
      ))}
    </div>
  );
}
