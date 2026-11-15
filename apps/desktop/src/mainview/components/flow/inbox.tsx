// The Inbox (.kim/mockups/inbox.html): what waits on the signed-in person, from flow.inbox.get (the
// sidebar's count reads the same). The list on the left; the chosen item on the right, decision
// first: the item's decision card with its buttons at the top, then the last few timeline cards that
// led to it, newest first, then "Show the whole timeline", which opens the item. Acting on it moves
// to the next row. The item, its timeline and its decision are the item panel's own (item.tsx,
// timeline.tsx); nothing here is built twice.
import type { Decision, FlowProject, FlowWorkflow } from "@software-factory/client/flow";
import { flowKey, when } from "@software-factory/client/flow";
import {
  type InboxRow,
  inboxQuestion,
  inboxRows,
  nextRow,
} from "@software-factory/client/flow-edit";
import { Skeleton } from "@software-factory/ui/components/skeleton";
import { cn } from "@software-factory/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CircleDotIcon, CircleIcon } from "lucide-react";
import { flowInboxQuery, flowProjectsQuery, flowWorkflowsQuery } from "../../lib/flow-queries.ts";
import { ItemPills, useItem } from "./item.tsx";
import { PageHeader } from "./parts.tsx";
import { DecisionCard, Row } from "./timeline.tsx";

/** How many of the timeline's last rows "What led here" shows. */
const LED_HERE = 3;

export type InboxTab = "needs-you" | "done";

/** What the person did from the Inbox while the app is open: the Done tab's rows. */
interface Done {
  itemId: string;
  projectId: string;
  title: string;
  number: number;
  label: string;
  at: string;
}
const DONE = new Map<string, Done[]>();

export function InboxPage({
  orgId,
  tab,
  itemId,
  onChoose,
}: {
  orgId: string;
  tab: InboxTab;
  itemId: string | undefined;
  onChoose: (next: { tab?: InboxTab; item?: string }) => void;
}) {
  const inbox = useQuery(flowInboxQuery(orgId));
  const projects = useQuery(flowProjectsQuery(orgId));
  const workflows = useQuery(flowWorkflowsQuery(orgId));
  const rows = inboxRows(inbox.data);
  const projectOf = (projectId: string) => projects.data?.projects.find((p) => p.id === projectId);
  const workflowOf = (project: FlowProject | undefined) =>
    workflows.data?.workflows.find((w) => w.id === project?.workflowId);
  const chosen = rows.find((r) => r.item.id === itemId) ?? rows[0];
  const done = DONE.get(orgId) ?? [];

  return (
    <main className="flex min-w-0 flex-1 flex-col" data-testid="inbox-page">
      <PageHeader
        title="Inbox"
        tabs={[`Needs you · ${rows.length}`, "Done"]}
        tab={tab === "done" ? "Done" : `Needs you · ${rows.length}`}
        onTab={(t) => onChoose({ tab: t === "Done" ? "done" : "needs-you" })}
      />
      <div className="min-h-0 flex-1 overflow-auto bg-board px-5 py-5">
        {tab === "done" ? (
          <DoneList orgId={orgId} done={done} projectOf={projectOf} />
        ) : inbox.error ? (
          <p className="text-bad">Couldn't load the inbox. {inbox.error.message}</p>
        ) : !inbox.data ? (
          <div className="grid w-[300px] gap-2" aria-busy="true">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : rows.length === 0 ? (
          <p className="text-ink-muted" data-testid="inbox-empty">
            Nothing needs you.
          </p>
        ) : (
          <div className="flex items-start gap-5">
            <ul
              className="w-[300px] flex-none overflow-hidden rounded-[10px] border border-line bg-panel"
              data-testid="inbox-list"
            >
              {rows.map((row) => {
                const project = projectOf(row.item.projectId);
                const status = workflowOf(project)?.workflow.statuses.find(
                  (s) => s.id === row.item.statusId,
                );
                return (
                  <InboxListRow
                    key={row.item.id}
                    row={row}
                    question={inboxQuestion(row, status?.name)}
                    itemKey={flowKey(project, row.item.number)}
                    projectName={project?.name ?? ""}
                    chosen={row.item.id === chosen?.item.id}
                    onChoose={() => onChoose({ item: row.item.id })}
                  />
                );
              })}
            </ul>
            {chosen && (
              <InboxItem
                key={chosen.item.id}
                orgId={orgId}
                itemId={chosen.item.id}
                project={projectOf(chosen.item.projectId)}
                workflow={workflowOf(projectOf(chosen.item.projectId))}
                onActed={(label) => {
                  const next = nextRow(rows, chosen.item.id);
                  DONE.set(orgId, [
                    {
                      itemId: chosen.item.id,
                      projectId: chosen.item.projectId,
                      title: chosen.item.title,
                      number: chosen.item.number,
                      label,
                      at: new Date().toISOString(),
                    },
                    ...done,
                  ]);
                  onChoose({ item: next ?? undefined });
                }}
              />
            )}
          </div>
        )}
      </div>
    </main>
  );
}

function InboxListRow({
  row,
  question,
  itemKey,
  projectName,
  chosen,
  onChoose,
}: {
  row: InboxRow;
  question: string;
  itemKey: string;
  projectName: string;
  chosen: boolean;
  onChoose: () => void;
}) {
  return (
    <li className="border-line-soft border-b last:border-b-0">
      <button
        type="button"
        onClick={onChoose}
        aria-current={chosen ? "true" : undefined}
        className={cn(
          "flex w-full items-start gap-2 px-3 py-2.5 text-left hover:bg-hover",
          chosen && "bg-work-soft hover:bg-work-soft",
        )}
        data-testid="inbox-row"
        data-kind={row.kind}
      >
        <CircleDotIcon className="mt-[3px] size-3 flex-none text-need" />
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 font-medium" data-testid="inbox-question">
            {question}
          </span>
          <span className="block truncate text-[12px] text-ink-muted">
            {itemKey}
            {projectName && ` · ${projectName}`}
          </span>
        </span>
        <time className="flex-none text-[11.5px] text-ink-faint">
          {when(row.item.updatedAt).replace(" ago", "")}
        </time>
      </button>
    </li>
  );
}

/** The chosen item, decision first. */
function InboxItem({
  orgId,
  itemId,
  project,
  workflow,
  onActed,
}: {
  orgId: string;
  itemId: string;
  project: FlowProject | undefined;
  workflow: FlowWorkflow | undefined;
  onActed: (label: string) => void;
}) {
  const view = useItem(orgId, itemId, project);
  const { item } = view;
  const led = view.rows.slice(-LED_HERE).reverse();
  const earlier = Math.max(0, view.rows.length - led.length);
  const act = async (a: Decision["actions"][number]) => {
    if (await view.act(a)) onActed(a.label);
  };

  return (
    <article
      className="min-w-0 max-w-[760px] flex-1 rounded-xl border border-line bg-panel px-5 py-[18px]"
      data-testid="inbox-item"
    >
      {view.failed ? (
        <p className="text-bad">Couldn't load this item. {view.failed.message}</p>
      ) : !item ? (
        <div className="grid gap-3" aria-busy="true">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-6 w-2/3" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : (
        <>
          <div className="text-[12px] text-ink-muted">
            {project?.name ?? ""} <span className="px-0.5">›</span> {flowKey(project, item.number)}
          </div>
          <h2 className="mt-1 mb-[9px] font-semibold text-[17px] tracking-[-0.01em]">
            {item.title}
          </h2>
          <ItemPills view={view} project={project} />
          {view.decision ? (
            <DecisionCard decision={view.decision} busy={view.busy} onAction={act} />
          ) : (
            <p className="text-ink-muted" data-testid="inbox-nothing">
              {item.error
                ? "This item stopped. Open it to retry."
                : workflow
                  ? "Nothing to decide here any more."
                  : ""}
            </p>
          )}
          {led.length > 0 && (
            <>
              <div className="mt-[18px] mb-2 font-semibold text-[12px] text-ink-muted">
                What led here
              </div>
              <div className="flex flex-col gap-[9px]" data-testid="led-here">
                {led.map((row) => (
                  <Row key={`${row.type}${row.seq}`} row={row} />
                ))}
              </div>
            </>
          )}
          <Link
            to="/flow/$orgId/p/$projectId"
            params={{ orgId, projectId: item.projectId }}
            search={{ item: item.id }}
            className="mt-3.5 inline-block text-[12.5px] text-work hover:underline"
            data-testid="whole-timeline"
          >
            Show the whole timeline{earlier > 0 ? ` (${earlier} earlier)` : ""}
          </Link>
        </>
      )}
    </article>
  );
}

function DoneList({
  orgId,
  done,
  projectOf,
}: {
  orgId: string;
  done: Done[];
  projectOf: (projectId: string) => FlowProject | undefined;
}) {
  if (done.length === 0)
    return (
      <p className="text-ink-muted" data-testid="inbox-done-empty">
        Nothing done from here yet. What you act on shows here while the app is open.
      </p>
    );
  return (
    <ul
      className="max-w-[640px] overflow-hidden rounded-[10px] border border-line bg-panel"
      data-testid="inbox-done"
    >
      {done.map((d) => (
        <li key={`${d.itemId}${d.at}`} className="border-line-soft border-b last:border-b-0">
          <Link
            to="/flow/$orgId/p/$projectId"
            params={{ orgId, projectId: d.projectId }}
            search={{ item: d.itemId }}
            className="flex items-start gap-2 px-3 py-2.5 hover:bg-hover"
          >
            <CircleIcon className="mt-[3px] size-3 flex-none fill-ok text-ok" />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">
                {d.label}: {d.title}
              </span>
              <span className="block text-[12px] text-ink-muted">
                {flowKey(projectOf(d.projectId), d.number)}
              </span>
            </span>
            <time className="flex-none text-[11.5px] text-ink-faint">{when(d.at)}</time>
          </Link>
        </li>
      ))}
    </ul>
  );
}
