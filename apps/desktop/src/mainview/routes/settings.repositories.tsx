// Settings: Repositories (spec 41, slice 6; design SettingsProjects). Each project's repositories
// (spec 50, ADR 0490) with the branch, whether the factory's GitHub App reaches them and whether the
// default branch is protected (Setup's check, ADR 0280). Adding a repository and protecting a branch
// are Setup's flows, so this page links there.

import { Button } from "@software-factory/ui/components/button";
import { StatusDot } from "@software-factory/ui/components/status-dot";
import { cn } from "@software-factory/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { createRoute, Link } from "@tanstack/react-router";
import { Cell, Empty, Row, TablePanel, WIDE } from "../components/data-table.tsx";
import { Reads } from "../components/read-state.tsx";
import { PageArea, PageHeader } from "../components/shell-list.tsx";
import { useOrgScope } from "../components/shell-sidebar.tsx";
import { ExternalLink } from "../lib/external.tsx";
import { setupStatusesQuery } from "../lib/factory-queries.ts";
import { useProjects, useSession } from "../lib/session.ts";
import { projectsWithoutRepos, protectionHeader, repoRows } from "../lib/settings-view.ts";
import { settingsLayout } from "./_settings.tsx";

export const Route = createRoute({
  getParentRoute: () => settingsLayout,
  path: "/settings/repositories",
  loader: ({ context: { queryClient, session } }) =>
    queryClient
      .ensureQueryData(setupStatusesQuery(session.orgs.map((o) => o.id)))
      .catch(() => null),
  component: RepositoriesPage,
});

function RepositoriesPage() {
  const session = useSession();
  const orgId = useOrgScope();
  const projects = useProjects();
  const orgIds = session.orgs.map((o) => o.id);
  const setups = useQuery(setupStatusesQuery(orgIds));
  const inScope = (projects.data ?? []).filter((p) => orgId === null || p.orgId === orgId);
  const rows = repoRows(inScope, setups.data ?? []);
  const bare = projectsWithoutRepos(inScope);
  return (
    <PageArea>
      <PageHeader
        title="Repositories"
        sub="Code the factory may change. A repository is not a project: a project is a body of work, and it can use a repository or none."
        actions={
          <Button size="md" variant="outline" asChild>
            <Link to="/setup" data-testid="add-repository">
              Add in Setup
            </Link>
          </Button>
        }
      />
      <Reads queries={[projects, setups]} what="the repositories">
        {() => (
          <>
            {rows.length === 0 ? (
              <Empty>No repositories yet. Connect GitHub and add a project in Setup.</Empty>
            ) : (
              <TablePanel
                head={[
                  "Repository",
                  { label: "Branch", className: WIDE },
                  protectionHeader(rows),
                  { label: "GitHub", className: WIDE },
                  "Project",
                ]}
                data-testid="repositories"
              >
                {rows.map((r) => (
                  <Row key={r.id}>
                    <Cell className="whitespace-normal font-mono text-xs">
                      {/* Wraps after the owner, never inside a name. */}
                      {r.fullName.split("/")[0]}/<wbr />
                      {r.fullName.split("/").slice(1).join("/")}
                    </Cell>
                    <Cell className={cn("font-mono text-ink-3 text-xs", WIDE)}>{r.branch}</Cell>
                    <Cell className="whitespace-normal">
                      {r.protection ? (
                        <span
                          className="inline-flex items-center gap-2"
                          title={r.protection.detail ?? undefined}
                        >
                          <StatusDot status={r.protection.dot} />
                          {r.protection.dot === "done" ? (
                            r.protection.text
                          ) : (
                            <Link to="/setup" className="underline">
                              {r.protection.text}
                            </Link>
                          )}
                        </span>
                      ) : (
                        <span className="text-ink-muted">Not checked yet</span>
                      )}
                    </Cell>
                    <Cell className={WIDE}>
                      <span className="inline-flex items-center gap-2">
                        <StatusDot status={r.connection.dot} />
                        {r.connection.manageUrl && r.connection.dot !== "done" ? (
                          <ExternalLink href={r.connection.manageUrl} className="underline">
                            {r.connection.text}
                          </ExternalLink>
                        ) : (
                          r.connection.text
                        )}
                      </span>
                    </Cell>
                    <Cell>{r.projectName}</Cell>
                  </Row>
                ))}
              </TablePanel>
            )}
            {bare.length > 0 && (
              <div className="text-ink-3 text-xs" data-testid="projects-without-repos">
                Without a repository: {bare.map((p) => p.name).join(", ")}. Their work doesn't
                change code.
              </div>
            )}
          </>
        )}
      </Reads>
    </PageArea>
  );
}
