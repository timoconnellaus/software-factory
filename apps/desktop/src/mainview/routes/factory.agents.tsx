// Factory: Agents (spec 41, slice 5; design FactoryAgents). The project's agents (ADR 0372): each a
// model role and tier with standing instructions, never a model or a harness; then the model roles
// with the project's own choices. Read-only from `config.get`: agents are changed on the website.
// The design's skills (spec 52) and per-agent usage have no operation yet, so they aren't here.
import { cn } from "@software-factory/ui/lib/utils";
import { createRoute, Link } from "@tanstack/react-router";
import {
  ConfigFooter,
  ConfigState,
  configProjectId,
  ProjectPicker,
  projectSearch,
  useProjectConfig,
} from "../components/config-parts.tsx";
import { Cell, Empty, Row, TablePanel, WIDE } from "../components/data-table.tsx";
import { Chip, PageArea, PageHeader, Panel, SectionTitle } from "../components/shell-list.tsx";
import { agentRows, modelRoleRows } from "../lib/config-view.ts";
import { configQuery } from "../lib/factory-queries.ts";
import { factoryLayout } from "./_factory.tsx";

interface Search {
  project?: string;
  agent?: string;
}

export const Route = createRoute({
  getParentRoute: () => factoryLayout,
  path: "/factory/agents",
  validateSearch: (s: Record<string, unknown>): Search => ({
    ...projectSearch(s),
    ...(typeof s.agent === "string" ? { agent: s.agent } : {}),
  }),
  loaderDeps: ({ search }) => ({ project: search.project }),
  loader: async ({ context, deps }) => {
    const id = await configProjectId(context, deps.project);
    if (id) await context.queryClient.ensureQueryData(configQuery(id)).catch(() => null);
  },
  component: AgentsPage,
});

const ROLE_TEXT: Record<string, string> = {
  triage: "Triage",
  implement: "Implement",
  review: "Review",
  summarise: "Summarise",
};

function AgentsPage() {
  const search = Route.useSearch();
  const { projects, project, config } = useProjectConfig(search.project);
  const doc = config.data?.current?.policy ?? null;
  const agents = doc ? agentRows(doc) : [];
  const chosen = agents.find((a) => a.name === search.agent) ?? agents[0];
  return (
    <PageArea>
      <PageHeader
        above={project?.name}
        title="Agents"
        sub="An agent is a role in the workflow: a model role, a tier and standing instructions. The runner chooses the model for the role."
        actions={<ProjectPicker projects={projects} project={project} from="/factory/agents" />}
      />
      <ConfigState project={project} config={config} />
      {doc && (
        <>
          {agents.length === 0 ? (
            <Empty>No agents of the project's own. Steps and builds use the built-in ones.</Empty>
          ) : (
            <TablePanel
              head={[
                "Agent",
                "Role",
                "Tier",
                "Instructions",
                { label: "Used by", className: WIDE },
              ]}
              data-testid="agents"
            >
              {agents.map((a) => (
                <Row
                  key={a.name}
                  aria-current={a.name === chosen?.name ? "true" : undefined}
                  className={cn(a.name === chosen?.name && agents.length > 1 && "bg-selected/60")}
                >
                  <Cell className="font-medium">
                    <Link
                      to="/factory/agents"
                      search={{ ...(project ? { project: project.id } : {}), agent: a.name }}
                      className="hover:underline"
                    >
                      {a.name}
                    </Link>
                  </Cell>
                  <Cell>{ROLE_TEXT[a.role] ?? a.role}</Cell>
                  <Cell>
                    <Chip>{a.tier === "light" ? "Light" : "Standard"}</Chip>
                  </Cell>
                  <Cell className="text-ink-3">
                    {a.lines ? `${a.lines} ${a.lines === 1 ? "line" : "lines"}` : "none"}
                  </Cell>
                  <Cell className={cn("max-w-[260px] truncate text-ink-3", WIDE)}>
                    {a.usedBy.length ? a.usedBy.join(", ") : "Not used yet"}
                  </Cell>
                </Row>
              ))}
            </TablePanel>
          )}
          {chosen && (
            <section className="flex flex-col gap-2">
              <SectionTitle>{chosen.name}: instructions</SectionTitle>
              <Panel data-testid="agent-instructions">
                {chosen.instructions ? (
                  <pre className="m-0 whitespace-pre-wrap font-mono text-[12.5px] leading-relaxed">
                    {chosen.instructions}
                  </pre>
                ) : (
                  <span className="text-ink-muted">No standing instructions.</span>
                )}
                {chosen.requires.length > 0 && (
                  <div className="text-ink-3 text-xs">Needs: {chosen.requires.join(", ")}</div>
                )}
              </Panel>
            </section>
          )}
          <SectionTitle note="Code asks for a role; the project may choose the model for each.">
            Model roles
          </SectionTitle>
          <TablePanel head={["Role", "Standard tier", "Light tier"]} data-testid="model-roles">
            {modelRoleRows(doc).map((r) => (
              <Row key={r.role}>
                <Cell className="font-medium">{ROLE_TEXT[r.role] ?? r.role}</Cell>
                <Cell className={r.standard ? "font-mono text-xs" : "text-ink-3"}>
                  {r.standard ?? "The default for the role"}
                </Cell>
                <Cell className={r.light ? "font-mono text-xs" : "text-ink-3"}>
                  {r.light ?? "The default for the role"}
                </Cell>
              </Row>
            ))}
          </TablePanel>
        </>
      )}
      {project && config.data?.current && (
        <ConfigFooter config={config.data} projectId={project.id} page="workflows" />
      )}
    </PageArea>
  );
}
