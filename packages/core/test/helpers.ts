import { env } from "cloudflare:workers";
import {
  type Actor,
  FOREMAN,
  type InvokeDeps,
  type InvokeResult,
  invoke,
  OperationError,
} from "../src/index.ts";
import { fakeServices, fakeUserToken } from "../src/testing/index.ts";

export const services = fakeServices(env.DB, env.ATTACHMENTS);
export const delivered: string[][] = [];
export const deps: InvokeDeps = {
  d1: env.DB,
  services,
  deliver: async (ids) => {
    delivered.push(ids);
  },
};

export const RUNNER_ACTOR = (id: string): Actor => ({ type: "runner", id });
export { FOREMAN };

let n = 0;
export const uid = (p: string) => `${p}${Date.now().toString(36)}${(n++).toString(36)}`;

export async function call<O = Record<string, unknown>>(
  op: string,
  input: unknown,
  actor: Actor,
  extra: { idempotencyKey?: string; approvalId?: string; floor?: string } = {},
): Promise<InvokeResult<O>> {
  const { floor, ...rest } = extra;
  return invoke<O>({ ...deps, ...(floor !== undefined ? { floor } : {}) }, op, input, {
    actor,
    origin: { surface: "test" },
    ...rest,
  });
}

/** The output of an `ok` call (throws on pending). */
export async function ok<O = Record<string, unknown>>(
  op: string,
  input: unknown,
  actor: Actor,
  extra: { idempotencyKey?: string; approvalId?: string; floor?: string } = {},
): Promise<O> {
  const result = await call<O>(op, input, actor, extra);
  if (result.status !== "ok") throw new Error(`${op} is pending (${result.pendingActionId})`);
  return result.output;
}

export async function refusal(promise: Promise<unknown>): Promise<OperationError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof OperationError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

export const POLICY = {
  version: 1,
  autonomyPolicy: "balanced",
  overrides: { agent: { outbound: "allow" } },
  spec: { requiredFrom: "medium" },
  wipLimit: 3,
};

export function sha40(seed: string): string {
  return seed
    .padEnd(40, "0")
    .replace(/[^0-9a-f]/g, "a")
    .slice(0, 40);
}

/** A user who owns a fresh org with one project whose valid policy is synced. */
export async function world(policy: unknown = POLICY) {
  const userId = uid("usr_");
  const orgId = uid("org_");
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO core_user (id, name, email, github_login, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(userId, "Tim", `${userId}@example.com`, `gh-${userId}`, now, now),
    env.DB.prepare(
      "INSERT INTO core_organization (id, name, slug, kind, github_installation_id, created_at) VALUES (?, ?, ?, 'personal', '42', ?)",
    ).bind(orgId, "Personal", orgId, now),
    env.DB.prepare(
      "INSERT INTO core_member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'owner', ?)",
    ).bind(uid("mem_"), orgId, userId, now),
  ]);
  const human: Actor = { type: "human", id: userId };
  const repoName = uid("repo-");
  const { installationId, project } = await onboard(
    human,
    orgId,
    { owner: "timoconnellaus", name: repoName },
    "Software factory",
  );
  // project.create gives every project a template config (ADR 0370). `null` asks for a project
  // with none at all, as one created before config lived in the app: it fails closed.
  let policySha: string = sha40(uid("p"));
  if (policy === null) {
    await env.DB.prepare("UPDATE core_projects SET policy_sha = NULL WHERE id = ?")
      .bind(project.id)
      .run();
  } else {
    const synced = await ok<{ version: string | null }>(
      "policy.sync",
      {
        projectId: project.id,
        ref: "refs/heads/main",
        sha: policySha,
        content: typeof policy === "string" ? policy : JSON.stringify(policy),
      },
      human,
    );
    policySha = synced.version ?? policySha;
  }
  const repo = { installationId, owner: "timoconnellaus", repo: repoName };
  return { userId, orgId, human, projectId: project.id, policySha, repo };
}

let repoIds = 1000;
/** A fresh numeric id (GitHub installation and repo ids are numbers). */
export const numericId = () => `${Date.now() % 1_000_000_000}${repoIds++}`;

/**
 * Onboards a repo the way Setup does (ADR 0055): an installation of the App on an organization
 * account the user belongs to, connected through github.connectStart → connectInstallation, then
 * project.create from the repo picker's ids.
 */
export async function onboard(
  human: Actor,
  orgId: string,
  repo: { owner: string; name: string; defaultBranch?: string },
  name = repo.name,
) {
  const user = await first<{ github_login: string }>(
    "SELECT github_login FROM core_user WHERE id = ?",
    human.id,
  );
  const installationId = numericId();
  const repoId = Number(numericId());
  await services.github.putInstallation({
    installationId,
    account: { login: repo.owner, type: "Organization" },
    repos: [
      {
        id: repoId,
        owner: repo.owner,
        name: repo.name,
        private: false,
        defaultBranch: repo.defaultBranch ?? "main",
      },
    ],
    members: [user.github_login],
  });
  const start = await ok<{ state: string }>("github.connectStart", { orgId }, human);
  const connected = await ok<{ installation: { id: string } }>(
    "github.connectInstallation",
    {
      installationId,
      state: start.state,
      userAccessToken: fakeUserToken(user.github_login),
    },
    human,
  );
  const project = await ok<{ id: string }>(
    "project.create",
    {
      orgId,
      installationRecordId: connected.installation.id,
      repoId,
      name,
    },
    human,
  );
  return { installationId, installationRecordId: connected.installation.id, repoId, project };
}

export async function newItem(w: Awaited<ReturnType<typeof world>>, title = "Add dark mode") {
  return ok<{ workItemId: string; number: number; branch: string; outcome: string }>(
    "workItem.create",
    { projectId: w.projectId, title, body: `Please ${title.toLowerCase()}.` },
    w.human,
  );
}

export async function rows<T>(sql: string, ...params: unknown[]): Promise<T[]> {
  const { results } = await env.DB.prepare(sql)
    .bind(...params)
    .all<T>();
  return results;
}

export async function first<T>(sql: string, ...params: unknown[]): Promise<T> {
  const [row] = await rows<T>(sql, ...params);
  if (!row) throw new Error(`no row: ${sql}`);
  return row;
}

/**
 * A second repository for a project. `repository.add` refuses one until protection is tracked per
 * repository (ADR 0490 §8), so this checks that refusal and inserts the row the way a later
 * release will allow, to test the code paths that must already key by repository.
 */
export async function secondRepository(
  w: { projectId: string; orgId: string; userId: string; human: Actor },
  repo: { recordId: string; repoId: number; name: string; defaultBranch?: string },
): Promise<{ id: string; projectId: string; name: string; defaultBranch: string }> {
  const refused = await refusal(
    call(
      "repository.add",
      { projectId: w.projectId, installationRecordId: repo.recordId, repoId: repo.repoId },
      w.human,
    ),
  );
  if (refused.code !== "conflict") throw refused;
  const record = await first<{ installation_id: string }>(
    "SELECT installation_id FROM core_github_installations WHERE id = ?",
    repo.recordId,
  );
  const id = `repo_${crypto.randomUUID().replaceAll("-", "")}`;
  const defaultBranch = repo.defaultBranch ?? "main";
  await env.DB.prepare(
    `INSERT INTO core_repositories (id, org_id, project_id, owner, name, default_branch, github_installation_id,
       installation_record_id, github_repo_id, created_at, created_by)
     VALUES (?, ?, ?, 'timoconnellaus', ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      w.orgId,
      w.projectId,
      repo.name,
      defaultBranch,
      record.installation_id,
      repo.recordId,
      repo.repoId,
      new Date().toISOString(),
      w.userId,
    )
    .run();
  return { id, projectId: w.projectId, name: repo.name, defaultBranch };
}
