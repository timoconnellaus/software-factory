// The babysitter on the desktop (spec 53 §9): the Overview's Babysitter line per repository, the
// Held badge on waiting items, the red-main Inbox card, and Mark as repair. Everything is read from
// `delivery.status` (main's health, the episode's suspects and culprit, each delivery's state) and
// `inbox.list`'s `mainRed`; marking a repair is a decision (Touch ID, ADR 0391).
// No design file covers these screens; they follow FactoryOverview, InboxMerge and WorkActive.
import { ago } from "@software-factory/client/format";
import type { Inbox, OpOutput } from "@software-factory/client/ops";
import { Button } from "@software-factory/ui/components/button";
import { StatusDot } from "@software-factory/ui/components/status-dot";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useDecide } from "../lib/decisions.tsx";
import { deliveryStatusQuery } from "../lib/factory-queries.ts";
import { openItem } from "../lib/places.ts";
import { Cell, Empty, Row, TablePanel, WIDE } from "./data-table.tsx";
import { Reads } from "./read-state.tsx";
import { Chip, PageHeader, Panel, SectionTitle } from "./shell-list.tsx";

type Repository = OpOutput<"delivery.status">["repositories"][number];
type MainRed = Inbox["mainRed"][number];

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : "");

/** What the babysitter is doing on a repository, in a few words. */
function doing(r: Repository): string {
  const merging = r.deliveries.find((d) => d.state === "merging");
  if (merging) return `Merging #${merging.number}`;
  const held = r.deliveries.filter((d) => d.state === "held").length;
  if (held) return `Holding ${held} until ${r.branch} is green`;
  return r.deliveries.length ? `${r.deliveries.length} waiting` : "Idle";
}

/** Main's line: green, red since when and what fails, or not seen yet. */
function MainLine({ r }: { r: Repository }) {
  const m = r.main;
  if (!m) return <span className="text-ink-muted">Not seen yet</span>;
  if (m.state === "green")
    return (
      <span className="flex items-center gap-1.5">
        <StatusDot status="done" />
        {r.branch} is green
      </span>
    );
  if (m.state === "pending" && !m.redSince)
    return (
      <span className="flex items-center gap-1.5">
        <StatusDot status="running" />
        CI running on {short(m.headSha)}
      </span>
    );
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="flex flex-wrap items-center gap-x-1.5 font-medium">
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
          <StatusDot status="failed" />
          {r.branch} is red
        </span>
        {m.redSince && <span className="font-normal text-ink-muted">{ago(m.redSince)}</span>}
      </span>
      <span className="break-words text-ink-muted text-xs">
        {m.failing.length ? m.failing.join(", ") : "CI failed"} on {short(m.headSha)}
      </span>
    </span>
  );
}

/** Who turned it red: the culprit as named, a candidate being checked, or the suspects. */
function Culprit({ r }: { r: Repository }) {
  const m = r.main;
  if (!m?.redSince) return null;
  const named = m.suspects.find((s) => s.workItemId === m.culpritWorkItemId);
  if (named)
    return (
      <span className="text-xs">
        Culprit{" "}
        <Link {...openItem(named.workItemId)} className="underline">
          #{named.number}
        </Link>{" "}
        <span className="text-ink-muted">
          ({m.attributedBy === "proven" ? "proven" : `named by ${m.attributedBy}`})
        </span>
      </span>
    );
  const candidate = m.suspects.find((s) => s.workItemId === m.candidateWorkItemId);
  if (candidate)
    return (
      <span className="text-ink-muted text-xs">
        Checking #{candidate.number}: rerunning the failing checks
      </span>
    );
  return (
    <span className="text-ink-muted text-xs">
      {m.suspects.length
        ? `${m.suspects.length} suspect${m.suspects.length === 1 ? "" : "s"}, none proven`
        : "No factory landing since green"}
    </span>
  );
}

/** Factory › Overview: one line per repository the babysitter delivers to. */
export function BabysitterSection({ projects }: { projects: { id: string; name: string }[] }) {
  const reads = useQueries({ queries: projects.map((p) => deliveryStatusQuery(p.id)) });
  const rows = reads.flatMap((q, i) =>
    (q.data?.repositories ?? []).map((r) => ({ r, project: projects[i]?.name ?? "" })),
  );
  return (
    <>
      <SectionTitle note="Lands approved work and keeps the default branch green.">
        Babysitter
      </SectionTitle>
      <Reads queries={reads} what="the babysitter">
        {() =>
          rows.length === 0 ? (
            <Empty>No repository to deliver to yet.</Empty>
          ) : (
            <TablePanel
              head={[
                "Repository",
                "Main",
                { label: "Doing", className: WIDE },
                { label: "Held", className: WIDE },
              ]}
              data-testid="babysitter"
            >
              {rows.map(({ r, project }) => {
                const held = r.deliveries.filter((d) => d.state === "held");
                return (
                  <Row key={r.repositoryId} data-testid={`babysitter-${r.repositoryId}`}>
                    <Cell className="whitespace-normal">
                      <span className="font-medium">
                        {r.owner}/{r.name}
                      </span>
                      <span className="block text-ink-muted text-xs">{project}</span>
                    </Cell>
                    <Cell className="whitespace-normal">
                      <span className="flex flex-col gap-1">
                        <MainLine r={r} />
                        <Culprit r={r} />
                        {/* Narrow: the Doing and Held columns fold in here. */}
                        <span className="text-xs min-[1100px]:hidden">
                          {doing(r)}
                          {held.length > 0 &&
                            ` · held: ${held.map((d) => `#${d.number}`).join(", ")}`}
                        </span>
                      </span>
                    </Cell>
                    <Cell className={WIDE}>{doing(r)}</Cell>
                    <Cell className={`whitespace-normal ${WIDE}`}>
                      {held.length === 0 ? (
                        <span className="text-ink-muted">None</span>
                      ) : (
                        <span className="flex flex-wrap gap-1">
                          {held.map((d) => (
                            <Link key={d.workItemId} {...openItem(d.workItemId)}>
                              <Chip tone="amber">#{d.number}</Chip>
                            </Link>
                          ))}
                        </span>
                      )}
                    </Cell>
                  </Row>
                );
              })}
            </TablePanel>
          )
        }
      </Reads>
    </>
  );
}

/** Whether an item's delivery is held behind a red main (its project's `delivery.status`). */
export function useHeld(projectId: string, workItemId: string): boolean {
  const status = useQuery({ ...deliveryStatusQuery(projectId), enabled: !!projectId });
  return !!status.data?.repositories.some((r) =>
    r.deliveries.some((d) => d.workItemId === workItemId && d.state === "held"),
  );
}

/** The Held badge: approved, waiting for main to be green (decision 4). */
export function HeldChip({ projectId, workItemId }: { projectId: string; workItemId: string }) {
  if (!useHeld(projectId, workItemId)) return null;
  return (
    <Chip tone="amber" className="w-fit" data-testid={`held-${workItemId}`}>
      Held: main is red
    </Chip>
  );
}

/** The Inbox's red-main card (decision 4): one per episode, for the project's approvers. */
export function MainRedCard({ red, projectName }: { red: MainRed; projectName: string }) {
  const status = useQuery(deliveryStatusQuery(red.projectId));
  const repo = status.data?.repositories.find((r) => r.repositoryId === red.repositoryId);
  const held = repo?.deliveries.filter((d) => d.state === "held") ?? [];
  return (
    <div className="flex flex-col gap-4" data-testid={`main-red-${red.repositoryId}`}>
      <PageHeader
        above={
          <>
            <Chip tone="amber">main is red</Chip>
            &nbsp;{" "}
            <span className="font-mono text-[11.5px] text-ink-muted">
              {red.repo.owner}/{red.repo.name} · {projectName}
            </span>
          </>
        }
        title={`${red.branch} is red`}
        sub={`Since ${ago(red.redSince)}. Only repairs merge until it is green again; approved work waits, and GitHub refuses merges of waiting pull requests too.`}
      />
      <Panel needsYou>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="font-medium">Failing</span>
          <span>{red.failing.length ? red.failing.join(", ") : "CI"}</span>
          <span className="font-mono text-ink-muted text-xs">on {short(red.headSha)}</span>
          {red.lastGreenSha && (
            <span className="text-ink-muted text-xs">last green {short(red.lastGreenSha)}</span>
          )}
        </div>
        {repo && <Culprit r={repo} />}
      </Panel>
      {repo?.main && repo.main.suspects.length > 0 && (
        <Panel>
          <span className="font-medium">Landed since it was green</span>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {repo.main.suspects.map((s) => (
              <li key={s.workItemId} className="flex items-center gap-2">
                <Link {...openItem(s.workItemId)} className="hover:underline">
                  #{s.number} {s.title}
                </Link>
                <span className="font-mono text-ink-muted text-xs">{short(s.mergeSha)}</span>
              </li>
            ))}
          </ul>
        </Panel>
      )}
      <Panel>
        <span className="font-medium">Held {held.length ? `(${held.length})` : ""}</span>
        {held.length === 0 ? (
          <span className="text-ink-muted">Nothing is waiting to merge.</span>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {held.map((d) => (
              <li key={d.workItemId}>
                <Link {...openItem(d.workItemId)} className="hover:underline">
                  #{d.number} {d.title}
                </Link>
              </li>
            ))}
          </ul>
        )}
        <span className="text-ink-muted text-xs">
          A fix lands ahead of them once it is marked as a repair on its page.{" "}
          <Link to="/factory" className="underline">
            Open the Overview
          </Link>
        </span>
      </Panel>
    </div>
  );
}

/**
 * Mark as repair (spec 53 §2): a fix for a red main lands while the line is stopped, ahead of held
 * work. Shown only while the item's repository is red; a decision, so Touch ID confirms it.
 */
export function MarkRepair({
  projectId,
  repositoryId,
  workItemId,
}: {
  projectId: string;
  repositoryId: string | null;
  workItemId: string;
}) {
  const status = useQuery({ ...deliveryStatusQuery(projectId), enabled: !!repositoryId });
  const { decide, pending } = useDecide();
  const repo = status.data?.repositories.find((r) => r.repositoryId === repositoryId);
  if (!repo?.main?.redSince) return null;
  const repair = repo.deliveries.find((d) => d.workItemId === workItemId)?.repair ?? false;
  return (
    <Panel needsYou={!repair} data-testid="mark-repair">
      <span className="flex items-center gap-1.5 font-medium">
        <StatusDot status="failed" />
        {repo.branch} is red
      </span>
      <span className="text-ink-3">
        {repair
          ? "This item is a repair: it lands while the line is stopped, ahead of held work."
          : "If this item fixes it, mark it as a repair: it then lands while the line is stopped, ahead of held work, through its own merge gate."}
      </span>
      <div>
        <Button
          size="sm"
          variant={repair ? "outline" : "default"}
          disabled={pending !== null}
          onClick={() => void decide({ kind: "workItem.markRepair", workItemId, repair: !repair })}
        >
          {repair ? "Not a repair" : "Mark as repair"}
        </Button>
      </div>
    </Panel>
  );
}
