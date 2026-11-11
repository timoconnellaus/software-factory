// Turning what a person types into ids: `--project web` into a project, `12` into a work item.
// Work item numbers are per project, so a number needs a project: the one named, or the person's
// only one.
//
// Orgs: no operation lists the caller's orgs (the app reads them from its session), so the CLI takes
// `--org` / `SF_ORG`, or else infers them from `inbox.list`, whose running items carry their org.
import { type Api, result } from "./api.ts";
import { CliError } from "./errors.ts";
import type { ItemSummary, Project } from "./types.ts";

export const WORK_ITEM_ID = /^wi_[0-9a-f]{32}$/;
export const PROJECT_ID = /^prj_[0-9a-f]{32}$/;

export interface Scope {
  api: Api;
  /** `--org` or `SF_ORG`. */
  org?: string | undefined;
}

export async function orgIds({ api, org }: Scope): Promise<string[]> {
  if (org) return [org];
  const { orgs } = await result<{ orgs: { id: string }[] }>(api, "org.list", {});
  if (orgs.length === 0) {
    throw new CliError("no_org", "you aren't in any org yet: sign in to the app first");
  }
  return orgs.map((o) => o.id);
}

export async function listProjects(scope: Scope): Promise<Project[]> {
  const orgs = await orgIds(scope);
  const lists = await Promise.all(
    orgs.map((orgId) => result<{ projects: Project[] }>(scope.api, "project.list", { orgId })),
  );
  return lists.flatMap((l) => l.projects);
}

const names = (projects: Project[]) => projects.map((p) => p.name).join(", ");

/** The project `--project` names (an id, a name or a slug), or the person's only project. */
export async function resolveProject(
  scope: Scope,
  project: string | undefined,
): Promise<Pick<Project, "id"> & Partial<Project>> {
  if (project && PROJECT_ID.test(project)) return { id: project };
  const projects = await listProjects(scope);
  if (project) {
    const wanted = project.toLowerCase();
    const matches = projects.filter(
      (p) => p.name.toLowerCase() === wanted || p.slug.toLowerCase() === wanted,
    );
    const [only] = matches;
    if (only && matches.length === 1) return only;
    if (matches.length > 1) {
      throw new CliError(
        "ambiguous",
        `${matches.length} projects are called ${project}; pass its id: ${matches.map((p) => p.id).join(", ")}`,
      );
    }
    throw new CliError(
      "not_found",
      `no project ${project}${projects.length ? ` (yours: ${names(projects)})` : ""}`,
    );
  }
  const [only] = projects;
  if (only && projects.length === 1) return only;
  if (projects.length === 0) throw new CliError("not_found", "you have no projects yet");
  throw new CliError(
    "ambiguous",
    `you have ${projects.length} projects; pass --project <name>: ${names(projects)}`,
  );
}

/** `12`, `#12` or `wi_…` to a work item id. */
export async function resolveWorkItem(
  scope: Scope,
  ref: string | undefined,
  project: string | undefined,
): Promise<string> {
  if (!ref) throw new CliError("usage", "which work item? Pass its number or wi_… id");
  if (WORK_ITEM_ID.test(ref)) return ref;
  const match = /^#?(\d+)$/.exec(ref);
  if (!match) {
    throw new CliError("usage", `${ref} isn't a work item number or id (wi_…)`);
  }
  const number = Number(match[1]);
  const p = await resolveProject(scope, project);
  const { items } = await result<{ items: ItemSummary[] }>(scope.api, "workItem.list", {
    projectId: p.id,
    number,
    limit: 1,
  });
  const item = items.find((i) => i.number === number);
  if (!item) {
    throw new CliError("not_found", `no work item #${number} in ${p.name ?? p.id}`);
  }
  return item.id;
}
