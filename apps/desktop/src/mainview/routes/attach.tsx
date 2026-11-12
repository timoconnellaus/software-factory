// Attach an outside pull request to a work item (spec 05, ADR 0290). `factory/verify` on a PR the
// factory didn't open links here (`/attach?repo=<owner>/<repo>&pr=<n>`): the PR, the project it
// maps to, and one button. Attaching starts the item's Workflow, which verifies the PR's own head
// and takes it to the merge gate; then the page goes to the work item.
// Ported from sf-app for spec 40 M3. The desktop gets here from an `sf://attach?...` link; the PR's
// title opens GitHub in the default browser.
import { Badge } from "@software-factory/ui/components/badge";
import { Button } from "@software-factory/ui/components/button";
import { Card } from "@software-factory/ui/components/card";
import { useQuery } from "@tanstack/react-query";
import { createRoute, Link } from "@tanstack/react-router";
import { AttachButton, parseRepo } from "../components/attach-button.tsx";
import { PageArea } from "../components/shell-list.tsx";
import { ExternalLink } from "../lib/external.tsx";
import { OpError } from "../lib/op.ts";
import { attachPreviewQuery } from "../lib/queries.ts";
import { workLayout } from "./_work.tsx";

interface AttachSearch {
  repo?: string;
  pr?: number;
}

export const Route = createRoute({
  getParentRoute: () => workLayout,
  path: "/attach",
  validateSearch: (s: Record<string, unknown>): AttachSearch => {
    const pr = Number(s.pr);
    return {
      ...(typeof s.repo === "string" ? { repo: s.repo } : {}),
      ...(Number.isInteger(pr) && pr > 0 ? { pr } : {}),
    };
  },
  loaderDeps: ({ search }) => ({ repo: search.repo, pr: search.pr }),
  loader: async ({ context: { queryClient }, deps }) => {
    const repo = parseRepo(deps.repo);
    if (repo && deps.pr) {
      await queryClient.ensureQueryData(attachPreviewQuery(repo, deps.pr)).catch(() => null);
    }
  },
  component: AttachPage,
});

function AttachPage() {
  const search = Route.useSearch();
  const repo = parseRepo(search.repo);
  return (
    <PageArea className="max-w-[640px]">
      <div>
        <h1 className="m-0 font-semibold text-[18px] tracking-[-0.015em]">Attach a pull request</h1>
        <p className="text-ink-3">
          A pull request opened outside the factory reaches the default branch only through{" "}
          <span className="font-mono text-xs">factory/verify</span> and the merge gate. Attaching it
          gives it a work item: the factory verifies its head (it never pushes to the branch) and
          asks you to merge when it passes.
        </p>
      </div>
      {repo && search.pr ? (
        <Preview repo={repo} prNumber={search.pr} />
      ) : (
        <Card className="px-5 py-4 text-sm" data-testid="attach-bad-link">
          This link doesn't name a pull request. Open it from the{" "}
          <span className="font-mono text-xs">factory/verify</span> check's Details, or pick an open
          pull request on{" "}
          <Link to="/new" className="underline">
            New work
          </Link>
          .
        </Card>
      )}
    </PageArea>
  );
}

function Preview({ repo, prNumber }: { repo: { owner: string; name: string }; prNumber: number }) {
  const preview = useQuery(attachPreviewQuery(repo, prNumber));
  if (preview.isPending) {
    return <div className="text-muted-foreground text-sm">Reading the pull request…</div>;
  }
  if (preview.error || !preview.data) {
    const e = preview.error;
    const forbidden = e instanceof OpError && e.code === "forbidden";
    return (
      <Card className="px-5 py-4 text-sm" data-testid="attach-refused">
        {forbidden
          ? `You're not a member of the org that owns ${repo.owner}/${repo.name} in the factory, so you can't attach its pull requests.`
          : e instanceof OpError && e.code === "not_found"
            ? `The factory has no project for ${repo.owner}/${repo.name}, or it has no pull request #${prNumber}.`
            : `Can't read the pull request: ${e?.message ?? "unknown error"}`}
      </Card>
    );
  }
  const { project, pr, attachedWorkItemId } = preview.data;
  return (
    <Card className="gap-0 py-0" data-testid="attach-preview">
      <div className="grid gap-1 border-b px-5 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <ExternalLink href={pr.url} className="font-medium hover:underline">
            {pr.title}
          </ExternalLink>
          <span className="text-muted-foreground">#{pr.number}</span>
          {pr.draft && <Badge variant="outline">Draft</Badge>}
        </div>
        <div className="text-muted-foreground text-sm">
          {pr.author ? `by ${pr.author} · ` : ""}
          <span className="font-mono text-xs">{pr.branch}</span> at{" "}
          <span className="font-mono text-xs">{pr.headSha.slice(0, 7)}</span>
        </div>
      </div>
      <table className="mx-5 my-3 text-sm">
        <tbody className="[&_td]:py-1 [&_td:first-child]:w-24 [&_td:first-child]:text-muted-foreground">
          <tr>
            <td>Project</td>
            <td>
              {project.name} <span className="font-mono text-xs">({project.repo})</span>
            </td>
          </tr>
          <tr>
            <td>Then</td>
            <td>Triage drafts criteria from the PR → verify on its head → the merge gate</td>
          </tr>
        </tbody>
      </table>
      <div className="flex flex-wrap items-center gap-3 border-t px-5 py-3">
        {attachedWorkItemId ? (
          <>
            <span className="text-sm">Already attached.</span>
            <Button asChild>
              <Link to="/work/$id" params={{ id: attachedWorkItemId }}>
                Open the work item
              </Link>
            </Button>
          </>
        ) : pr.refusal ? (
          <span className="text-destructive text-sm" data-testid="attach-refusal">
            Can't attach: {pr.refusal}.
          </span>
        ) : (
          <AttachButton projectId={project.id} prNumber={pr.number} />
        )}
      </div>
    </Card>
  );
}
