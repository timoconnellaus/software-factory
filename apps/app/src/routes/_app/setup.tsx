// Setup is a checklist with live state (ADR 0055, 0056): GitHub connected · a project · its policy
// · a runner online · `factory/verify` required. Each step shows the one action that fixes it.
// Nothing here asks for an id the factory can fetch (incident 2026-11-11-bootstrap): GitHub's install
// flow brings the installation back, the repo is picked from what the App can reach, the policy
// syncs itself, and a runner logs in with a code.
import { Button } from "@software-factory/ui/components/button";
import { Card } from "@software-factory/ui/components/card";
import { Input } from "@software-factory/ui/components/input";
import { Label } from "@software-factory/ui/components/label";
import { Skeleton } from "@software-factory/ui/components/skeleton";
import { StatusDot } from "@software-factory/ui/components/status-dot";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { ago } from "#/lib/format";
import { op, submitKey } from "#/lib/op";
import { OpError, type SetupStatus } from "#/lib/ops";
import { reposQuery, runnersQuery, setupStatusQuery } from "#/lib/queries";
import { LOGIN_COMMAND, pairCommand } from "#/lib/runner-pairing";
import { useSession } from "#/lib/session";

interface SetupSearch {
  github?: string;
  account?: string;
  github_error?: string;
}

export const Route = createFileRoute("/_app/setup")({
  validateSearch: (s: Record<string, unknown>): SetupSearch => ({
    ...(typeof s.github === "string" ? { github: s.github } : {}),
    ...(typeof s.account === "string" ? { account: s.account } : {}),
    ...(typeof s.github_error === "string" ? { github_error: s.github_error } : {}),
  }),
  component: SetupPage,
});

type Step = SetupStatus["steps"][number];
type ProjectState = SetupStatus["projects"][number];

const STEP_TITLE: Record<Step["key"], string> = {
  github: "GitHub connected",
  project: "A project",
  policy: "Factory policy",
  runner: "A runner online",
  verify: "factory/verify required",
};

function errorText(error: unknown) {
  return error instanceof OpError ? error.message : "Something went wrong";
}

function useRefreshSetup() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all(
      ["setup", "projects", "repos", "runners", "routing"].map((k) =>
        queryClient.invalidateQueries({ queryKey: [k] }),
      ),
    );
}

function SetupPage() {
  const session = useSession();
  const orgId = session.personalOrgId ?? "";
  const status = useQuery({ ...setupStatusQuery(orgId), enabled: !!orgId });
  const search = Route.useSearch();
  const navigate = useNavigate();
  const dismiss = () => navigate({ to: "/setup", search: {}, replace: true });
  const done = status.data?.steps.filter((s) => s.done).length ?? 0;

  return (
    <main className="mx-auto grid w-full grid-cols-[minmax(0,1fr)] max-w-[860px] gap-4 p-4 md:p-6">
      <div>
        <h1 className="font-semibold text-2xl tracking-tight">Setup</h1>
        <p className="text-muted-foreground text-sm" data-testid="setup-progress">
          {status.data
            ? status.data.complete
              ? "Everything is connected. New work can run end to end."
              : `${done} of ${status.data.steps.length} done`
            : "Checking…"}
        </p>
      </div>

      {search.github === "connected" || search.github === "updated" ? (
        <Banner tone="ok" onClose={dismiss}>
          GitHub {search.github === "connected" ? "connected" : "updated"}
          {search.account ? `: ${search.account}` : ""}.
        </Banner>
      ) : search.github === "requested" ? (
        <Banner tone="info" onClose={dismiss}>
          GitHub asked an owner of the organization to approve the App. Setup carries on once they
          do.
        </Banner>
      ) : null}
      {search.github_error && (
        <Banner tone="error" onClose={dismiss}>
          Couldn't connect GitHub: {search.github_error}
        </Banner>
      )}

      {status.isPending ? (
        <Skeleton className="h-72 w-full" />
      ) : status.isError ? (
        <Card className="px-5 py-4 text-destructive text-sm">
          Couldn't load Setup: {status.error.message}
        </Card>
      ) : (
        <Checklist status={status.data} orgId={orgId} />
      )}

      {status.data?.projects.map((p) => (
        <ProjectDetails key={p.id} project={p} />
      ))}
      <Runners />
    </main>
  );
}

function Banner({
  tone,
  children,
  onClose,
}: {
  tone: "ok" | "info" | "error";
  children: React.ReactNode;
  onClose: () => void;
}) {
  const cls =
    tone === "error"
      ? "border-destructive/40 bg-destructive/10"
      : tone === "ok"
        ? "border-emerald-500/40 bg-emerald-500/10"
        : "";
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={`flex items-start gap-3 rounded-md border px-4 py-3 text-sm ${cls}`}
      data-testid={`banner-${tone}`}
    >
      <div className="grow">{children}</div>
      <button type="button" className="text-muted-foreground text-xs underline" onClick={onClose}>
        Dismiss
      </button>
    </div>
  );
}

function Checklist({ status, orgId }: { status: SetupStatus; orgId: string }) {
  return (
    <Card className="gap-0 py-0" data-testid="setup-checklist">
      {status.steps.map((step, i) => (
        <div
          key={step.key}
          className={`grid gap-2 px-5 py-4 ${i ? "border-t" : ""}`}
          data-testid={`step-${step.key}`}
          data-done={step.done}
        >
          <div className="flex items-start gap-3">
            <span className="pt-1.5">
              <StatusDot status={step.done ? "done" : "waiting"} />
            </span>
            <div className="grid min-w-0 grow gap-0.5">
              <div className="font-medium">
                {STEP_TITLE[step.key]} {step.done && <span title="done">✓</span>}
              </div>
              <div className="break-words text-muted-foreground text-sm">{step.detail}</div>
            </div>
          </div>
          <div className="pl-6">
            <StepAction step={step} status={status} orgId={orgId} />
          </div>
        </div>
      ))}
    </Card>
  );
}

function StepAction({ step, status, orgId }: { step: Step; status: SetupStatus; orgId: string }) {
  switch (step.key) {
    case "github":
      return <GitHubAction status={status} orgId={orgId} />;
    case "project": {
      const ready = status.steps.find((s) => s.key === "github")?.done;
      if (!ready) return null;
      return <AddProject orgId={orgId} open={!step.done} />;
    }
    case "policy":
      return (
        <div className="grid gap-2">
          {status.projects
            .filter((p) => p.connection.status === "connected" && p.policy.state !== "valid")
            .map((p) => (
              <PolicyAction key={p.id} project={p} />
            ))}
        </div>
      );
    case "runner":
      return step.done ? null : <RunnerLogin />;
    case "verify":
      return step.done ? null : <VerifyAction status={status} />;
  }
}

function GitHubAction({ status, orgId }: { status: SetupStatus; orgId: string }) {
  const [busy, setBusy] = useState(false);
  async function connect() {
    setBusy(true);
    try {
      const { url } = await op("github.connectStart", { orgId }, { idempotencyKey: submitKey() });
      window.location.assign(url);
    } catch (error) {
      toast.error(errorText(error));
      setBusy(false);
    }
  }
  const connected = status.installations.filter((i) => i.status !== "deleted");
  return (
    <div className="grid gap-2">
      {connected.map((i) => (
        <div key={i.id} className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">{i.account}</span>
          <span className="text-muted-foreground text-xs">
            {i.status === "active"
              ? i.repositorySelection === "all"
                ? "all repositories"
                : "selected repositories"
              : i.status}
          </span>
          <a
            href={i.manageUrl}
            target="_blank"
            rel="noreferrer"
            className="text-xs underline"
            data-testid="manage-repos"
          >
            Manage repositories on GitHub
          </a>
        </div>
      ))}
      <div>
        <Button
          size="sm"
          variant={connected.length ? "ghost" : "default"}
          disabled={busy}
          onClick={connect}
          data-testid="connect-github"
        >
          {busy
            ? "Opening GitHub…"
            : connected.length
              ? "Connect another account"
              : "Connect GitHub"}
        </Button>
      </div>
    </div>
  );
}

function AddProject({ orgId, open: initiallyOpen }: { orgId: string; open: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  if (!open) {
    return (
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)} data-testid="add-project">
        Add another project
      </Button>
    );
  }
  return <RepoPicker orgId={orgId} />;
}

function RepoPicker({ orgId }: { orgId: string }) {
  const repos = useQuery(reposQuery(orgId));
  const refresh = useRefreshSetup();
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<number | null>(null);

  async function add(r: { installationRecordId: string; repoId: number; name: string }) {
    setBusy(r.repoId);
    try {
      const p = await op(
        "project.create",
        { orgId, installationRecordId: r.installationRecordId, repoId: r.repoId },
        { idempotencyKey: submitKey() },
      );
      toast.success(
        p.policy.state === "valid"
          ? `${p.name} added, with its policy.`
          : `${p.name} added. It has no valid factory policy yet.`,
      );
      await refresh();
    } catch (error) {
      toast.error(errorText(error), { duration: 15_000 });
    } finally {
      setBusy(null);
    }
  }

  if (repos.isPending) return <Skeleton className="h-24 w-full" />;
  if (repos.isError) {
    return (
      <div className="text-destructive text-sm">
        Couldn't list repositories: {repos.error.message}
      </div>
    );
  }
  const q = filter.trim().toLowerCase();
  const shown = repos.data.repos.filter((r) => `${r.owner}/${r.name}`.toLowerCase().includes(q));
  return (
    <div className="grid gap-2" data-testid="repo-picker">
      {repos.data.problems.map((p) => (
        <div key={p.account} className="text-destructive text-sm">
          {p.account}: {p.error}
        </div>
      ))}
      {repos.data.repos.length > 6 && (
        <Input
          placeholder="Filter repositories"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="max-w-xs"
        />
      )}
      {repos.data.repos.length === 0 ? (
        <div className="text-muted-foreground text-sm">
          The App can't reach any repositories yet. Add one under "Manage repositories on GitHub"
          above, then come back.
        </div>
      ) : (
        <div className="grid divide-y rounded-md border">
          {shown.map((r) => (
            <div key={r.repoId} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
              <span className="font-mono">
                {r.owner}/{r.name}
              </span>
              {r.private && <span className="text-muted-foreground text-xs">private</span>}
              <span className="text-muted-foreground text-xs">{r.defaultBranch}</span>
              <span className="grow" />
              {r.projectId ? (
                <span className="text-muted-foreground text-xs">already a project</span>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() => add(r)}
                  data-testid={`pick-${r.name}`}
                >
                  {busy === r.repoId ? "Adding…" : "Add"}
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PolicyAction({ project }: { project: ProjectState }) {
  const refresh = useRefreshSetup();
  const [busy, setBusy] = useState(false);
  const repoUrl = `https://github.com/${project.repo.owner}/${project.repo.name}`;
  async function propose() {
    setBusy(true);
    try {
      const pr = await op(
        "policy.proposeTemplate",
        { projectId: project.id },
        { idempotencyKey: submitKey() },
      );
      toast.success("Policy PR opened. Merge it on GitHub and the policy syncs itself.");
      window.open(pr.url, "_blank", "noopener");
      await refresh();
    } catch (error) {
      toast.error(errorText(error), { duration: 15_000 });
    } finally {
      setBusy(false);
    }
  }
  if (project.policy.state === "invalid") {
    return (
      <div className="text-sm" data-testid="policy-invalid">
        <span className="font-medium">{project.name}</span>: .factory/policy.json isn't valid (
        {project.policy.error}).{" "}
        <a
          href={`${repoUrl}/blob/${project.repo.defaultBranch}/.factory/policy.json`}
          target="_blank"
          rel="noreferrer"
          className="underline"
        >
          Open the file
        </a>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="policy-missing">
      <span>
        <span className="font-medium">{project.name}</span>: this repo has no factory policy.
      </span>
      {project.policy.prUrl ? (
        <a href={project.policy.prUrl} target="_blank" rel="noreferrer" className="underline">
          Review the policy PR on GitHub
        </a>
      ) : (
        <Button size="sm" disabled={busy} onClick={propose} data-testid="create-policy-pr">
          {busy ? "Opening PR…" : "Create policy PR"}
        </Button>
      )}
    </div>
  );
}

function CopyLine({ text, testId }: { text: string; testId?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <code className="break-all rounded bg-muted px-2 py-1 font-mono text-xs" data-testid={testId}>
        {text}
      </code>
      <Button
        size="sm"
        variant="outline"
        onClick={() => navigator.clipboard.writeText(text).then(() => toast.success("Copied"))}
      >
        Copy
      </Button>
    </div>
  );
}

function RunnerLogin() {
  return (
    <div className="grid gap-1.5 text-sm" data-testid="runner-login">
      <div>On the machine that will build, from the software-factory checkout, run:</div>
      <CopyLine text={LOGIN_COMMAND} testId="login-command" />
      <div className="text-muted-foreground text-xs">
        It shows a code and a link. Open the link, check the code and approve: the runner gets its
        key and installs itself as a service.
      </div>
    </div>
  );
}

function VerifyAction({ status }: { status: SetupStatus }) {
  const refresh = useRefreshSetup();
  const ready = status.steps.find((s) => s.key === "policy")?.done;
  if (!ready) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <a
        href="https://github.com/timoconnellaus/software-factory/blob/main/docs/deploying.md#branch-protection"
        target="_blank"
        rel="noreferrer"
        className="underline"
      >
        How to require factory/verify
      </a>
      <Button size="sm" variant="ghost" onClick={() => void refresh()}>
        Check again
      </Button>
    </div>
  );
}

/** A project's details: where it points, and a small Re-sync for its policy. */
function ProjectDetails({ project }: { project: ProjectState }) {
  const refresh = useRefreshSetup();
  const [busy, setBusy] = useState(false);
  async function resync() {
    setBusy(true);
    try {
      const r = await op(
        "policy.resync",
        { projectId: project.id },
        { idempotencyKey: submitKey() },
      );
      if (r.valid) toast.success("Policy re-read: valid.");
      else toast.error(`Policy re-read: ${r.error}`);
      await refresh();
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="gap-1 px-5 py-4" data-testid={`project-${project.slug}`}>
      <div className="flex flex-wrap items-center gap-2">
        <StatusDot
          status={
            project.connection.status === "connected" && project.policy.state === "valid"
              ? "done"
              : "waiting"
          }
        />
        <span className="font-semibold">{project.name}</span>
        <a
          href={`https://github.com/${project.repo.owner}/${project.repo.name}`}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-muted-foreground text-xs underline"
        >
          {project.repo.owner}/{project.repo.name}@{project.repo.defaultBranch}
        </a>
      </div>
      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground text-xs">Details</summary>
        <div className="grid gap-1.5 pt-2">
          <div>
            GitHub:{" "}
            {project.connection.status === "connected"
              ? `connected through ${project.connection.account}`
              : project.connection.status === "missing"
                ? "not reachable by a connected installation. Connect GitHub above, or add this repo under Manage repositories."
                : `the installation is ${project.connection.status}`}
            {project.connection.manageUrl && (
              <>
                {" "}
                ·{" "}
                <a
                  href={project.connection.manageUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  Manage repositories on GitHub
                </a>
              </>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span>
              Policy:{" "}
              {project.policySha ? (
                <>
                  {project.policy.state} at{" "}
                  <span className="font-mono text-xs">{project.policySha.slice(0, 7)}</span>
                </>
              ) : (
                "not read yet"
              )}
              . It syncs on every push to {project.repo.defaultBranch}.
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || project.connection.status !== "connected"}
              onClick={resync}
              data-testid="resync-policy"
            >
              {busy ? "Re-syncing…" : "Re-sync"}
            </Button>
          </div>
          {project.verify && !project.verify.ok && (
            <div className="text-muted-foreground text-xs">
              Not yet guarded: {project.verify.problems.join("; ")}
            </div>
          )}
        </div>
      </details>
    </Card>
  );
}

function Runners() {
  const runners = useQuery(runnersQuery());
  const list = runners.data?.runners ?? [];
  return (
    <Card className="gap-3 px-5 py-4" data-testid="runners">
      <div className="flex items-baseline justify-between">
        <div className="font-semibold">Your runners</div>
        <Link to="/runners/connect" search={{}} className="text-xs underline">
          Approve a login code
        </Link>
      </div>
      <div className="grid gap-2">
        {list.map((r) => (
          <div key={r.id} className="flex flex-wrap items-center gap-2 text-sm">
            <StatusDot
              status={
                r.lastSeenAt && Date.now() - Date.parse(r.lastSeenAt) < 120_000 ? "done" : "failed"
              }
            />
            <span className="font-medium">{r.name}</span>
            <span className="text-muted-foreground text-xs">
              seen {ago(r.lastSeenAt)} · {r.capacityMax} slots
            </span>
          </div>
        ))}
        {runners.data && list.length === 0 && (
          <div className="text-muted-foreground text-sm">
            None yet. Run <span className="font-mono text-xs">{LOGIN_COMMAND}</span> on the machine
            that will build.
          </div>
        )}
      </div>
      <PairByKey />
    </Card>
  );
}

/**
 * The old way, kept as a fallback (incident 2026-11-11-bootstrap): register a runner here and pipe
 * its key to `sf-runner pair --key-stdin`. Closed by default; device login is the path.
 */
function PairByKey() {
  const queryClient = useQueryClient();
  const runners = useQuery(runnersQuery());
  const [name, setName] = useState("m5");
  const [key, setKey] = useState<{ runnerId: string; key: string } | null>(null);
  const [busy, setBusy] = useState(false);
  async function register(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await op("runner.register", { name }, { idempotencyKey: submitKey() });
      setKey({ runnerId: r.runnerId, key: r.key });
      await queryClient.invalidateQueries({ queryKey: ["runners"] });
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  async function rotate(runnerId: string) {
    try {
      const r = await op("runner.rotateKey", { runnerId }, { idempotencyKey: submitKey() });
      setKey({ runnerId: r.runnerId, key: r.key });
    } catch (error) {
      toast.error(errorText(error));
    }
  }
  return (
    <details className="text-sm" data-testid="pair-by-key">
      <summary className="cursor-pointer text-muted-foreground text-xs">
        Can't use a login code? Pair with a key instead
      </summary>
      <div className="grid gap-3 pt-3">
        <form onSubmit={register} className="flex flex-wrap items-end gap-2">
          <div className="grid gap-1.5">
            <Label htmlFor="runner-name">Runner name</Label>
            <Input
              id="runner-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>
          <Button type="submit" variant="outline" disabled={busy || !name.trim()}>
            Register runner
          </Button>
        </form>
        {(runners.data?.runners ?? []).map((r) => (
          <div key={r.id} className="flex items-center gap-2 text-xs">
            <span>{r.name}</span>
            <Button size="sm" variant="ghost" onClick={() => rotate(r.id)}>
              Rotate key
            </Button>
          </div>
        ))}
        {key && (
          <div className="grid gap-1 rounded-md border px-3 py-2" data-testid="runner-key">
            <div className="font-medium">Copy this now: it is shown once.</div>
            <div className="text-muted-foreground text-xs">
              Paste the command, copy the key, then press Enter (the command reads the key from the
              clipboard).
            </div>
            <code className="break-all font-mono text-xs" data-testid="pair-command">
              {pairCommand(key.runnerId)}
            </code>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  navigator.clipboard
                    .writeText(pairCommand(key.runnerId))
                    .then(() => toast.success("Command copied"))
                }
              >
                1. Copy command
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  navigator.clipboard.writeText(key.key).then(() => toast.success("Key copied"))
                }
              >
                2. Copy key
              </Button>
            </div>
          </div>
        )}
      </div>
    </details>
  );
}
