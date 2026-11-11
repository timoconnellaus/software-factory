import { env } from "cloudflare:workers";
import {
  type Actor,
  FOREMAN,
  type InvokeDeps,
  type InvokeResult,
  invoke,
  OperationError,
} from "../src/index.ts";
import { fakeServices } from "../src/testing/index.ts";

export const services = fakeServices(env.DB);
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
  return seed.padEnd(40, "0").replace(/[^0-9a-f]/g, "a").slice(0, 40);
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
  const project = await ok<{ id: string }>(
    "project.create",
    { orgId, name: "Software factory", repoOwner: "timoconnellaus", repoName },
    human,
  );
  const policySha = sha40(uid("p"));
  if (policy !== null) {
    await ok(
      "policy.sync",
      {
        projectId: project.id,
        ref: "refs/heads/main",
        sha: policySha,
        content: typeof policy === "string" ? policy : JSON.stringify(policy),
      },
      human,
    );
  }
  const repo = { installationId: "42", owner: "timoconnellaus", repo: repoName };
  return { userId, orgId, human, projectId: project.id, policySha, repo };
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
