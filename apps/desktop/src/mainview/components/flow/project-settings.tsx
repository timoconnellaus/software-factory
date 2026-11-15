// A project's Settings tab: its name and key (read-only for now) and its repository, the one its
// runs check out and push the item's branch to. The repositories are what the org's GitHub
// connection reaches (`flow.github.repos`, read only while this tab shows). An org with no GitHub
// connection gets one line and the website's connect flow (`github.connectStart`), as it is.
import { type FlowProject, repoName } from "@software-factory/client/flow";
import { Button } from "@software-factory/ui/components/button";
import { Label } from "@software-factory/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@software-factory/ui/components/select";
import { Skeleton } from "@software-factory/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { openExternal } from "../../lib/external.tsx";
import { flowGithubReposQuery, useFlowRefresh } from "../../lib/flow-queries.ts";
import { OpError, op, submitKey } from "../../lib/op.ts";

const failed = (error: unknown, what: string) =>
  error instanceof OpError ? `${what}: ${error.message}` : `${what}.`;

export function ProjectSettings({ orgId, project }: { orgId: string; project: FlowProject }) {
  return (
    <div className="min-h-0 flex-1 overflow-auto bg-board p-5" data-testid="project-settings">
      <section className="grid max-w-2xl gap-4 rounded-[10px] border border-line bg-panel px-4 py-3.5">
        <div className="grid grid-cols-[120px_1fr] items-baseline gap-x-4 gap-y-2.5">
          <span className="text-ink-muted">Name</span>
          <span className="font-medium" data-testid="project-name">
            {project.name}
          </span>
          <span className="text-ink-muted">Key</span>
          <span className="font-mono text-[12.5px]" data-testid="project-key">
            {project.key}
          </span>
        </div>
        <Repository orgId={orgId} project={project} />
      </section>
    </div>
  );
}

function Repository({ orgId, project }: { orgId: string; project: FlowProject }) {
  const refresh = useFlowRefresh(orgId);
  const repos = useQuery(flowGithubReposQuery(orgId));
  const [busy, setBusy] = useState(false);
  const current = project.repo ?? null;

  async function choose(value: string) {
    const [owner, name] = value.split("/");
    if (!owner || !name || (current && repoName(current) === value)) return;
    setBusy(true);
    try {
      await op(
        "flow.project.setRepository",
        { orgId, projectId: project.id, owner, name },
        { idempotencyKey: submitKey() },
      );
      await refresh();
    } catch (error) {
      toast.error(failed(error, "Couldn't set the repository"));
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    setBusy(true);
    try {
      await op(
        "flow.project.setRepository",
        { orgId, projectId: project.id, clear: true },
        { idempotencyKey: submitKey() },
      );
      await refresh();
    } catch (error) {
      toast.error(failed(error, "Couldn't clear the repository"));
    } finally {
      setBusy(false);
    }
  }

  async function connect() {
    setBusy(true);
    try {
      const { url } = await op("github.connectStart", { orgId }, { idempotencyKey: submitKey() });
      openExternal(url);
    } catch (error) {
      toast.error(failed(error, "Couldn't start connecting GitHub"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-2 border-line-soft border-t pt-3.5" data-testid="project-repository">
      <Label htmlFor="project-repo" className="font-semibold text-[13.5px]">
        Repository
      </Label>
      <p className="text-[12.5px] text-ink-muted">
        Agents' runs on this project work in a checkout of it, on a branch for each item, and the
        branch is pushed when a run ends.
      </p>
      {repos.error ? (
        <p className="text-bad">Couldn't load the repositories. {repos.error.message}</p>
      ) : !repos.data ? (
        <Skeleton className="h-8 w-80" />
      ) : !repos.data.connected ? (
        <div className="flex items-center gap-3" data-testid="github-not-connected">
          <span className="text-ink-muted">This org has no GitHub connection yet.</span>
          <Button
            size="md"
            variant="outline"
            disabled={busy}
            onClick={() => void connect()}
            data-testid="connect-github"
          >
            Connect GitHub
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Select
            value={current ? repoName(current) : ""}
            onValueChange={(v) => void choose(v)}
            disabled={busy}
          >
            <SelectTrigger id="project-repo" className="w-80" data-testid="repo-picker">
              <SelectValue placeholder="Choose a repository" />
            </SelectTrigger>
            <SelectContent>
              {/* The current one stays choosable even if the connection no longer lists it. */}
              {current && !repos.data.repos.some((r) => repoName(r) === repoName(current)) && (
                <SelectItem value={repoName(current)}>{repoName(current)}</SelectItem>
              )}
              {repos.data.repos.map((r) => (
                <SelectItem key={repoName(r)} value={repoName(r)} data-testid="repo-option">
                  {repoName(r)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {current && (
            <Button
              size="md"
              variant="ghost"
              className="text-ink-muted"
              disabled={busy}
              onClick={() => void clear()}
              data-testid="clear-repo"
            >
              Clear
            </Button>
          )}
          {repos.data.account && (
            <span className="text-[12px] text-ink-muted" data-testid="github-account">
              GitHub, connected as {repos.data.account}
            </span>
          )}
        </div>
      )}
      {current && (
        <p className="text-[12.5px] text-ink-muted" data-testid="repo-default-branch">
          Its default branch is <span className="font-mono">{current.defaultBranch}</span>: an
          item's first run starts from it.
        </p>
      )}
    </div>
  );
}
