// The Settings section's rows (spec 41, slice 6): each project's repositories with their GitHub
// connection and protection on the default branch (`project.list`, `setup.status`), the org's GitHub
// installations, and your devices and CLI tokens (`desktopDevice.list`, `cliToken.list`). Pure, so
// the tests pin it.
import type { OpOutput, Project, SetupStatus } from "@software-factory/client/ops";
import type { Status } from "@software-factory/ui/components/status-dot";

export interface RepoRow {
  id: string;
  fullName: string;
  branch: string;
  projectId: string;
  projectName: string;
  connection: { text: string; dot: Status; manageUrl: string | null };
  /** Protection on the default branch, from Setup's check; null when not checked yet. */
  protection: { text: string; dot: Status; detail: string | null } | null;
}

const CONNECTION: Record<Project["connection"]["status"], { text: string; dot: Status }> = {
  connected: { text: "Connected", dot: "done" },
  missing: { text: "The app can't reach it", dot: "failed" },
  suspended: { text: "App suspended", dot: "failed" },
  deleted: { text: "App removed", dot: "failed" },
};

/**
 * One row per repository, project by project (ADR 0490: a project has repositories, and may have
 * none). Protection is tracked per project today, for its first repository (ADR 0280).
 */
export function repoRows(projects: Project[], setups: SetupStatus[]): RepoRow[] {
  const protectionOf = new Map(
    setups.flatMap((s) => s.projects.map((p) => [p.id, p.protection] as const)),
  );
  return projects.flatMap((p) =>
    p.repositories.map((r, i) => {
      const prot = i === 0 ? protectionOf.get(p.id) : undefined;
      return {
        id: r.id,
        fullName: `${r.owner}/${r.name}`,
        branch: r.defaultBranch,
        projectId: p.id,
        projectName: p.name,
        connection: { ...CONNECTION[r.connection.status], manageUrl: r.connection.manageUrl },
        protection: prot
          ? prot.state === "ok"
            ? { text: "Protected", dot: "done", detail: null }
            : prot.state === "red"
              ? { text: "Not protected", dot: "waiting", detail: prot.problems[0] ?? null }
              : { text: "Couldn't check", dot: "idle", detail: prot.warnings[0] ?? null }
          : null,
      };
    }),
  );
}

/** Projects with no repository (work that isn't code, ADR 0490). */
export const projectsWithoutRepos = (projects: Project[]) =>
  projects.filter((p) => p.repositories.length === 0);

type Installation = SetupStatus["installations"][number];

export function installationText(i: Installation): { text: string; dot: Status } {
  const reach = i.repositorySelection === "all" ? "every repository" : "the repositories you chose";
  const who = i.accountType === "Organization" ? `the ${i.account} organisation` : i.account;
  switch (i.status) {
    case "active":
      return { text: `Installed on ${who}, reaching ${reach}.`, dot: "done" };
    case "suspended":
      return { text: `Suspended on ${who}: the factory can't reach GitHub.`, dot: "failed" };
    case "deleted":
      return { text: `Removed from ${who}.`, dot: "failed" };
  }
}

type Device = OpOutput<"desktopDevice.list">["devices"][number];
type Token = OpOutput<"cliToken.list">["tokens"][number];

export interface DeviceRow {
  id: string;
  name: string;
  kind: "desktop" | "cli";
  thisDevice: boolean;
  can: string;
  proves: string;
  added: string;
  lastUsed: string | null;
  expires: string | null;
}

/**
 * Your desktop devices and CLI tokens that still work, this Mac first. Revoked ones and expired
 * tokens are left out: they can do nothing.
 */
export function deviceRows(
  devices: Device[],
  tokens: Token[],
  thisDeviceId: string | null,
  now = Date.now(),
): DeviceRow[] {
  const desktops = devices
    .filter((d) => !d.revokedAt)
    .map((d) => ({
      id: d.id,
      name: d.name,
      kind: "desktop" as const,
      thisDevice: d.id === thisDeviceId,
      can: "Read, write, approve",
      proves: d.keyStorage === "secure-enclave" ? "Touch ID" : "A software key",
      added: d.createdAt,
      lastUsed: d.lastSeenAt,
      expires: null,
    }))
    .sort((a, b) => Number(b.thisDevice) - Number(a.thisDevice));
  const clis = tokens
    .filter((t) => !t.revokedAt && Date.parse(t.expiresAt) > now)
    .map((t) => ({
      id: t.id,
      name: t.name ?? "sf CLI",
      kind: "cli" as const,
      thisDevice: false,
      can: t.scope === "write" ? "Read, write" : "Read",
      proves: "Can't approve",
      added: t.createdAt,
      lastUsed: null,
      expires: t.expiresAt,
    }));
  return [...desktops, ...clis];
}
