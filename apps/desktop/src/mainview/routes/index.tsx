// Home is the Inbox (spec 12; restyled for spec 41, design InboxMerge/InboxQuestion): the nested
// list of what waits on you (merges, specs, questions, approvals, notices), and the selected one's
// page with its decision. Unfinished setup isn't here: it is the orange dot on Settings. `/?item=<key>` selects one (a work item id for anything on an item, as
// `sf://` links send); without it, the first is selected.

import { errorMessage } from "@software-factory/client/format";
import { gateWorkItemIds } from "@software-factory/client/inbox";
import { Skeleton } from "@software-factory/ui/components/skeleton";
import { StatusDot } from "@software-factory/ui/components/status-dot";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createRoute, Link } from "@tanstack/react-router";
import {
  GateDetail,
  PlanningDetail,
  QuestionDetail,
  ReleaseFlagDetail,
} from "../components/inbox-cards.tsx";
import { ProtectionChangedCard } from "../components/protection-card.tsx";
import { ListGroup, ListItem, NestedList, PageArea } from "../components/shell-list.tsx";
import { useScopedInbox } from "../components/shell-sidebar.tsx";
import { entryText, GROUP_ORDER, inboxEntries, selectedEntry } from "../lib/inbox-list.ts";
import { inboxQuery, workItemQuery, workListsQuery } from "../lib/queries.ts";
import { useProjects, useSession } from "../lib/session.ts";
import { appRoute } from "./_app.tsx";

export const Route = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  validateSearch: (s: Record<string, unknown>): { item?: string } =>
    typeof s.item === "string" ? { item: s.item } : {},
  // Everything the page renders, in one request: the inbox, the work lists (item numbers) and the
  // work items behind the gates.
  loader: async ({ context: { queryClient, session } }) => {
    const [inbox] = await Promise.all([
      queryClient.ensureQueryData(inboxQuery()),
      queryClient.ensureQueryData(workListsQuery(session.orgs.map((o) => o.id))).catch(() => null),
    ]);
    await Promise.all(
      gateWorkItemIds(inbox).map((id) =>
        queryClient.ensureQueryData(workItemQuery(id)).catch(() => null),
      ),
    );
  },
  pendingComponent: InboxPending,
  errorComponent: ({ error }) => (
    <PageArea>
      <h1 className="m-0 font-semibold text-[18px]">Inbox</h1>
      <p className="text-destructive">Couldn't load the inbox: {errorMessage(error)}</p>
    </PageArea>
  ),
  component: InboxPage,
});

function InboxPage() {
  const { item } = Route.useSearch();
  const session = useSession();
  useSuspenseQuery(inboxQuery());
  const { inbox } = useScopedInbox();
  const work = useQuery(workListsQuery(session.orgs.map((o) => o.id)));
  const projects = useProjects();
  const projectName = (id: string | null) =>
    projects.data?.find((p) => p.id === id)?.name ?? (id ? "project" : "the factory");
  const numberOf = (id: string) => work.data?.find((i) => i.id === id)?.number ?? null;

  const entries = inbox ? inboxEntries(inbox) : [];
  const selected = selectedEntry(entries, item);
  const gone = !!item && !entries.some((e) => e.key === item);

  return (
    <>
      <NestedList title="Inbox">
        {GROUP_ORDER.map((group) => {
          const rows = entries.filter((e) => e.group === group);
          if (rows.length === 0) return null;
          return (
            <div key={group} className="contents">
              <ListGroup>{group}</ListGroup>
              {rows.map((e) => {
                const t = entryText(e, numberOf);
                return (
                  <ListItem
                    key={e.key}
                    to="/"
                    search={{ item: e.key }}
                    active={selected?.key === e.key && !gone}
                    sub={
                      <>
                        <StatusDot status={t.status} />
                        <span className="truncate">{t.sub}</span>
                      </>
                    }
                    data-testid={`inbox-row-${e.key}`}
                  >
                    {t.title}
                  </ListItem>
                );
              })}
            </div>
          );
        })}
        {entries.length === 0 && (
          <p className="px-2 py-1 text-ink-muted text-xs">Nothing waits on you.</p>
        )}
      </NestedList>
      <PageArea>
        {gone && (
          <div
            className="rounded-[10px] bg-panel px-3.5 py-3 shadow-panel"
            role="status"
            data-testid="already-decided"
          >
            That item is no longer waiting on you: it has already been decided.{" "}
            <Link to="/work/$id" params={{ id: item }} className="underline">
              Open the work item
            </Link>
          </div>
        )}
        {!selected && !gone && (
          <div
            className="flex flex-col items-center gap-1 py-20 text-center"
            data-testid="inbox-empty"
          >
            <div className="font-semibold text-[15px]">Nothing is waiting on you</div>
            <div className="text-ink-muted">
              Merges, specs and questions show up here.{" "}
              <Link to="/new" className="text-ink underline">
                Send new work
              </Link>
            </div>
          </div>
        )}
        {selected && !gone && (
          <>
            {selected.kind === "gate" && (
              <GateDetail gate={selected.gate} projectName={projectName(selected.gate.projectId)} />
            )}
            {selected.kind === "question" && (
              <QuestionDetail
                question={selected.question}
                number={numberOf(selected.question.workItemId)}
                projectName={projectName(selected.question.projectId)}
              />
            )}
            {selected.kind === "planning" && (
              <PlanningDetail
                planning={selected.planning}
                projectName={projectName(selected.planning.projectId)}
              />
            )}
            {selected.kind === "release" && (
              <ReleaseFlagDetail
                flag={selected.flag}
                projectName={projectName(selected.flag.projectId)}
              />
            )}
            {selected.kind === "protection" && <ProtectionChangedCard drift={selected.drift} />}
          </>
        )}
      </PageArea>
    </>
  );
}

function InboxPending() {
  return (
    <>
      <NestedList title="Inbox">
        <Skeleton className="mx-2 my-2 h-10" />
        <Skeleton className="mx-2 my-2 h-10" />
      </NestedList>
      <PageArea>
        <Skeleton className="h-8 w-60" />
        <Skeleton className="h-40 w-full" />
      </PageArea>
    </>
  );
}
