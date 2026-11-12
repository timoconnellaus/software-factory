// Factory: Runners (spec 41, slice 5; design FactoryRunners). Your runners with their state, slots
// and load (`inbox.list`'s health) and their version and update (`runner.list`, specs 38 and 43),
// then the chosen runner's details. Pausing (draining) and removing a runner have no operation yet:
// a drain is `sf-runner` on the host today, so the buttons aren't here.
import { clock } from "@software-factory/client/format";
import { Button } from "@software-factory/ui/components/button";
import { StatusDot } from "@software-factory/ui/components/status-dot";
import { cn } from "@software-factory/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { createRoute, Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Cell, Empty, Row, TablePanel } from "../components/data-table.tsx";
import { PageArea, PageHeader, Panel } from "../components/shell-list.tsx";
import { type RunnerRow, runnerRows } from "../lib/factory.ts";
import { inboxQuery, runnersQuery } from "../lib/queries.ts";
import { factoryLayout } from "./_factory.tsx";

interface Search {
  runner?: string;
}

export const Route = createRoute({
  getParentRoute: () => factoryLayout,
  path: "/factory/runners",
  validateSearch: (s: Record<string, unknown>): Search =>
    typeof s.runner === "string" ? { runner: s.runner } : {},
  loader: ({ context: { queryClient } }) =>
    Promise.all([
      queryClient.ensureQueryData(runnersQuery()),
      queryClient.ensureQueryData(inboxQuery()),
    ]).catch(() => null),
  component: RunnersPage,
});

function RunnersPage() {
  const search = Route.useSearch();
  const inbox = useQuery(inboxQuery());
  const listed = useQuery({ ...runnersQuery(), refetchInterval: 15_000 });
  const rows = runnerRows(inbox.data?.runners ?? [], listed.data?.runners ?? [], clock);
  const chosen = rows.find((r) => r.id === search.runner) ?? rows[0];
  return (
    <PageArea>
      <PageHeader
        title="Runners"
        sub="Machines that run agent sessions. A runner uses its owner's model subscription and never holds your GitHub credentials."
        actions={
          <Button size="md" variant="outline" asChild>
            <Link to="/setup" data-testid="connect-runner">
              Connect a runner
            </Link>
          </Button>
        }
      />
      {rows.length === 0 ? (
        <Empty>
          You have no runners yet.{" "}
          <Link to="/setup" className="text-ink underline">
            Pair one in Setup
          </Link>
        </Empty>
      ) : (
        <TablePanel head={["Runner", "State", "Heavy", "Light", "Version"]} data-testid="runners">
          {rows.map((r) => (
            <Row
              key={r.id}
              aria-current={r.id === chosen?.id ? "true" : undefined}
              className={cn(r.id === chosen?.id && rows.length > 1 && "bg-selected/60")}
              data-testid={`runner-${r.id}`}
            >
              <Cell className="font-medium">
                <Link to="/factory/runners" search={{ runner: r.id }} className="hover:underline">
                  {r.name}
                </Link>
              </Cell>
              <Cell>
                <span className="inline-flex items-center gap-2">
                  <StatusDot status={r.dot} />
                  {r.stateText}
                </span>
              </Cell>
              <Cell className="tabular-nums">{r.heavy}</Cell>
              <Cell className="tabular-nums">{r.light ?? "none"}</Cell>
              <Cell className="min-w-[160px] whitespace-normal">
                <span
                  className={cn(
                    "font-mono text-xs",
                    r.updateNeedsYou ? "text-destructive" : "text-ink-3",
                  )}
                  title={r.versionText}
                  data-testid="runner-version"
                >
                  {r.version ?? "unknown"} · {r.versionText}
                </span>
              </Cell>
            </Row>
          ))}
        </TablePanel>
      )}
      {chosen && <RunnerDetails r={chosen} />}
    </PageArea>
  );
}

function RunnerDetails({ r }: { r: RunnerRow }) {
  const rows: [string, ReactNode][] = [
    ["State", r.stateText],
    ["Harness", r.harnesses.length ? r.harnesses.join(", ") : "not reported"],
    ["Adapter", r.kind ?? "not reported"],
    [
      "Updates",
      r.autoUpdate === null ? "not reported" : r.autoUpdate ? "Itself, when idle" : "Off",
    ],
    ["Version", r.version ? `${r.version} · ${r.versionText}` : "not reported"],
    [
      "Rate limit",
      r.rateLimitedUntil && Date.parse(r.rateLimitedUntil) > Date.now()
        ? `Until ${clock(r.rateLimitedUntil)}`
        : "None right now",
    ],
    [
      "Claude accounts",
      r.accounts
        ? `${r.accounts.active}${r.accounts.names.length > 1 ? ` (of ${r.accounts.names.join(", ")})` : ""}`
        : "not reported",
    ],
    ["Last heard", r.lastSeenAt ? clock(r.lastSeenAt) : "never"],
  ];
  return (
    <Panel className="max-w-[460px] gap-2.5" data-testid="runner-details">
      <div className="font-semibold">{r.name}</div>
      <dl className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-1.5 text-[13px]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-ink-3">{k}</dt>
            <dd className="m-0 min-w-0 break-words">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="text-ink-muted text-xs">
        This Mac's own runner is started and restarted from{" "}
        <Link to="/settings" className="text-ink underline">
          This Mac
        </Link>
        .
      </div>
    </Panel>
  );
}
