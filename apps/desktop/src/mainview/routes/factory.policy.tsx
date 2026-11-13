// Factory: Policy (spec 41, slice 5; design FactoryPolicy; ADR 0610). The project's autonomy policy
// and limits from `config.get`, the changes waiting for an approver (Approve or Reject with Touch
// ID), and Edit policy (`?edit=1`): the whole config as a form, saved with `config.save`. A save
// that tightens or is neutral applies at once; one that loosens waits for an approver, judged under
// the current version (ADR 0370). Loosening policy is a person's decision: the approval goes
// through `decide()` with a presence proof, never `op()`.
import { Button } from "@software-factory/ui/components/button";
import { createRoute } from "@tanstack/react-router";
import { toast } from "sonner";
import { SaveBar, useConfigDraft } from "../components/config-editor.tsx";
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
import { History, PolicyForm } from "../components/policy-form.tsx";
import { PageArea, PageHeader, Panel, SectionTitle } from "../components/shell-list.tsx";
import { policySections } from "../lib/config-view.ts";
import { saveFile } from "../lib/external.tsx";
import { adjudicatorQuery, configQuery, trialsQuery } from "../lib/factory-queries.ts";
import { read } from "../lib/op.ts";
import { factoryLayout } from "./_factory.tsx";

interface Search {
  project?: string;
  edit?: boolean;
}

export const Route = createRoute({
  getParentRoute: () => factoryLayout,
  path: "/factory/policy",
  validateSearch: (s: Record<string, unknown>): Search => ({
    ...projectSearch(s),
    ...editSearch(s),
  }),
  loaderDeps: ({ search }) => ({ project: search.project, edit: !!search.edit }),
  loader: async ({ context, deps }) => {
    const id = await configProjectId(context, deps.project);
    if (!id) return;
    const q = context.queryClient;
    await Promise.all([
      q.ensureQueryData(configQuery(id)),
      // The edit form's trials and the adjudicator's record, only when editing.
      ...(deps.edit
        ? [q.ensureQueryData(trialsQuery(id)), q.ensureQueryData(adjudicatorQuery(id))]
        : []),
    ]).catch(() => null);
  },
  component: PolicyPage,
});

async function exportConfig(projectId: string, slug: string) {
  try {
    const out = await read("config.export", { projectId });
    const saved = await saveFile(
      `${slug}-factory-v${out.version ?? 0}.json`,
      JSON.stringify(out.files, null, 2),
    );
    if (saved) toast.success("Saved to Downloads.");
  } catch (error) {
    toast.error(error instanceof Error ? error.message : String(error));
  }
}

function PolicyPage() {
  const search = Route.useSearch();
  const { projects, project, projectsRead, config } = useProjectConfig(search.project);
  const editor = useConfigDraft(project?.id ?? "");
  const doc = config.data?.current?.policy ?? null;
  const editing = !!search.edit && !!doc;
  return (
    <PageArea>
      <PageHeader
        above={project?.name}
        title="Policy"
        sub="The rules the factory can't talk its way around. Tightening a rule saves at once. Loosening one waits for an approver."
        actions={
          <>
            <ProjectPicker projects={projects} project={project} from="/factory/policy" />
            {doc && project && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void exportConfig(project.id, project.slug)}
                data-testid="config-export"
              >
                Export as a file
              </Button>
            )}
            {doc && (
              <EditToggle
                from="/factory/policy"
                projectId={project?.id}
                editing={editing}
                label="Edit policy"
              />
            )}
          </>
        }
      />
      <ConfigState projectsRead={projectsRead} project={project} config={config} />
      {project && config.data && <PendingChanges config={config.data} projectId={project.id} />}
      {editing ? (
        <>
          <PolicyForm editor={editor} />
          <SaveBar editor={editor} />
          <History editor={editor} />
        </>
      ) : (
        doc &&
        policySections(doc).map((section) => (
          <section key={section.title} className="flex flex-col gap-2">
            <SectionTitle>{section.title}</SectionTitle>
            <Panel
              className="gap-0 p-0"
              data-testid={`policy-${section.title.toLowerCase().replace(/\W+/g, "-")}`}
            >
              {section.rows.map((r) => (
                <div
                  key={r.key}
                  className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-x-4 gap-y-0.5 border-line-soft border-b px-3.5 py-2.5 text-[13px] last:border-b-0 min-[1100px]:grid-cols-[1fr_1fr_1.2fr]"
                  data-testid={`policy-${r.key}`}
                >
                  <span className="font-medium">{r.label}</span>
                  <span>{r.value}</span>
                  {r.note && (
                    <span className="col-span-2 text-ink-3 text-xs min-[1100px]:col-span-1 min-[1100px]:text-[13px]">
                      {r.note}
                    </span>
                  )}
                </div>
              ))}
            </Panel>
          </section>
        ))
      )}
      {!editing && project && config.data?.current && (
        <ConfigFooter config={config.data} projectId={project.id} />
      )}
    </PageArea>
  );
}
