// Setup is a checklist with live state (ADR 0055, 0056, 0280): GitHub connected · a project · its
// policy · a runner online · `main` protected. Each step shows the one action that fixes it.
// Nothing here asks for an id the factory can fetch (incident 2026-11-11-bootstrap): GitHub's install
// flow brings the installation back, the repo is picked from what the App can reach, the policy
// syncs itself, and a runner logs in with a code.

import { ago } from "@software-factory/client/format";
import { LOGIN_COMMAND, pairCommand } from "@software-factory/client/runner-pairing";
import { Button } from "@software-factory/ui/components/button";
import { Card } from "@software-factory/ui/components/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@software-factory/ui/components/collapsible";
import { Input } from "@software-factory/ui/components/input";
import { Label } from "@software-factory/ui/components/label";
import { Skeleton } from "@software-factory/ui/components/skeleton";
import { StatusDot } from "@software-factory/ui/components/status-dot";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { type RunnerAccounts, RunnerAccountsView } from "#/components/runner-accounts";
import { op, submitKey } from "#/lib/op";
import { OpError, type SetupStatus } from "#/lib/ops";
import { reposQuery, runnersQuery, setupStatusQuery } from "#/lib/queries";
import { rulesetDownloadPath } from "#/lib/ruleset";
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
  protect: "Protect main",
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
      <DesktopDevices />
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
      <Button
        variant="link"
        size="sm"
        className="h-auto p-0 text-muted-foreground text-xs underline"
        onClick={onClose}
      >
        Dismiss
      </Button>
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
    case "protect":
      return <ProtectAction status={status} />;
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
  // Config lives in the app (ADR 0370): every project gets one when it's added, and a broken one
  // is fixed in its Settings, never with a PR.
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="policy-missing">
      <span>
        <span className="font-medium">{project.name}</span>:{" "}
        {project.policy.state === "invalid"
          ? `the factory config isn't valid (${project.policy.error}).`
          : "this project has no factory config yet."}
      </span>
      <Button size="sm" asChild data-testid="open-settings">
        <Link to="/projects/$projectId/settings" params={{ projectId: project.id }}>
          Open Settings
        </Link>
      </Button>
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

/**
 * Protect `main` (ADR 0280). The factory's App can only read repository settings, so a person
 * applies the ruleset: download the file, open GitHub's rulesets page, import it, then Check now.
 * Someone who isn't a repo admin gets a message to send to one instead.
 */
function ProtectAction({ status }: { status: SetupStatus }) {
  const ready = status.steps.find((s) => s.key === "policy")?.done;
  if (!ready) return null;
  const projects = status.projects.filter((p) => p.protection && p.policy.state === "valid");
  return (
    <div className="grid gap-3">
      {status.missingEvents.length > 0 && (
        <div className="text-sm" data-testid="missing-events">
          So the factory notices when protection changes, tick these events in the GitHub App's{" "}
          <span className="font-medium">Permissions &amp; events</span> settings:{" "}
          {status.missingEvents.map((e, i) => (
            <span key={e}>
              {i ? ", " : ""}
              <code className="font-mono text-xs">{e}</code>
            </span>
          ))}
          . Until then it re-checks once a day.
        </div>
      )}
      {projects.map((p) => (
        <ProtectProject key={p.id} project={p} showName={projects.length > 1} />
      ))}
    </div>
  );
}

type Protection = NonNullable<ProjectState["protection"]>;

function ProtectProject({ project, showName }: { project: ProjectState; showName: boolean }) {
  const refresh = useRefreshSetup();
  const [busy, setBusy] = useState(false);
  const protection = project.protection as Protection;
  async function check() {
    setBusy(true);
    try {
      const r = await op(
        "protection.check",
        { projectId: project.id },
        { idempotencyKey: submitKey() },
      );
      if (r.state === "ok") toast.success(`${protection.branch} is protected.`);
      else toast.error(`Not yet: ${r.problems.length} thing(s) missing.`);
      await refresh();
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  const ok = protection.state === "ok";
  return (
    <div className="grid gap-2 text-sm" data-testid={`protect-${project.slug}`}>
      {showName && <div className="font-medium">{project.name}</div>}
      {ok ? (
        <div data-testid="protect-ok">
          ✓ <span className="font-mono text-xs">{protection.branch}</span> needs a PR with ci and
          factory/verify, up to date; no force pushes, no deletion, no bypass.
        </div>
      ) : (
        <ul className="grid list-disc gap-0.5 pl-5" data-testid="protect-problems">
          {protection.problems.map((p) => (
            <li key={p}>
              <Ticks text={p} />
            </li>
          ))}
        </ul>
      )}
      {protection.warnings.length > 0 && (
        <ul className="grid gap-0.5 text-muted-foreground text-xs">
          {protection.warnings.map((w) => (
            <li key={w}>
              <Ticks text={w} />
            </li>
          ))}
        </ul>
      )}
      {!ok && protection.viewerIsRepoAdmin !== false && (
        <ApplyRuleset projectId={project.id} protection={protection} />
      )}
      {!ok && protection.viewerIsRepoAdmin !== true && (
        <SendToAdmin
          projectId={project.id}
          protection={protection}
          open={protection.viewerIsRepoAdmin === false}
        />
      )}
      <div>
        <Button
          size="sm"
          variant={ok ? "ghost" : "outline"}
          disabled={busy}
          onClick={check}
          data-testid="protect-check"
        >
          {busy ? "Checking…" : "Check now"}
        </Button>
      </div>
    </div>
  );
}

/** Renders `code` spans in the verifier's messages. */
function Ticks({ text }: { text: string }) {
  return (
    <>
      {text.split(/(`[^`]+`)/).map((part, i) =>
        part.startsWith("`") && part.endsWith("`") ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed split of one string.
          <code key={i} className="font-mono text-xs">
            {part.slice(1, -1)}
          </code>
        ) : (
          part
        ),
      )}
    </>
  );
}

function DownloadLinks({ projectId, protection }: { projectId: string; protection: Protection }) {
  return (
    <>
      {protection.files.map((f) => (
        <Button key={f.kind} size="sm" asChild data-testid={`download-${f.kind}`}>
          <a href={rulesetDownloadPath(projectId, f.kind)} download={f.filename}>
            Download {f.kind === "default-branch" ? "ruleset" : "factory/* ruleset"}
          </a>
        </Button>
      ))}
    </>
  );
}

function ApplyRuleset({ projectId, protection }: { projectId: string; protection: Protection }) {
  return (
    <div className="grid gap-1.5" data-testid="apply-ruleset">
      <div className="flex flex-wrap items-center gap-2">
        <DownloadLinks projectId={projectId} protection={protection} />
        <Button size="sm" variant="outline" asChild data-testid="open-rulesets">
          <a href={protection.rulesetsUrl} target="_blank" rel="noreferrer">
            Open GitHub rulesets ↗
          </a>
        </Button>
      </div>
      <div className="text-muted-foreground text-xs">
        On GitHub: New ruleset → Import a ruleset → choose the file → Create
        {protection.files.length > 1 ? " (once for each file)" : ""}. Then Check now.
      </div>
    </div>
  );
}

function SendToAdmin({
  projectId,
  protection,
  open,
}: {
  projectId: string;
  protection: Protection;
  open: boolean;
}) {
  return (
    <Collapsible
      className="group/collapsible grid gap-1.5"
      defaultOpen={open}
      data-testid="send-to-admin"
    >
      <CollapsibleTrigger className="flex items-center gap-1 text-left cursor-pointer text-xs">
        <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-data-[state=open]/collapsible:rotate-90" />
        {open
          ? "You're not an admin of this repo: send this to the repo admin"
          : "Not a repo admin? Send to the repo admin"}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="grid gap-2 pt-2">
          <pre className="whitespace-pre-wrap rounded bg-muted px-3 py-2 font-mono text-xs">
            {protection.adminMessage}
          </pre>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                navigator.clipboard
                  .writeText(protection.adminMessage)
                  .then(() => toast.success("Message copied"))
              }
              data-testid="copy-admin-message"
            >
              Copy message
            </Button>
            <DownloadLinks projectId={projectId} protection={protection} />
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
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
      if (r.valid)
        toast.success("Imported the repo's .factory/policy.json as a new config version.");
      else toast.error(`Import failed: ${r.error}`);
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
      <Collapsible className="group/collapsible text-sm">
        <CollapsibleTrigger className="flex items-center gap-1 text-left cursor-pointer text-muted-foreground text-xs">
          <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-data-[state=open]/collapsible:rotate-90" />
          Details
        </CollapsibleTrigger>
        <CollapsibleContent>
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
                Config:{" "}
                {project.configVersion !== null ? (
                  <>
                    <span className="font-mono text-xs">v{project.configVersion}</span>
                    {project.policy.state !== "valid" ? ` (${project.policy.state})` : ""}
                  </>
                ) : (
                  "none yet"
                )}
                {" · "}
                <Link
                  to="/projects/$projectId/settings"
                  params={{ projectId: project.id }}
                  className="underline"
                >
                  Settings
                </Link>
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy || project.connection.status !== "connected"}
                onClick={resync}
                data-testid="resync-policy"
              >
                {busy ? "Importing…" : "Import from repo"}
              </Button>
            </div>
            {project.protection && project.protection.state !== "ok" && (
              <div className="text-muted-foreground text-xs">
                {project.repo.defaultBranch} not yet protected:{" "}
                {project.protection.problems.join("; ")}
              </div>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

/** Desktop devices (ADR 0391): each Mac signed in to the desktop app, revocable here. */
function DesktopDevices() {
  const devices = useQuery({
    queryKey: ["desktop-devices"],
    queryFn: () => op("desktopDevice.list", {}),
  });
  const [busy, setBusy] = useState<string | null>(null);
  async function revoke(deviceId: string) {
    setBusy(deviceId);
    try {
      await op("desktopDevice.revoke", { deviceId }, { idempotencyKey: submitKey() });
      await devices.refetch();
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setBusy(null);
    }
  }
  const list = devices.data?.devices ?? [];
  return (
    <Card className="gap-3 px-5 py-4" data-testid="desktop-devices">
      <div className="font-semibold">Desktop app devices</div>
      <div className="grid gap-2">
        {list.map((d) => (
          <div key={d.id} className="flex flex-wrap items-center gap-2 text-sm">
            <StatusDot status={d.revokedAt ? "idle" : "done"} />
            <span className="font-medium">{d.name}</span>
            <span className="text-muted-foreground text-xs">
              {d.revokedAt ? "revoked" : `seen ${ago(d.lastSeenAt)}`}
              {d.keyStorage === "software" ? " · software key" : ""}
            </span>
            {!d.revokedAt && (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy === d.id}
                onClick={() => revoke(d.id)}
              >
                Revoke
              </Button>
            )}
          </div>
        ))}
        {devices.data && list.length === 0 && (
          <div className="text-muted-foreground text-sm">
            None yet. Sign in from the desktop app to add this Mac.
          </div>
        )}
      </div>
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
            <RunnerAccountPicker runnerId={r.id} accounts={r.accounts} />
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
 * Which Claude account the runner's new jobs use (ADR 0410). Sends the name only; the runner's
 * host switches on its next heartbeat. The runner's owner only (the operation checks).
 */
function RunnerAccountPicker({
  runnerId,
  accounts,
}: {
  runnerId: string;
  accounts: RunnerAccounts | null;
}) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  async function pick(name: string) {
    setBusy(true);
    try {
      await op("runner.account.use", { runnerId, name }, { idempotencyKey: submitKey() });
      await queryClient.invalidateQueries({ queryKey: ["runners"] });
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  return <RunnerAccountsView accounts={accounts} busy={busy} onPick={(n) => void pick(n)} />;
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
    <Collapsible className="group/collapsible text-sm" data-testid="pair-by-key">
      <CollapsibleTrigger className="flex items-center gap-1 text-left cursor-pointer text-muted-foreground text-xs">
        <ChevronRightIcon className="size-3.5 shrink-0 transition-transform group-data-[state=open]/collapsible:rotate-90" />
        Can't use a login code? Pair with a key instead
      </CollapsibleTrigger>
      <CollapsibleContent>
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
                Paste the command, copy the key, then press Enter (the command reads the key from
                the clipboard).
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
      </CollapsibleContent>
    </Collapsible>
  );
}
