// New work (spec 11, mockup new-work): a chat-style box, a project picker and the routing preview.
// Send calls workItem.create as the signed-in person, attaches any staged files (picked, dropped or
// pasted), and opens the work item.
import { Button } from "@software-factory/ui/components/button";
import { Card } from "@software-factory/ui/components/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@software-factory/ui/components/collapsible";
import { Kbd } from "@software-factory/ui/components/kbd";
import { StatusDot } from "@software-factory/ui/components/status-dot";
import { Textarea } from "@software-factory/ui/components/textarea";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AttachButton } from "#/components/attach-button";
import { OptionSelect } from "#/components/option-select";
import { StagedAttachments, uploadStaged } from "#/components/staged-attachments";
import { op } from "#/lib/op";
import { OpError, type OpOutput } from "#/lib/ops";
import { openPullsQuery, projectsQuery, routingQuery } from "#/lib/queries";
import { useProjects, useSession } from "#/lib/session";

export const Route = createFileRoute("/_app/new")({
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
  const [body, setBody] = useState("");
  const [projectId, setProjectId] = useState<string | undefined>();
  const [sending, setSending] = useState(false);
  // Files to attach once the item exists (picked, dropped or pasted on this form).
  const [files, setFiles] = useState<File[]>([]);
  // One id per draft: a double send (or a retry after a dropped response) creates one item.
  const eventId = useRef(crypto.randomUUID());
  const selected = projectId ?? defaultProject(projects.data ?? [], search.project)?.id;
  const routing = useQuery({ ...routingQuery(selected ?? ""), enabled: !!selected });
  const canSend = !!selected && body.trim().length > 0 && !sending;

  async function send() {
    if (!canSend || !selected) return;
    setSending(true);
    try {
      const created = await op("workItem.create", {
        projectId: selected,
        body: body.trim(),
        source: "app",
        eventId: eventId.current,
      });
      if (files.length > 0) {
        const failures = await uploadStaged(created.workItemId, files);
        for (const failure of failures) toast.error(`Not attached: ${failure}`);
      }
      await queryClient.invalidateQueries({ queryKey: ["inbox"] });
      toast.success(
        created.outcome === "created"
          ? `Sent to the factory as #${created.number}`
          : "Already sent",
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
    <main className="mx-auto grid w-full grid-cols-[minmax(0,1fr)] max-w-[860px] gap-4 p-4 md:p-6">
      <div>
        <h1 className="font-semibold text-2xl tracking-tight">New work</h1>
        <p className="text-muted-foreground text-sm">
          Describe it like you would to a colleague. Triage will size it, ask questions and decide
          if it needs a spec.
        </p>
      </div>
      <Card className="gap-0 py-0">
        <Textarea
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
          className="min-h-40 resize-y rounded-b-none border-0 px-4 py-3 text-[15px] shadow-none focus-visible:ring-0"
          aria-label="Describe the work"
          data-testid="new-work-body"
        />
        <div className="flex flex-wrap items-center gap-2 border-t px-3 py-2">
          <OptionSelect
            aria-label="Project"
            data-testid="project-picker"
            placeholder="No projects"
            disabled={projects.data?.length === 0}
            value={selected ?? ""}
            options={(projects.data ?? []).map((p) => ({ value: p.id, label: p.name }))}
            onChange={setProjectId}
          />
          <span className="text-muted-foreground text-xs">
            {session.orgs.find((o) => o.id === session.personalOrgId)?.name ?? "Personal"}
          </span>
          <span className="grow" />
          <Button onClick={send} disabled={!canSend} data-testid="send-to-factory">
            {sending ? "Sending…" : "Send to factory"}
            <Kbd className="bg-primary-foreground/15 text-primary-foreground">⌘↵</Kbd>
          </Button>
        </div>
        <div className="border-t px-3 py-2">
          <StagedAttachments files={files} onChange={setFiles} />
        </div>
      </Card>
      {projects.data?.length === 0 && (
        <p className="text-muted-foreground text-sm">
          There are no projects yet.{" "}
          <Link to="/setup" className="underline">
            Add software-factory
          </Link>{" "}
          first.
        </p>
      )}
      {selected && <RoutingPreview state={routing} />}
      {selected && <OpenPulls projectId={selected} />}
      <p className="text-muted-foreground text-xs">
        Or from anywhere (after V1): <span className="font-mono">@factory</span> in Slack or Linear,
        a GitHub label, or a local Claude session.
      </p>
    </main>
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
        <h2 className="font-medium text-sm">Open pull requests not in the factory</h2>
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
      className="group/collapsible min-w-0 rounded-lg border px-4 py-3 text-sm"
      data-testid="routing-preview"
    >
      <CollapsibleTrigger className="flex cursor-pointer items-center gap-2 truncate w-full text-left">
        <StatusDot status={runner && !r.waitReason ? "done" : "waiting"} />
        <span className="min-w-0 truncate">
          Runs on {runner ? <span className="font-mono">{runner.name}</span> : "no runner yet"} ·
          Claude Code · {r.waitReason ? `${r.waitReason} · ` : ""}
          {shortGates}
        </span>
        <span className="ml-auto shrink-0 text-muted-foreground text-xs group-data-[state=open]/collapsible:hidden">
          Details ▾
        </span>
        <span className="ml-auto hidden shrink-0 text-muted-foreground text-xs group-data-[state=open]/collapsible:inline">
          Details ▴
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <table className="mt-3 w-full text-sm">
          <tbody className="[&_td]:py-1.5 [&_td:first-child]:w-28 [&_td:first-child]:text-muted-foreground">
            <tr>
              <td>Requester</td>
              <td>you ({session.user.githubLogin ?? session.user.email})</td>
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
