// Setup for V1 (handoff: "Setup" operations): add the software-factory project, sync its
// `.factory/policy.json` from the default branch (until the GitHub connector does it on push), and
// register runners (the key is shown once).
import { Button } from "@software-factory/ui/components/button";
import { Card } from "@software-factory/ui/components/card";
import { Input } from "@software-factory/ui/components/input";
import { Label } from "@software-factory/ui/components/label";
import { StatusDot } from "@software-factory/ui/components/status-dot";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { ago } from "#/lib/format";
import { op, submitKey } from "#/lib/op";
import { OpError, type OpInput, type Project } from "#/lib/ops";
import { runnersQuery } from "#/lib/queries";
import { pairCommand } from "#/lib/runner-pairing";
import { useProjects, useSession } from "#/lib/session";
import { syncPolicy } from "#/server/fns";

export const Route = createFileRoute("/_app/setup")({ component: SetupPage });

function SetupPage() {
  const projects = useProjects();
  return (
    <main className="mx-auto grid w-full grid-cols-[minmax(0,1fr)] max-w-[860px] gap-4 p-4 md:p-6">
      <div>
        <h1 className="font-semibold text-2xl tracking-tight">Setup</h1>
        <p className="text-muted-foreground text-sm">
          V1 runs one project, software-factory itself, on your own runner. Configuration lives in
          the repo's <span className="font-mono text-xs">.factory/</span>; this page only connects
          it.
        </p>
      </div>
      {(projects.data ?? []).map((p) => (
        <ProjectCard key={p.id} project={p} />
      ))}
      {projects.data && !projects.data.some((p) => p.slug === "software-factory") && <AddProject />}
      <Runners />
    </main>
  );
}

function errorText(error: unknown) {
  return error instanceof OpError ? error.message : "Something went wrong";
}

function AddProject() {
  const session = useSession();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const orgId = session.personalOrgId;
    if (!orgId) return;
    setBusy(true);
    try {
      // Left empty, the engine looks the installation up as the App (project.create).
      const installation = String(f.get("installation") ?? "").trim();
      const created = await op(
        "project.create",
        {
          orgId,
          name: String(f.get("name")),
          repoOwner: String(f.get("owner")),
          repoName: String(f.get("repo")),
          defaultBranch: String(f.get("branch") || "main"),
          ...(installation ? { githubInstallationId: installation } : {}),
        },
        { idempotencyKey: submitKey() },
      );
      if (created.installationWarning) {
        toast.warning(created.installationWarning, { duration: 15_000 });
      } else {
        toast.success("Project added. Now sync its policy.");
      }
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="gap-3 px-5 py-4">
      <div className="font-semibold">Add the software-factory project</div>
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
        <Field name="name" label="Name" defaultValue="software-factory" />
        <Field name="branch" label="Default branch" defaultValue="main" />
        <Field name="owner" label="Repo owner" defaultValue="timoconnellaus" />
        <Field name="repo" label="Repo" defaultValue="software-factory" />
        <Field
          name="installation"
          label="GitHub App installation id (optional)"
          defaultValue=""
          hint="Leave empty to look it up as the GitHub App."
        />
        <div className="flex items-end">
          <Button type="submit" disabled={busy}>
            Add project
          </Button>
        </div>
      </form>
    </Card>
  );
}

function Field({
  name,
  label,
  defaultValue,
  hint,
}: {
  name: string;
  label: string;
  defaultValue: string;
  hint?: string;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={name}>{label}</Label>
      <Input id={name} name={name} defaultValue={defaultValue} required={!hint} />
      {hint && <span className="text-muted-foreground text-xs">{hint}</span>}
    </div>
  );
}

function ProjectCard({ project }: { project: Project }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<string | null>(null);
  async function sync() {
    setBusy(true);
    try {
      const r = await syncPolicy({ data: { projectId: project.id } });
      if (!r.ok) throw new OpError(r.code, r.message);
      if (r.status !== "ok") throw new OpError("pending", "held for approval");
      const out = r.output as { applied: boolean; valid: boolean; error: string | null };
      setLast(
        out.valid
          ? "Policy is valid and in force."
          : `Policy recorded but not valid: ${out.error}. Agents can't work on this project until it is fixed (fail closed).`,
      );
      if (out.valid) toast.success("Policy synced");
      else toast.error("Policy is not valid");
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
      await queryClient.invalidateQueries({ queryKey: ["routing"] });
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="gap-2 px-5 py-4" data-testid={`project-${project.slug}`}>
      <div className="flex flex-wrap items-center gap-2">
        <StatusDot status={project.policySha ? "done" : "waiting"} />
        <span className="font-semibold">{project.name}</span>
        <a
          href={`https://github.com/${project.repo.owner}/${project.repo.name}`}
          target="_blank"
          rel="noreferrer"
          className="font-mono text-muted-foreground text-xs underline"
        >
          {project.repo.owner}/{project.repo.name}@{project.repo.defaultBranch}
        </a>
        <span className="grow" />
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={sync}
          data-testid="sync-policy"
        >
          {busy ? "Syncing…" : "Sync .factory/policy.json"}
        </Button>
      </div>
      <div className="text-muted-foreground text-sm">
        {project.policySha ? (
          <>
            Policy from <span className="font-mono text-xs">{project.policySha.slice(0, 7)}</span>{" "}
            on {project.repo.defaultBranch}.
          </>
        ) : (
          "No policy synced yet: new work and every agent call are refused until a valid .factory/policy.json is on the default branch."
        )}
        {project.githubInstallationId
          ? ` GitHub App installation ${project.githubInstallationId}.`
          : ""}
      </div>
      {last && <div className="text-sm">{last}</div>}
      <ProjectConnection project={project} />
    </Card>
  );
}

/**
 * The project's GitHub connection, editable (project.update): the App installation and the default
 * branch. A project with no installation gets a warning and a Detect button instead of failing
 * later, when the factory first needs a token (incident 2026-11-11-bootstrap).
 */
function ProjectConnection({ project }: { project: Project }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [installation, setInstallation] = useState(project.githubInstallationId ?? "");
  const [branch, setBranch] = useState(project.repo.defaultBranch);
  const missing = !project.githubInstallationId;

  async function update(input: Omit<OpInput<"project.update">, "projectId">) {
    setBusy(true);
    try {
      const r = await op(
        "project.update",
        { projectId: project.id, ...input },
        { idempotencyKey: submitKey() },
      );
      setProblem(null);
      setInstallation(r.githubInstallationId ?? "");
      setBranch(r.repo.defaultBranch);
      toast.success(
        r.githubInstallationId
          ? `Connected: GitHub App installation ${r.githubInstallationId}.`
          : "Project updated.",
      );
      await queryClient.invalidateQueries({ queryKey: ["projects"] });
    } catch (error) {
      // The engine's reason, word for word: it says what GitHub answered and how to fix it.
      setProblem(errorText(error));
      toast.error(errorText(error), { duration: 15_000 });
    } finally {
      setBusy(false);
    }
  }

  function save(e: FormEvent) {
    e.preventDefault();
    const id = installation.trim();
    const changes: { githubInstallationId?: string | null; defaultBranch?: string } = {};
    if (id !== (project.githubInstallationId ?? "")) changes.githubInstallationId = id || null;
    if (branch.trim() && branch.trim() !== project.repo.defaultBranch) {
      changes.defaultBranch = branch.trim();
    }
    if (Object.keys(changes).length === 0) return;
    void update(changes);
  }

  return (
    <div className="grid gap-2 border-t pt-3" data-testid="project-connection">
      {missing && (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
          data-testid="installation-warning"
        >
          <span className="font-medium">No GitHub App installation.</span> The factory can't read,
          branch or push {project.repo.owner}/{project.repo.name} until one is set. Install the App
          on the repo, then press Detect installation, or enter its id.
        </div>
      )}
      {problem && (
        <div className="text-destructive text-sm" data-testid="installation-problem">
          {problem}
        </div>
      )}
      <form onSubmit={save} className="flex flex-wrap items-end gap-2">
        <div className="grid gap-1.5">
          <Label htmlFor={`inst-${project.id}`}>GitHub App installation id</Label>
          <Input
            id={`inst-${project.id}`}
            className="w-44 font-mono"
            inputMode="numeric"
            pattern="\d*"
            placeholder="none"
            value={installation}
            onChange={(e) => setInstallation(e.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`branch-${project.id}`}>Default branch</Label>
          <Input
            id={`branch-${project.id}`}
            className="w-36 font-mono"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
          />
        </div>
        <Button type="submit" size="sm" variant="outline" disabled={busy}>
          Save
        </Button>
        <Button
          type="button"
          size="sm"
          variant={missing ? "default" : "ghost"}
          disabled={busy}
          onClick={() => update({ detectInstallation: true })}
          data-testid="detect-installation"
        >
          {busy ? "Working…" : "Detect installation"}
        </Button>
      </form>
      {branch.trim() !== project.repo.defaultBranch && (
        <div className="text-muted-foreground text-xs">
          Changing the default branch clears the synced policy: sync it again from the new branch.
        </div>
      )}
    </div>
  );
}

function Runners() {
  const runners = useQuery(runnersQuery());
  const queryClient = useQueryClient();
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
      await queryClient.invalidateQueries({ queryKey: ["inbox"] });
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
    <Card className="gap-3 px-5 py-4" data-testid="runners">
      <div className="font-semibold">Runners</div>
      <div className="grid gap-2">
        {(runners.data?.runners ?? []).map((r) => (
          <div key={r.id} className="flex flex-wrap items-center gap-2 text-sm">
            <StatusDot
              status={
                r.lastSeenAt && Date.now() - Date.parse(r.lastSeenAt) < 120_000 ? "done" : "failed"
              }
            />
            <span className="font-mono">{r.name}</span>
            <span className="font-mono text-muted-foreground text-xs">{r.id}</span>
            <span className="text-muted-foreground text-xs">
              key v{r.keyVersion} · seen {ago(r.lastSeenAt)} · {r.capacityMax} slots
            </span>
            <span className="grow" />
            <Button size="sm" variant="ghost" onClick={() => rotate(r.id)}>
              Rotate key
            </Button>
          </div>
        ))}
        {runners.data?.runners.length === 0 && (
          <div className="text-muted-foreground text-sm">
            No runners yet. Register the M5 below.
          </div>
        )}
      </div>
      <form onSubmit={register} className="flex flex-wrap items-end gap-2">
        <div className="grid gap-1.5">
          <Label htmlFor="runner-name">Runner name</Label>
          <Input id="runner-name" value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <Button type="submit" disabled={busy || !name.trim()}>
          Register runner
        </Button>
      </form>
      {key && (
        <div className="grid gap-1 rounded-md border px-3 py-2 text-sm" data-testid="runner-key">
          <div className="font-medium">Copy this now: it is shown once.</div>
          <div className="text-muted-foreground text-xs">
            On the runner's Mac, from the software-factory checkout: paste the command, copy the
            key, then press Enter (the command reads the key from the clipboard).
          </div>
          <code className="break-all font-mono text-xs" data-testid="pair-command">
            {pairCommand(key.runnerId)}
          </code>
          <code className="break-all font-mono text-xs">key: {key.key}</code>
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
    </Card>
  );
}
