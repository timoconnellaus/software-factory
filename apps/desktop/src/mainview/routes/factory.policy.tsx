// Factory: Policy (spec 41, slice 5; design FactoryPolicy). The project's current autonomy policy
// and limits, read-only from `config.get`. Changing the policy is a human-only, self-modify-class
// change (AGENTS.md, ADR 0370): the desktop shows it and links to the website, where a save that
// loosens waits for an approver. There is no edit path here, so none weaker than the website's.
import { createRoute } from "@tanstack/react-router";
import {
  ConfigFooter,
  ConfigState,
  configProjectId,
  PendingChanges,
  ProjectPicker,
  projectSearch,
  useProjectConfig,
} from "../components/config-parts.tsx";
import { PageArea, PageHeader, Panel, SectionTitle } from "../components/shell-list.tsx";
import { policySections } from "../lib/config-view.ts";
import { configQuery } from "../lib/factory-queries.ts";
import { factoryLayout } from "./_factory.tsx";

export const Route = createRoute({
  getParentRoute: () => factoryLayout,
  path: "/factory/policy",
  validateSearch: projectSearch,
  loaderDeps: ({ search }) => ({ project: search.project }),
  loader: async ({ context, deps }) => {
    const id = await configProjectId(context, deps.project);
    if (id) await context.queryClient.ensureQueryData(configQuery(id)).catch(() => null);
  },
  component: PolicyPage,
});

function PolicyPage() {
  const search = Route.useSearch();
  const { projects, project, projectsRead, config } = useProjectConfig(search.project);
  const doc = config.data?.current?.policy ?? null;
  return (
    <PageArea>
      <PageHeader
        above={project?.name}
        title="Policy"
        sub="The rules the factory can't talk its way around. Gates live in code; the policy only chooses within them."
        actions={<ProjectPicker projects={projects} project={project} from="/factory/policy" />}
      />
      <ConfigState projectsRead={projectsRead} project={project} config={config} />
      {project && config.data && <PendingChanges config={config.data} projectId={project.id} />}
      {doc &&
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
                  className="grid grid-cols-[minmax(150px,1fr)_minmax(140px,1fr)] gap-x-4 gap-y-0.5 border-line-soft border-b px-3.5 py-2.5 text-[13px] last:border-b-0 min-[1100px]:grid-cols-[1fr_1fr_1.2fr]"
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
        ))}
      {project && config.data?.current && (
        <ConfigFooter config={config.data} projectId={project.id} page="settings" />
      )}
    </PageArea>
  );
}
