// Setup is a checklist with live state (ADR 0055, 0056, 0280): GitHub connected · a project · its
// policy · a runner online · `main` protected. Each step shows the one action that fixes it.
// Nothing here asks for an id the factory can fetch (incident 2026-11-11-bootstrap): GitHub's install
// flow brings the installation back, the repo is picked from what the App can reach, the policy
// syncs itself, and a runner logs in with a code.
// Ported from sf-app for spec 40 M3. Differences:
// - Connect GitHub opens GitHub's install page in the browser. GitHub returns to the website, which
//   finishes the connection; the checklist re-reads every 30 s, and Check again re-reads now. So
//   there are no `?github=` banners here.
// - The ruleset downloads come from `protection.ruleset` and are saved to ~/Downloads.
// - Registering a runner, rotating its key and approving a login code are browser-only (ADR 0381):
//   the runner card links to the website for those, and offers to pair this Mac, whose runner the
//   app supervises (This Mac).
// - Project settings live on the website: those links open it.
// - The loader prefetches the checklist, runners and devices in one batch (sf-app had no loader).

import { ago } from "@software-factory/client/format";
import type { SetupStatus } from "@software-factory/client/ops";
import { LOGIN_COMMAND } from "@software-factory/client/runner-pairing";
import { Button } from "@software-factory/ui/components/button";
import { Card } from "@software-factory/ui/components/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@software-factory/ui/components/collapsible";
import { Input } from "@software-factory/ui/components/input";
import { Skeleton } from "@software-factory/ui/components/skeleton";
import { StatusDot } from "@software-factory/ui/components/status-dot";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { createRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { RunnerState } from "../../shared/rpc.ts";
import { bun, onRunner } from "../bridge.ts";
import { PageArea } from "../components/shell-list.tsx";
import { useOrgScope } from "../components/shell-sidebar.tsx";
import { ExternalLink, openExternal, saveFile, WEBSITE_URL } from "../lib/external.tsx";
import { OpError, op, read, submitKey } from "../lib/op.ts";
import { reposQuery, runnersQuery, setupStatusQuery } from "../lib/queries.ts";
import { useSession } from "../lib/session.ts";
import { settingsLayout } from "./_settings.tsx";

/** Desktop devices (ADR 0381), the same key as sf-app's Setup. */
const desktopDevicesQuery = () =>
  queryOptions({
    queryKey: ["desktop-devices"],
    queryFn: () => read("desktopDevice.list", {}),
  });

export const Route = createRoute({
  getParentRoute: () => settingsLayout,
  path: "/setup",
  // Everything the page shows, in one batch. The checklist reads GitHub, so it isn't awaited: the
  // page shows its skeleton until it comes.
  loader: ({ context: { queryClient, session } }) => {
    if (session.personalOrgId) {
      void queryClient.prefetchQuery(setupStatusQuery(session.personalOrgId));
    }
    void queryClient.prefetchQuery(runnersQuery());
    void queryClient.prefetchQuery(desktopDevicesQuery());
  },
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
  // The org the rail has chosen; under All, the Personal org.
  const orgId = useOrgScope() ?? session.personalOrgId ?? "";
  const orgName = session.orgs.find((o) => o.id === orgId)?.name ?? "your org";
  const status = useQuery({ ...setupStatusQuery(orgId), enabled: !!orgId });
  const refresh = useRefreshSetup();
  const [checking, setChecking] = useState(false);
  const done = status.data?.steps.filter((s) => s.done).length ?? 0;
  async function checkAgain() {
    setChecking(true);
    try {
      await refresh();
    } finally {
      setChecking(false);
    }
  }

  return (
    <PageArea className="max-w-[860px]">
      <div className="flex flex-wrap items-end gap-2">
        <div className="grow">
          <h1 className="m-0 font-semibold text-[18px] tracking-[-0.015em]">
            Finish setting up {orgName}
          </h1>
          <p className="m-0 text-ink-3" data-testid="setup-progress">
            {status.data
              ? status.data.complete
                ? "Everything is connected. New work can run end to end."
                : `${done} of ${status.data.steps.length} done. The factory takes no work until the first four are green.`
              : "Checking…"}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={checking}
          onClick={checkAgain}
          data-testid="setup-check-again"
        >
          {checking ? "Checking…" : "Check again"}
        </Button>
      </div>

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
    </PageArea>
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
  // GitHub's install page opens in the browser and returns to the website, which finishes the
  // connection; this checklist sees it on its next read (or Check again).
  const [opened, setOpened] = useState(false);
  async function connect() {
    setBusy(true);
    try {
      const { url } = await op("github.connectStart", { orgId }, { idempotencyKey: submitKey() });
      openExternal(url);
      setOpened(true);
    } catch (error) {
      toast.error(errorText(error));
    } finally {
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
          <ExternalLink href={i.manageUrl} className="text-xs underline" data-testid="manage-repos">
            Manage repositories on GitHub
          </ExternalLink>
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
      {opened && (
        <div className="text-muted-foreground text-xs" data-testid="github-opened">
          Finish on GitHub in your browser. Setup notices within 30 seconds, or press Check again.
        </div>
      )}
    </div>
  );
}

function AddProject({ orgId, open: initiallyOpen }: { orgId: string; open: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  if (!open) {
    return (
      <Button size="sm" variant="outline" onClick={() => setOpen(true)} data-testid="add-project">
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
        <ExternalLink href={`${WEBSITE_URL}/projects/${project.id}/settings`}>
          Open Settings ↗
        </ExternalLink>
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

/** The ruleset files, saved to ~/Downloads (shown in Finder) instead of a browser download. */
function DownloadLinks({ projectId, protection }: { projectId: string; protection: Protection }) {
  const [busy, setBusy] = useState<string | null>(null);
  async function download(kind: Protection["files"][number]["kind"]) {
    setBusy(kind);
    try {
      const file = await read("protection.ruleset", { projectId, kind });
      if (await saveFile(file.filename, file.json)) {
        toast.success(`Saved ${file.filename} to Downloads`);
      } else toast.error(`Couldn't save ${file.filename}`);
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setBusy(null);
    }
  }
  return (
    <>
      {protection.files.map((f) => (
        <Button
          key={f.kind}
          size="sm"
          disabled={busy !== null}
          onClick={() => download(f.kind)}
          data-testid={`download-${f.kind}`}
        >
          {busy === f.kind
            ? "Saving…"
            : `Download ${f.kind === "default-branch" ? "ruleset" : "factory/* ruleset"}`}
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
          <ExternalLink href={protection.rulesetsUrl}>Open GitHub rulesets ↗</ExternalLink>
        </Button>
      </div>
      <div className="text-muted-foreground text-xs">
        On GitHub: New ruleset → Import a ruleset → choose the file (in Downloads) → Create
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
    <Collapsible className="grid gap-1.5" defaultOpen={open} data-testid="send-to-admin">
      <CollapsibleTrigger className="w-fit cursor-pointer text-left text-xs underline">
        {open
          ? "You're not an admin of this repo: send this to the repo admin"
          : "Not a repo admin? Send to the repo admin"}
      </CollapsibleTrigger>
      <CollapsibleContent className="grid gap-2 pt-2">
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
        {project.repo && (
          <ExternalLink
            href={`https://github.com/${project.repo.owner}/${project.repo.name}`}
            className="font-mono text-muted-foreground text-xs underline"
          >
            {project.repo.owner}/{project.repo.name}@{project.repo.defaultBranch}
          </ExternalLink>
        )}
      </div>
      <Collapsible>
        <CollapsibleTrigger className="cursor-pointer text-ink-muted text-xs">
          Details ▾
        </CollapsibleTrigger>
        <CollapsibleContent className="grid gap-1.5 pt-2">
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
                <ExternalLink href={project.connection.manageUrl} className="underline">
                  Manage repositories on GitHub
                </ExternalLink>
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
              <ExternalLink
                href={`${WEBSITE_URL}/projects/${project.id}/settings`}
                className="underline"
              >
                Settings ↗
              </ExternalLink>
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || project.connection.status !== "connected"}
              onClick={resync}
              data-testid="resync-policy"
            >
              {busy ? "Importing…" : "Import from repo"}
            </Button>
          </div>
          {project.protection && project.protection.state !== "ok" && (
            <div className="text-muted-foreground text-xs">
              {project.repo?.defaultBranch ?? "The default branch"} not yet protected:{" "}
              {project.protection.problems.join("; ")}
            </div>
          )}
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

/** Desktop devices (ADR 0381): each Mac signed in to the desktop app, revocable here. */
function DesktopDevices() {
  const devices = useQuery(desktopDevicesQuery());
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
                variant="outline"
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
        <ExternalLink href={`${WEBSITE_URL}/runners/connect`} className="text-xs underline">
          Approve a login code ↗
        </ExternalLink>
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
      <ThisMacRunner />
      <div className="text-muted-foreground text-xs" data-testid="runner-keys-on-website">
        Registering a runner with a key, rotating its key and approving a login code happen on the
        website.{" "}
        <ExternalLink href={`${WEBSITE_URL}/setup`} className="underline">
          Open Setup on the website ↗
        </ExternalLink>
      </div>
    </Card>
  );
}

const THIS_MAC: Record<RunnerState["status"], string> = {
  unpaired: "not paired as a runner yet.",
  launchd: "the runner runs as a launchd service.",
  stopped: "the runner is stopped.",
  starting: "the runner is starting.",
  running: "the runner is running.",
  restarting: "the runner is restarting.",
  locked: "another runner host is running.",
  failed: "the runner failed.",
};

/**
 * This Mac's runner, which the app supervises (spec 40 M2): pair it from here; its state and
 * controls are on This Mac.
 */
function ThisMacRunner() {
  const client = useQueryClient();
  const runner = useQuery({ queryKey: ["runner"], queryFn: () => bun.runnerState({}) });
  useEffect(() => onRunner((s) => client.setQueryData(["runner"], s)), [client]);
  const [busy, setBusy] = useState(false);
  async function pair() {
    setBusy(true);
    try {
      client.setQueryData(["runner"], await bun.runnerAction({ action: "pair" }));
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  const unpaired = runner.data?.status === "unpaired";
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="this-mac-runner">
      <span>This Mac: {runner.data ? THIS_MAC[runner.data.status] : "…"}</span>
      {unpaired && (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={pair}
          data-testid="pair-this-mac"
        >
          {busy ? "Pairing…" : "Pair this Mac"}
        </Button>
      )}
      <Link to="/settings" className="text-xs underline">
        This Mac
      </Link>
    </div>
  );
}
