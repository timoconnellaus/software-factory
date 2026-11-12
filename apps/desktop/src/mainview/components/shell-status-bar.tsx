// The status bar (spec 41): this person's runners and slots, what's running, what waits on them,
// and the sync state. Real data only: no budget and no update notice until main has them.
import { StatusDot } from "@software-factory/ui/components/status-dot";
import { cn } from "@software-factory/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { waitingCount } from "../lib/scope.ts";
import { runnerItems, runningCount, slots, syncText } from "../lib/status-bar.ts";
import { useScopedInbox } from "./shell-sidebar.tsx";

export function StatusBar() {
  const { query, inbox: scoped } = useScopedInbox();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);
  const runners = query.data?.runners ?? [];
  const slot = slots(runners);
  const sync = syncText(query, now);
  return (
    <section
      role="status"
      aria-label="Status bar"
      className="flex h-7 flex-none items-center gap-3.5 overflow-hidden whitespace-nowrap px-3.5 text-ink-3 text-xs"
      data-testid="status-bar"
    >
      {query.data && runners.length === 0 && (
        <Link to="/setup" className="inline-flex items-center gap-1.5 hover:text-ink">
          <StatusDot status="idle" />
          No runner
        </Link>
      )}
      {runnerItems(runners).map((r) => (
        <Link
          key={r.id}
          to="/settings"
          className="inline-flex items-center gap-1.5 hover:text-ink"
          data-testid="status-runner"
        >
          <StatusDot status={r.status} />
          {r.text}
        </Link>
      ))}
      {slot.heavy && <span data-testid="status-heavy">{slot.heavy}</span>}
      {slot.light && <span data-testid="status-light">{slot.light}</span>}
      {scoped && (
        <>
          <span aria-hidden className="h-3 w-px bg-line-strong" />
          <Link
            to="/work"
            className="inline-flex items-center gap-1.5 hover:text-ink"
            data-testid="status-running"
          >
            <StatusDot status="running" />
            {runningCount(scoped)} running
          </Link>
          <Link
            to="/"
            className="inline-flex items-center gap-1.5 hover:text-ink"
            data-testid="status-waiting"
          >
            <StatusDot status="waiting" />
            {waitingCount(scoped)} waiting on you
          </Link>
        </>
      )}
      <span className="flex-1" />
      <span className={cn(!sync.ok && "text-destructive")} data-testid="status-sync">
        {sync.text}
      </span>
    </section>
  );
}
