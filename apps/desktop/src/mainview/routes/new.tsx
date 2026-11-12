// New work (spec 11; spec 50, design WorkNew): the title and description, the project (its workflow
// is the project's), priority, what it waits for, and what happens next: the backlog (the default)
// or straight to the factory (create and release, with the routing preview). Send calls
// workItem.create as the signed-in person, attaches any staged files (picked, dropped or pasted),
// and opens the work item.
// Ported from sf-app for spec 40 M3. Differences: staged files go up through the client door; the
// session has no email, so the Requester row falls back to the name.

import type { OpOutput } from "@software-factory/client/ops";
import { Button } from "@software-factory/ui/components/button";
import { Card } from "@software-factory/ui/components/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@software-factory/ui/components/collapsible";
import { Input } from "@software-factory/ui/components/input";
import { Kbd } from "@software-factory/ui/components/kbd";
import { RadioGroup, RadioGroupItem } from "@software-factory/ui/components/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@software-factory/ui/components/select";
import { StatusDot } from "@software-factory/ui/components/status-dot";
import { Textarea } from "@software-factory/ui/components/textarea";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AttachButton } from "../components/attach-button.tsx";
import { Field, PageArea, PageHeader, SectionTitle } from "../components/shell-list.tsx";
import { StagedAttachments, uploadStaged } from "../components/staged-attachments.tsx";
import { PRIORITIES, PRIORITY_LABEL, type Priority } from "../lib/backlog.ts";
import { OpError, op } from "../lib/op.ts";
import {
  boardsQuery,
  configQuery,
  openPullsQuery,
  projectsQuery,
  routingQuery,
} from "../lib/queries.ts";
import { useProjects, useSession } from "../lib/session.ts";
import { workLayout } from "./_work.tsx";

export const Route = createRoute({
  getParentRoute: () => workLayout,
  path: "/new",
  validateSearch: (s: Record<string, unknown>): { project?: string } =>
    typeof s.project === "string" ? { project: s.project } : {},
  loaderDeps: ({ search }) => ({ project: search.project }),
  // The project picker and the preselected project's routing preview.
  loader: async ({ context: { queryClient, session }, deps }) => {
    const projects = await queryClient
      .ensureQueryData(projectsQuery(session.orgs.map((o) => o.id)))
      .catch(() => []);
    const project = defaultProject(projects, deps.project);
    if (project) {
      await Promise.all([
        queryClient.ensureQueryData(routingQuery(project.id)).catch(() => null),
        queryClient.ensureQueryData(openPullsQuery(project.id)).catch(() => null),
      ]);
    }
  },
  component: NewWorkPage,
});

/** The project to preselect: the one asked for, else software-factory (V1's one project). */
function defaultProject(projects: { id: string; slug: string }[], wanted?: string) {
  return (
    projects.find((p) => p.id === wanted) ??
    projects.find((p) => p.slug === "software-factory") ??
    projects[0]
  );
}

function NewWorkPage() {
  const search = Route.useSearch();
  const session = useSession();
  const projects = useProjects();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [projectId, setProjectId] = useState<string | undefined>();
  const [priority, setPriority] = useState<Priority>("normal");
  const [waitsFor, setWaitsFor] = useState<string>("none");
  const [next, setNext] = useState<"backlog" | "queued">("backlog");
  const [sending, setSending] = useState(false);
  // Files to attach once the item exists (picked, dropped or pasted on this form).
  const [files, setFiles] = useState<File[]>([]);
  // One id per draft: a double send (or a retry after a dropped response) creates one item.
  const eventId = useRef(crypto.randomUUID());
  const selected = projectId ?? defaultProject(projects.data ?? [], search.project)?.id;
  const routing = useQuery({ ...routingQuery(selected ?? ""), enabled: !!selected });
  const config = useQuery({ ...configQuery(selected ?? ""), enabled: !!selected });
  const board = useQuery(boardsQuery(session.orgs.map((o) => o.id)));
  const project = projects.data?.find((p) => p.id === selected);
  const workflow = (config.data?.current?.policy as { workflow?: string | null } | null)?.workflow;
  // What it can wait for: unfinished work in the project's org (any project).
  const waitable = (board.data?.items ?? []).filter((i) => i.orgId === project?.orgId);
  const canSend = !!selected && (body.trim().length > 0 || title.trim().length > 0) && !sending;

  async function send() {
    if (!canSend || !selected) return;
    setSending(true);
    try {
      const created = await op("workItem.create", {
        projectId: selected,
        ...(title.trim() ? { title: title.trim() } : {}),
        body: body.trim(),
        source: "app",
        eventId: eventId.current,
        // The backlog, or create and release in one step (ADR 0491).
        state: next,
        priority,
        ...(waitsFor !== "none" ? { waitsFor: [waitsFor] } : {}),
      });
      if (files.length > 0) {
        const failures = await uploadStaged(created.workItemId, files);
        for (const failure of failures) toast.error(`Not attached: ${failure}`);
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["inbox"] }),
        queryClient.invalidateQueries({ queryKey: ["work"] }),
      ]);
      toast.success(
        created.outcome !== "created"
          ? "Already sent"
          : next === "backlog"
            ? `Added to the backlog as #${created.number}`
            : `Sent to the factory as #${created.number}`,
      );
      await navigate({ to: "/work/$id", params: { id: created.workItemId } });
    } catch (error) {
      toast.error(error instanceof OpError ? error.message : "Couldn't send it");
      setSending(false);
    }
  }

  useEffect(() => {
    // A fresh draft gets a fresh event id.
    if (!body) eventId.current = crypto.randomUUID();
  }, [body]);

  return (
    <PageArea className="max-w-[760px]">
      <PageHeader
        above={
          <>
            <Link to="/work" className="underline">
              Work
            </Link>{" "}
            / New
          </>
        }
        title="New work item"
        sub="Write it the way you would tell a colleague. It goes to the backlog unless you say otherwise."
      />
      <Field htmlFor="new-title" label="Title">
        <Input
          id="new-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Optional: the description's first line if you leave it empty"
          data-testid="new-work-title"
        />
      </Field>
      <Field htmlFor="new-body" label="What should change, and why">
        <Textarea
          id="new-body"
          autoFocus
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder="What should the factory build or fix?"
          className="min-h-[120px] resize-y"
          aria-label="Describe the work"
          data-testid="new-work-body"
        />
      </Field>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] items-end gap-3">
        <Field htmlFor="new-project" label="Project">
          <Select
            value={selected ?? ""}
            onValueChange={(v) => {
              setProjectId(v);
              setWaitsFor("none");
            }}
          >
            <SelectTrigger id="new-project" className="w-full" data-testid="project-picker">
              <SelectValue placeholder="No projects" />
            </SelectTrigger>
            <SelectContent>
              {(projects.data ?? []).map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                  <span className="text-ink-muted">
                    {" "}
                    · {session.orgs.find((o) => o.id === p.orgId)?.name ?? ""}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <div className="flex flex-col gap-[5px]">
          <span className="font-medium text-ink-3 text-xs">Workflow</span>
          <span className="flex h-8 items-center gap-2 text-ink-3" data-testid="new-workflow">
            <span className="truncate rounded-full bg-panel px-[7px] py-px font-medium text-[11px] text-ink-2 shadow-ring">
              {config.isPending ? "…" : (workflow ?? "The skeleton")}
            </span>
            <span className="truncate text-xs">set by the project</span>
          </span>
        </div>
        <Field htmlFor="new-priority" label="Priority">
          <Select value={priority} onValueChange={(v) => setPriority(v as Priority)}>
            <SelectTrigger id="new-priority" className="w-full" data-testid="priority-picker">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PRIORITIES.map((p) => (
                <SelectItem key={p} value={p}>
                  {PRIORITY_LABEL[p]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field htmlFor="new-waits" label="Waits for">
          <Select value={waitsFor} onValueChange={setWaitsFor}>
            <SelectTrigger id="new-waits" className="w-full" data-testid="waits-picker">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Nothing</SelectItem>
              {waitable.map((i) => (
                <SelectItem key={i.id} value={i.id}>
                  #{i.number} {i.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>
      <StagedAttachments files={files} onChange={setFiles} />
      {projects.data?.length === 0 && (
        <p className="text-ink-muted">
          There are no projects yet.{" "}
          <Link to="/setup" className="text-ink underline">
            Add one in Setup
          </Link>{" "}
          first.
        </p>
      )}
      {selected && (
        <section className="flex flex-col gap-2">
          <SectionTitle>What happens next</SectionTitle>
          <RadioGroup
            value={next}
            onValueChange={(v) => setNext(v as "backlog" | "queued")}
            className="gap-2"
            data-testid="what-next"
          >
            <NextChoice
              value="backlog"
              chosen={next}
              title="Keep it in the backlog"
              sub="Nothing runs. Sort it and release it later."
            />
            <NextChoice
              value="queued"
              chosen={next}
              title="Release it straight away"
              sub="For small, clear changes. The factory starts it when the project has room."
            />
          </RadioGroup>
          {next === "queued" && <RoutingPreview state={routing} />}
        </section>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={send} disabled={!canSend} data-testid="send-to-factory">
          {sending ? "Sending…" : next === "backlog" ? "Add to backlog" : "Send to the factory"}
          <Kbd className="bg-primary-foreground/15 text-primary-foreground">⌘↵</Kbd>
        </Button>
        <Button variant="outline" onClick={() => window.history.back()}>
          Cancel
        </Button>
      </div>
      {selected && <OpenPulls projectId={selected} />}
    </PageArea>
  );
}

/** One choice of what happens next: the whole card is its label. */
function NextChoice({
  value,
  chosen,
  title,
  sub,
}: {
  value: string;
  chosen: string;
  title: string;
  sub: string;
}) {
  const id = `next-${value}`;
  return (
    <label
      htmlFor={id}
      className={
        chosen === value
          ? "flex cursor-default items-start gap-3 rounded-[10px] bg-panel px-3.5 py-3 shadow-[0_0_0_1.5px_var(--ink)]"
          : "flex cursor-default items-start gap-3 rounded-[10px] bg-panel px-3.5 py-3 shadow-panel"
      }
    >
      <RadioGroupItem id={id} value={value} className="mt-0.5" />
      <span className="flex flex-col gap-0.5">
        <span className="font-medium">{title}</span>
        <span className="text-ink-3 text-xs">{sub}</span>
      </span>
    </label>
  );
}

/**
 * The project's open pull requests that no work item owns (spec 05): a local session's or a
 * person's PR can be attached here, so the factory verifies it and takes it to the merge gate.
 */
function OpenPulls({ projectId }: { projectId: string }) {
  const pulls = useQuery(openPullsQuery(projectId));
  const list = pulls.data?.pulls ?? [];
  if (pulls.isPending || pulls.error || list.length === 0) return null;
  return (
    <section className="grid gap-2" data-testid="open-pulls">
      <div>
        <SectionTitle>Open pull requests not in the factory</SectionTitle>
        <p className="text-muted-foreground text-xs">
          Built outside the factory? Attach it: the factory verifies its head and asks you to merge.
        </p>
      </div>
      <Card className="gap-0 divide-y py-0">
        {list.map((p) => (
          <div key={p.number} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
            <div className="min-w-0 grow">
              <div className="truncate text-sm">
                {p.title} <span className="text-muted-foreground">#{p.number}</span>
              </div>
              <div className="truncate text-muted-foreground text-xs">
                {p.author ? `${p.author} · ` : ""}
                <span className="font-mono">{p.branch}</span>
                {p.refusal ? ` · can't attach: ${p.refusal}` : ""}
              </div>
            </div>
            {!p.refusal && (
              <AttachButton projectId={projectId} prNumber={p.number} label="Attach" size="sm" />
            )}
          </div>
        ))}
      </Card>
    </section>
  );
}

function RoutingPreview({
  state,
}: {
  state: { data?: OpOutput<"workItem.previewRouting">; isPending: boolean; error: Error | null };
}) {
  const session = useSession();
  if (state.isPending)
    return <div className="text-muted-foreground text-sm">Working out where it runs…</div>;
  if (state.error || !state.data) {
    return (
      <div className="text-destructive text-sm">
        Can't preview routing: {state.error?.message ?? "unknown"}
      </div>
    );
  }
  const r = state.data;
  const runner = r.runner;
  const gateSummary = r.gates.join(" · ");
  // The one-line form from the mockup: "spec if medium+ · merge: you".
  const shortGates = r.gates
    .map((g) =>
      g
        .replace(/^spec gate from (\w+) size$/, "spec if $1+")
        .replace(/^merge gate.*$/, "merge: you"),
    )
    .join(" · ");
  return (
    <Collapsible
      className="group min-w-0 rounded-[10px] bg-panel px-3.5 py-3 shadow-panel"
      data-testid="routing-preview"
    >
      <CollapsibleTrigger className="flex w-full items-center gap-2 truncate text-left">
        <StatusDot status={runner && !r.waitReason ? "done" : "waiting"} />
        <span className="min-w-0 truncate">
          Runs on {runner ? <span className="font-mono">{runner.name}</span> : "no runner yet"} ·
          Claude Code · {r.waitReason ? `${r.waitReason} · ` : ""}
          {shortGates}
        </span>
        <span className="ml-auto shrink-0 text-ink-muted text-xs group-data-[state=open]:hidden">
          Details ▾
        </span>
        <span className="ml-auto hidden shrink-0 text-ink-muted text-xs group-data-[state=open]:inline">
          Details ▴
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <table className="mt-3 w-full">
          <tbody className="[&_td]:py-1.5 [&_td:first-child]:w-28 [&_td:first-child]:text-muted-foreground">
            <tr>
              <td>Requester</td>
              <td>you ({session.user.githubLogin ?? session.user.name})</td>
            </tr>
            <tr>
              <td>Runner</td>
              <td>
                {runner ? (
                  <>
                    <span className="font-mono">{runner.name}</span> ·{" "}
                    {runner.ownerUserId === session.user.id ? "yours" : "shared"} ·{" "}
                    {runner.freeSlots} of {runner.max} slots free
                  </>
                ) : (
                  "none can take it now"
                )}
                <span className="text-muted-foreground"> · fallback: queue</span>
                {r.candidates.some((c) => c.refusal) && (
                  <div className="text-muted-foreground text-xs">
                    {r.candidates
                      .filter((c) => c.refusal)
                      .map((c) => `${c.name}: ${c.refusal}`)
                      .join(" · ")}
                  </div>
                )}
              </td>
            </tr>
            <tr>
              <td>Harness</td>
              <td>
                Claude Code (role implement: <span className="font-mono">{r.models.implement}</span>
                ) · reviewer: role review (<span className="font-mono">{r.models.review}</span>)
                {r.models.sameModel ? (
                  <span className="text-status-waiting"> · same model as the implementer</span>
                ) : (
                  " · a different model"
                )}
              </td>
            </tr>
            <tr>
              <td>Gates</td>
              <td>{gateSummary}</td>
            </tr>
          </tbody>
        </table>
      </CollapsibleContent>
    </Collapsible>
  );
}
