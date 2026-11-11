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
import { OpError, type Project } from "#/lib/ops";
import { runnersQuery } from "#/lib/queries";
import { useProjects, useSession } from "#/lib/session";
import { detectInstallation, syncPolicy } from "#/server/fns";

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
      let installation = String(f.get("installation") ?? "").trim();
      if (!installation) {
        const found = await detectInstallation({
          data: { owner: String(f.get("owner")), name: String(f.get("repo")) },
        });
        if (found.installationId) installation = found.installationId;
        else toast.warning(`No GitHub App installation found: ${found.reason}`);
      }
      await op(
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
      toast.success("Project added. Now sync its policy.");
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
          hint="Leave empty to find it from your GitHub sign-in."
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
    </Card>
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
            Give the runner host its id and key (channel{" "}
            <span className="font-mono">https://sf-engine.zerobsai.com/runner/v1</span>).
          </div>
          <code className="break-all font-mono text-xs">runner id: {key.runnerId}</code>
          <code className="break-all font-mono text-xs">key: {key.key}</code>
          <div>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                navigator.clipboard.writeText(`runner id: ${key.runnerId}\nkey: ${key.key}`)
              }
            >
              Copy
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
