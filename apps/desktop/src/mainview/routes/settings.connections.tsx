// Settings: Connections (spec 41, slice 6; design SettingsConnections). Where the factory reaches
// out: today that is the GitHub App, one installation per account (ADR 0055), from Setup's status.
// The design's other connectors (issues, Sentry, Linear, Slack, Telegram) have no operations yet,
// so they aren't listed. Connecting GitHub stays on the website's install flow (ADR 0382).
import { Button } from "@software-factory/ui/components/button";
import { StatusDot } from "@software-factory/ui/components/status-dot";
import { useQuery } from "@tanstack/react-query";
import { createRoute, Link } from "@tanstack/react-router";
import { Empty } from "../components/data-table.tsx";
import { Reads } from "../components/read-state.tsx";
import { PageArea, PageHeader, Panel, SectionTitle } from "../components/shell-list.tsx";
import { useOrgScope } from "../components/shell-sidebar.tsx";
import { ExternalLink } from "../lib/external.tsx";
import { setupStatusesQuery } from "../lib/factory-queries.ts";
import { useSession } from "../lib/session.ts";
import { installationRepoCount, installationText } from "../lib/settings-view.ts";
import { settingsLayout } from "./_settings.tsx";

export const Route = createRoute({
  getParentRoute: () => settingsLayout,
  path: "/settings/connections",
  loader: ({ context: { queryClient, session } }) =>
    queryClient
      .ensureQueryData(setupStatusesQuery(session.orgs.map((o) => o.id)))
      .catch(() => null),
  component: ConnectionsPage,
});

function ConnectionsPage() {
  const session = useSession();
  const orgId = useOrgScope();
  const orgIds = session.orgs.map((o) => o.id);
  const setups = useQuery(setupStatusesQuery(orgIds));
  const installs = (setups.data ?? []).flatMap((s, i) =>
    orgId === null || orgIds[i] === orgId
      ? s.installations.map((inst) => ({ ...inst, orgId: orgIds[i] }))
      : [],
  );
  // An installation belongs to one org: count the repositories it reaches among that org's projects.
  const projectsOf = (org: string | undefined) =>
    setups.data?.[orgIds.indexOf(org ?? "")]?.projects ?? [];
  return (
    <PageArea>
      <PageHeader
        title="Connections"
        sub="Where the factory may reach out. Everything outside goes through one of these; a run never holds your own credentials."
      />
      <SectionTitle>Code</SectionTitle>
      <Reads queries={[setups]} what="the connections">
        {() =>
          installs.length === 0 ? (
            <Empty>
              GitHub isn't connected.{" "}
              <Link to="/setup" className="text-ink underline">
                Connect it in Setup
              </Link>
            </Empty>
          ) : (
            <Panel className="gap-0 p-0" data-testid="connections">
              {installs.map((i) => {
                const t = installationText(i);
                return (
                  <div
                    key={`${i.orgId}:${i.id}`}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 border-line-soft border-b px-3.5 py-3 last:border-b-0"
                  >
                    <StatusDot status={t.dot} />
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="font-medium">GitHub · {i.account}</span>
                      <span className="text-ink-3 text-xs">
                        {t.text} <RepoCount n={installationRepoCount(i, projectsOf(i.orgId))} />{" "}
                        Each job gets a token for one repository only.
                      </span>
                    </div>
                    <Button size="md" variant="outline" asChild>
                      <ExternalLink href={i.manageUrl}>Manage on GitHub</ExternalLink>
                    </Button>
                  </div>
                );
              })}
            </Panel>
          )
        }
      </Reads>
    </PageArea>
  );
}

function RepoCount({ n }: { n: number }) {
  return (
    <>{n === 1 ? "1 repository is in the factory." : `${n} repositories are in the factory.`}</>
  );
}
