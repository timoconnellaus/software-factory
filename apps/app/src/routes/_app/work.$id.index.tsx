// Work item detail (spec 13, mockups work-item and planning): stage steps, then Timeline, Planning,
// Live (spec 31: the run as it goes, and steering), Runs and Review packet tabs, with acceptance
// criteria and details beside them.

import {
  ago,
  capitalise,
  duration,
  errorMessage,
  STAGE_LABEL,
} from "@software-factory/client/format";
import { parsePacket } from "@software-factory/client/packet";
import { agentTime, stageSteps, statusOf, yourTime } from "@software-factory/client/work-item";
import { Button } from "@software-factory/ui/components/button";
import { Card } from "@software-factory/ui/components/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@software-factory/ui/components/dialog";
import { Skeleton } from "@software-factory/ui/components/skeleton";
import { StatusBadge, StatusDot } from "@software-factory/ui/components/status-dot";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@software-factory/ui/components/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@software-factory/ui/components/tabs";
import { cn } from "@software-factory/ui/lib/utils";
import { useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import { Attachments } from "#/components/attachments";
import { LiveRun } from "#/components/live-run";
import { Planning } from "#/components/planning";
import { ReviewPacket } from "#/components/review-packet";
import { Timeline } from "#/components/timeline";
import { op } from "#/lib/op";
import { OpError, type WorkItemDetail } from "#/lib/ops";
import {
  attachmentsQuery,
  liveQuery,
  planningQuery,
  runnersQuery,
  timelineQuery,
  useRefreshAfterDecision,
  workItemQuery,
} from "#/lib/queries";
import { useProjects, useSession } from "#/lib/session";

const TABS = ["timeline", "planning", "live", "runs", "review"] as const;
type Tab = (typeof TABS)[number];

export const Route = createFileRoute("/_app/work/$id/")({
  validateSearch: (s: Record<string, unknown>): { tab?: Tab } =>
    TABS.includes(s.tab as Tab) ? { tab: s.tab as Tab } : {},
  // Everything the page renders, in one request: the item (with its spec, questions, gates, runs
  // and packet), its timeline, the runners (for runner names), the planning view (spec 20) and the
  // latest run's live view (spec 31).
  loader: ({ context: { queryClient }, params }) =>
    Promise.all([
      queryClient.ensureQueryData(workItemQuery(params.id)),
      queryClient.ensureQueryData(timelineQuery(params.id)).catch(() => null),
      queryClient.ensureQueryData(runnersQuery()).catch(() => null),
      queryClient.ensureQueryData(attachmentsQuery(params.id)).catch(() => null),
      queryClient.ensureQueryData(planningQuery(params.id)).catch(() => null),
      queryClient.ensureQueryData(liveQuery(queryClient, params.id)).catch(() => null),
    ]),
  pendingComponent: () => (
    <Page>
      <Skeleton className="h-6 w-60" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-64 w-full" />
    </Page>
  ),
  errorComponent: WorkItemError,
  component: WorkItemPage,
});

function WorkItemError({ error }: { error: unknown }) {
  // An OpError keeps its code across the server render (it is an own property).
  const code = (error as { code?: unknown } | null)?.code;
  const notFound = code === "not_found" || code === "forbidden";
  return (
    <Page>
      <h1 className="font-semibold text-2xl tracking-tight">
        {notFound ? "Work item not found" : "Couldn't load this work item"}
      </h1>
      <p className="text-muted-foreground text-sm">
        {notFound ? "It doesn't exist, or it isn't in one of your orgs." : errorMessage(error)}{" "}
        <Link to="/" className="underline">
          Back to the inbox
        </Link>
      </p>
    </Page>
  );
}

function WorkItemPage() {
  const { id } = Route.useParams();
  const { tab } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const { data: d } = useSuspenseQuery(workItemQuery(id));
  const timeline = useQuery(timelineQuery(id));
  const me = useSessionId();

  const hasQuestions =
    d.questions.some((q) => q.status === "open") ||
    d.gates.some((g) => g.kind === "spec" && g.status === "pending");
  const running = d.runs.some((r) => !r.endedAt);
  const current: Tab =
    tab ??
    (d.reviewPacket && d.item.stage === "merge"
      ? "review"
      : hasQuestions
        ? "planning"
        : running
          ? "live"
          : "timeline");

  return (
    <Page>
      <Header detail={d} />
      <StageSteps detail={d} />
      <WorkflowLine detail={d} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <Tabs
          value={current}
          onValueChange={(t) => navigate({ search: { tab: t as Tab }, replace: true })}
          className="min-w-0"
        >
          <TabsList>
            <TabsTrigger value="timeline">Timeline</TabsTrigger>
            <TabsTrigger value="planning">
              Planning
              {hasQuestions && <StatusDot status="waiting" className="ml-1" />}
            </TabsTrigger>
            <TabsTrigger value="live" data-testid="live-tab">
              Live
              {running && <StatusDot status="running" className="ml-1" />}
            </TabsTrigger>
            <TabsTrigger value="runs">Runs</TabsTrigger>
            <TabsTrigger value="review">Review packet</TabsTrigger>
          </TabsList>
          <TabsContent value="timeline">
            <Card className="px-5 py-4">
              {timeline.data ? (
                <Timeline entries={timeline.data.entries} gates={d.gates} me={me} />
              ) : (
                <Skeleton className="h-24 w-full" />
              )}
            </Card>
          </TabsContent>
          <TabsContent value="planning">
            <Planning detail={d} />
          </TabsContent>
          <TabsContent value="live">{current === "live" && <LiveRun detail={d} />}</TabsContent>
          <TabsContent value="runs">
            <Runs detail={d} />
          </TabsContent>
          <TabsContent value="review">
            <ReviewPacket detail={d} />
          </TabsContent>
        </Tabs>
        <Aside detail={d} />
      </div>
    </Page>
  );
}

function useSessionId() {
  return useSession().user.id;
}

function Header({ detail }: { detail: WorkItemDetail }) {
  const { item } = detail;
  const session = useSession();
  const projects = useProjects();
  const runners = useQuery(runnersQuery());
  const project = projects.data?.find((p) => p.id === item.projectId);
  const lastRun = detail.runs.at(-1);
  const runnerName = lastRun
    ? (runners.data?.runners.find((r) => r.id === lastRun.runnerId)?.name ?? lastRun.runnerId)
    : null;
  const takeover = [...detail.runs].reverse().find((r) => r.takeover)?.takeover ?? null;
  const [showTakeover, setShowTakeover] = useState(false);
  const [cancel, setCancel] = useState(false);
  const active = ["running", "waiting", "paused"].includes(item.status);
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
        <StatusBadge status={statusOf(detail)} className="text-foreground">
          {STAGE_LABEL[item.stage] ?? item.stage}
          {item.status !== "running" && ` · ${item.status}`}
        </StatusBadge>
        <span>
          {session.orgs.find((o) => o.id === item.orgId)?.name ?? "Personal"} ·{" "}
          {project?.name ?? "project"} · <span className="font-mono">#{item.number}</span>
        </span>
        {item.kind === "incident" && (
          <span className="rounded-md border px-1.5">factory incident</span>
        )}
        {item.kind === "attached" && <span className="rounded-md border px-1.5">attached PR</span>}
        {detail.mergeQueue && (
          <span className="rounded-md border px-1.5" data-testid="merge-queue">
            {detail.mergeQueue.position === 1
              ? "Landing: next in the merge queue"
              : `Queued to merge: behind ${detail.mergeQueue.ahead.map((n) => `#${n}`).join(", ")}`}
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="font-semibold text-2xl tracking-tight" data-testid="work-item-title">
            {item.title}
          </h1>
          <div className="text-muted-foreground text-sm">
            Requested by {item.requesterUserId === session.user.id ? "you" : "someone else"} · from{" "}
            {item.source} · {ago(item.createdAt)}
            {runnerName && (
              <>
                {" "}
                · runs on <span className="font-mono">{runnerName}</span>
              </>
            )}
            {item.statusReason && ` · ${item.statusReason}`}
          </div>
        </div>
        <div className="flex gap-2">
          {takeover && (
            <Button variant="outline" onClick={() => setShowTakeover((v) => !v)}>
              Take over locally
            </Button>
          )}
          {active && (detail.viewer.isRequester || detail.viewer.isApprover) && (
            <Button variant="outline" onClick={() => setCancel(true)} data-testid="cancel">
              Cancel
            </Button>
          )}
        </div>
      </div>
      {takeover && showTakeover && (
        <Card className="gap-1 px-4 py-3 text-sm">
          <div className="font-medium">{takeover.label}</div>
          <div className="whitespace-pre-wrap font-mono text-muted-foreground text-xs">
            {takeover.hint}
          </div>
        </Card>
      )}
      <CancelDialog open={cancel} onOpenChange={setCancel} workItemId={item.id} />
    </div>
  );
}

function CancelDialog({
  open,
  onOpenChange,
  workItemId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  workItemId: string;
}) {
  const refresh = useRefreshAfterDecision();
  const [busy, setBusy] = useState(false);
  async function confirm() {
    setBusy(true);
    try {
      const r = await op("workItem.cancel", { workItemId, reason: "cancelled from the app" });
      toast.success(r.cancelled ? "Cancelled" : "It had already finished");
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof OpError ? error.message : "Couldn't cancel");
    } finally {
      setBusy(false);
      await refresh(workItemId);
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cancel this work item?</DialogTitle>
          <DialogDescription>
            Its Workflow and runs stop, its runner slot is freed and its open gates close. This
            can't be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Keep it
          </Button>
          <Button
            variant="destructive"
            disabled={busy}
            onClick={confirm}
            data-testid="confirm-cancel"
          >
            Cancel work item
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StageSteps({ detail }: { detail: WorkItemDetail }) {
  const steps = stageSteps(detail);
  return (
    <div className="flex flex-wrap items-center gap-1 text-xs" data-testid="stage-steps">
      {steps.map((s, i) => (
        <span key={s.stage} className="inline-flex items-center gap-1">
          {i > 0 && <span className="text-muted-foreground">›</span>}
          <span
            data-state={s.state}
            title={s.reason ?? undefined}
            className={cn(
              "rounded-full border px-2 py-0.5 text-muted-foreground",
              s.gate && "border-dashed",
              s.state === "done" && "border-solid bg-secondary text-foreground",
              s.state === "now" && "border-solid border-status-running font-medium text-foreground",
              s.state === "failed" && "border-solid border-status-failed text-foreground",
              s.state === "skipped" && "line-through",
            )}
          >
            {STAGE_LABEL[s.stage]}
            {s.state === "done" && " ✓"}
          </span>
        </span>
      ))}
      {steps
        .filter((s) => s.state === "skipped")
        .map((s) => (
          <span key={s.stage} className="ml-2 text-muted-foreground" data-testid="skip-reason">
            {STAGE_LABEL[s.stage]} skipped: {s.reason}
          </span>
        ))}
    </div>
  );
}

function Runs({ detail }: { detail: WorkItemDetail }) {
  const runners = useQuery(runnersQuery());
  if (detail.runs.length === 0) {
    return <Card className="px-5 py-6 text-muted-foreground text-sm">No runs yet.</Card>;
  }
  return (
    <Card className="gap-0 overflow-x-auto py-0">
      <Table className="w-full text-sm" data-testid="runs">
        <TableHeader>
          <TableRow className="text-left text-muted-foreground text-xs">
            <TableHead className="px-4 py-2.5 font-medium">Run</TableHead>
            <TableHead className="px-2 py-2.5 font-medium">Stage</TableHead>
            <TableHead className="px-2 py-2.5 font-medium">Runner</TableHead>
            <TableHead className="px-2 py-2.5 font-medium">Branch</TableHead>
            <TableHead className="px-2 py-2.5 font-medium">Time</TableHead>
            <TableHead className="px-4 py-2.5 font-medium">Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {detail.runs.map((r) => (
            <TableRow key={r.id} className="border-t align-top">
              <TableCell className="px-4 py-2.5 font-mono text-xs">#{r.runNo}</TableCell>
              <TableCell className="px-2 py-2.5">{capitalise(r.stage)}</TableCell>
              <TableCell className="whitespace-normal px-2 py-2.5 font-mono text-xs">
                {runners.data?.runners.find((x) => x.id === r.runnerId)?.name ?? r.runnerId}
                <div className="font-sans text-muted-foreground">Claude Code</div>
              </TableCell>
              <TableCell
                className="max-w-56 truncate px-2 py-2.5 font-mono text-xs"
                title={r.branch}
              >
                {r.branch}
              </TableCell>
              <TableCell className="whitespace-nowrap px-2 py-2.5 text-xs">
                {duration(
                  (r.endedAt ? Date.parse(r.endedAt) : Date.now()) - Date.parse(r.startedAt),
                )}
              </TableCell>
              <TableCell className="whitespace-normal px-4 py-2.5 text-xs">
                <span className="inline-flex items-center gap-1.5">
                  <StatusDot
                    status={
                      r.endedAt
                        ? r.outcome === "succeeded" || r.outcome === "ok"
                          ? "done"
                          : "failed"
                        : "running"
                    }
                  />
                  {r.outcome ?? r.status}
                </span>
                {r.summary && <div className="mt-1 text-muted-foreground">{r.summary}</div>}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}

function Aside({ detail }: { detail: WorkItemDetail }) {
  const me = useSessionId();
  const session = useSession();
  const role = session.orgs.find((o) => o.id === detail.item.orgId)?.role;
  const runners = useQuery(runnersQuery());
  const packet = detail.reviewPacket ? parsePacket(detail.reviewPacket) : null;
  const criteria = detail.spec?.acceptanceCriteria ?? [];
  const lastRun = detail.runs.at(-1);
  return (
    <div className="grid content-start gap-4">
      <Card className="gap-2 px-5 py-4" data-testid="criteria">
        <div className="font-semibold">Acceptance criteria</div>
        {criteria.length === 0 && (
          <div className="text-muted-foreground text-sm">None yet: they come with the spec.</div>
        )}
        {criteria.map((c) => {
          const checked = packet?.criteria.find((p) => p.criterion === c);
          return (
            <div key={c} className="flex items-start gap-2 text-sm">
              <StatusDot
                status={checked ? (checked.met ? "done" : "failed") : "idle"}
                className="mt-1.5"
              />
              <span>{c}</span>
            </div>
          );
        })}
      </Card>
      <Card className="gap-0 px-5 py-4">
        <div className="mb-2 font-semibold">Details</div>
        <table className="text-sm">
          <tbody className="[&_td]:py-1 [&_td:first-child]:pr-4 [&_td:first-child]:text-muted-foreground">
            <tr>
              <td>Policy</td>
              <td>
                {detail.policy ? (
                  <span className="font-mono text-xs">{detail.policy.autonomyPolicy}</span>
                ) : (
                  "none synced"
                )}
              </td>
            </tr>
            <tr>
              <td>Approvers</td>
              <td>
                {detail.approvers.users
                  .map((u) => (u.id === me ? "you" : (u.githubLogin ?? u.name)))
                  .join(", ") || "nobody"}
              </td>
            </tr>
            <tr>
              <td>Runner</td>
              <td className="font-mono text-xs">
                {lastRun
                  ? (runners.data?.runners.find((r) => r.id === lastRun.runnerId)?.name ??
                    lastRun.runnerId)
                  : "—"}
              </td>
            </tr>
            <tr>
              <td>Branch</td>
              <td className="max-w-40 truncate font-mono text-xs" title={detail.item.branch}>
                {detail.item.branch}
              </td>
            </tr>
            <tr>
              <td>Agent time</td>
              <td>{duration(agentTime(detail)) || "0s"}</td>
            </tr>
            <tr>
              <td>Your time</td>
              <td data-testid="your-time">{duration(yourTime(detail, me)) || "0s"}</td>
            </tr>
            {detail.item.prUrl && (
              <tr>
                <td>PR</td>
                <td>
                  <a
                    href={detail.item.prUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="underline"
                  >
                    #{detail.item.prNumber}
                  </a>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
      <Attachments
        workItemId={detail.item.id}
        meId={me}
        isAdmin={role === "owner" || role === "admin"}
      />
    </div>
  );
}

function Page({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto grid w-full grid-cols-[minmax(0,1fr)] max-w-[1200px] gap-4 p-4 md:p-6">
      {children}
    </main>
  );
}

/**
 * The workflow the item follows: its project's, pinned when its pipeline started (ADR 0492). There
 * is no per-item override, so it is shown, not chosen; the project's workflow is set in Settings.
 */
function WorkflowLine({ detail }: { detail: WorkItemDetail }) {
  const { item, workflows } = detail;
  if (workflows.length === 0 && !item.workflow) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="work-item-workflow">
      <span className="text-muted-foreground">Workflow</span>
      <span className="font-medium">{item.workflow ?? "The skeleton alone"}</span>
      {item.workflowReason && (
        <span className="text-muted-foreground text-xs">{item.workflowReason}</span>
      )}
    </div>
  );
}
