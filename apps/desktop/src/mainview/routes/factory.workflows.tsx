// Factory: Workflows (spec 41, slice 5; design FactoryWorkflow). The project's named workflows
// (ADR 0371) and the one it runs (ADR 0492), then that workflow's stages: the fixed skeleton with
// the steps its three slots add, from `config.get`. Edit workflows (`?edit=1`) edits them in the app
// (ADR 0610): saved with the rest of the config, a loosening waits for an approver.
// Stage types and shaping stages (spec 52) are design only, so the stages are the skeleton's.
import { StatusDot } from "@software-factory/ui/components/status-dot";
import { cn } from "@software-factory/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { createRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { SaveBar, UnsavedGuard, useConfigDraft } from "../components/config-editor.tsx";
import {
  ConfigFooter,
  ConfigState,
  configProjectId,
  EditToggle,
  editSearch,
  PendingChanges,
  ProjectPicker,
  projectSearch,
  useProjectConfig,
} from "../components/config-parts.tsx";
import { Cell, Empty, Row, TablePanel, WIDE } from "../components/data-table.tsx";
import { Chip, PageArea, PageHeader, Panel, SectionTitle } from "../components/shell-list.tsx";
import { WorkflowsForm } from "../components/workflow-form.tsx";
import { type StepView, skeleton, type WorkflowView, workflowList } from "../lib/config-view.ts";
import { configQuery, orgWorkflowsQuery } from "../lib/factory-queries.ts";
import { projectsQuery } from "../lib/queries.ts";
import { factoryLayout } from "./_factory.tsx";

interface Search {
  project?: string;
  edit?: boolean;
  workflow?: string;
}

export const Route = createRoute({
  getParentRoute: () => factoryLayout,
  path: "/factory/workflows",
  validateSearch: (s: Record<string, unknown>): Search => ({
    ...projectSearch(s),
    ...editSearch(s),
    ...(typeof s.workflow === "string" ? { workflow: s.workflow } : {}),
  }),
  loaderDeps: ({ search }) => ({ project: search.project, edit: !!search.edit }),
  loader: async ({ context, deps }) => {
    const id = await configProjectId(context, deps.project);
    if (!id) return;
    const q = context.queryClient;
    const orgId = context.session.orgs.length
      ? (
          await q
            .ensureQueryData(projectsQuery(context.session.orgs.map((o) => o.id)))
            .catch(() => [])
        ).find((p) => p.id === id)?.orgId
      : undefined;
    await Promise.all([
      q.ensureQueryData(configQuery(id)),
      // The org's workflows the project may run, only when editing.
      ...(deps.edit && orgId ? [q.ensureQueryData(orgWorkflowsQuery(orgId))] : []),
    ]).catch(() => null);
  },
  component: WorkflowsPage,
});

function WorkflowsPage() {
  const search = Route.useSearch();
  const { projects, project, projectsRead, config } = useProjectConfig(search.project);
  const doc = config.data?.current?.policy ?? null;
  const editing = !!search.edit && !!doc;
  const workflows = doc ? workflowList(doc) : [];
  const running = workflows.find((w) => w.current) ?? null;
  const shown =
    workflows.find((w) => w.name === search.workflow) ?? running ?? workflows[0] ?? null;
  return (
    <PageArea>
      <PageHeader
        above={project?.name}
        title="Workflows"
        sub="A workflow fills the factory's fixed stages with steps of its own. Spec approval, verify and the merge gate always come from the factory. A project runs one workflow."
        actions={
          <>
            <ProjectPicker projects={projects} project={project} from="/factory/workflows" />
            {doc && (
              <EditToggle
                from="/factory/workflows"
                projectId={project?.id}
                editing={editing}
                label="Edit workflows"
              />
            )}
          </>
        }
      />
      <ConfigState projectsRead={projectsRead} project={project} config={config} />
      {project && config.data && <PendingChanges config={config.data} projectId={project.id} />}
      {editing && project && (
        // Keyed by the project: another project's page starts with no draft.
        <WorkflowsEditing
          key={project.id}
          projectId={project.id}
          orgId={project.orgId}
          initial={shown?.name ?? null}
        />
      )}
      {doc && !editing && (
        <>
          {workflows.length === 0 ? (
            <Empty>
              The project has no workflows of its own: every item runs the stages below.
            </Empty>
          ) : (
            <TablePanel
              head={["Workflow", { label: "What it is for", className: WIDE }, "Steps", "Runs"]}
              data-testid="workflows"
            >
              {workflows.map((w) => (
                <Row
                  key={w.name}
                  aria-current={w.name === shown?.name ? "true" : undefined}
                  className={cn(w.name === shown?.name && workflows.length > 1 && "bg-selected/60")}
                >
                  <Cell className="font-medium">
                    <Link
                      to="/factory/workflows"
                      search={{ ...(project ? { project: project.id } : {}), workflow: w.name }}
                      className="hover:underline"
                    >
                      {w.name}
                    </Link>
                  </Cell>
                  <Cell className={cn("max-w-[320px] whitespace-normal text-ink-3", WIDE)}>
                    {w.description}
                  </Cell>
                  <Cell className="tabular-nums">{w.stepCount}</Cell>
                  <Cell>{w.current ? <Chip tone="green">This project</Chip> : ""}</Cell>
                </Row>
              ))}
            </TablePanel>
          )}
          <SectionTitle
            note={
              shown
                ? shown.current
                  ? "The workflow this project runs."
                  : "Not the one this project runs."
                : "The factory's own stages."
            }
          >
            {shown ? `${shown.name}: stages` : "Stages"}
          </SectionTitle>
          <Stages doc={doc} workflow={shown} />
          {!running && workflows.length > 0 && (
            <div className="text-ink-3 text-xs">
              The project doesn't name a workflow, so its items run the stages without these steps.
            </div>
          )}
        </>
      )}
      {project && config.data?.current && (
        <ConfigFooter config={config.data} projectId={project.id} />
      )}
    </PageArea>
  );
}

function Stages({
  doc,
  workflow,
}: {
  doc: Record<string, unknown>;
  workflow: WorkflowView | null;
}) {
  return (
    <Panel className="gap-0 p-0" data-testid="stages">
      {skeleton(doc, workflow).map((s, i) => (
        <div key={s.stage} className="border-line-soft border-b last:border-b-0">
          <div className="grid grid-cols-[minmax(110px,0.7fr)_1fr] gap-x-4 gap-y-1 px-3.5 py-2.5 text-[13px] min-[1100px]:grid-cols-[0.7fr_1.3fr_1.3fr_90px]">
            <span className="font-semibold">
              {i + 1}. {s.stage}
            </span>
            <span>{s.does}</span>
            <span className="col-start-2 text-ink-3 min-[1100px]:col-start-auto">{s.through}</span>
            <span className="col-start-2 inline-flex items-center gap-1.5 min-[1100px]:col-start-auto">
              <StatusDot status={s.decides === "person" ? "waiting" : "idle"} />
              {s.decides === "person" ? "A person" : "Code"}
            </span>
          </div>
          {s.after && <Slot label={s.after.label} steps={s.after.steps} />}
        </div>
      ))}
    </Panel>
  );
}

function Slot({ label, steps }: { label: string; steps: StepView[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-line-soft border-t bg-page/60 px-3.5 py-2 text-xs">
      <span className="text-ink-3">{label}:</span>
      {steps.length === 0 ? (
        <span className="text-ink-muted">no extra steps</span>
      ) : (
        steps.map((st) => (
          <Chip key={st.id || st.name} tone={st.kind === "gate" ? "amber" : "neutral"}>
            {st.name}
            {st.kind === "gate"
              ? ` · ${st.who === "Approvers" ? "approvers decide" : `${st.who} decides`}`
              : st.who !== st.name
                ? ` · ${st.who}`
                : ""}
            {st.when ? ` · ${st.when}` : ""}
          </Chip>
        ))
      )}
    </div>
  );
}

function WorkflowsEditing({
  projectId,
  orgId,
  initial,
}: {
  projectId: string;
  orgId: string;
  initial: string | null;
}) {
  const editor = useConfigDraft(projectId);
  const [selected, setSelected] = useState(initial);
  const org = useQuery(orgWorkflowsQuery(orgId));
  // The org's own workflows a project may run (not the built-in ones for incidents and PRs).
  const orgWorkflows = (org.data?.workflows ?? []).filter((w) => !w.builtIn);
  return (
    <>
      <UnsavedGuard editor={editor} />
      <WorkflowsForm
        editor={editor}
        selected={selected}
        onSelect={setSelected}
        orgWorkflows={orgWorkflows}
      />
      <SaveBar editor={editor} />
    </>
  );
}
