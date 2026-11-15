import { env } from "cloudflare:workers";
import {
  type Actor,
  type InvokeDeps,
  type InvokeResult,
  invoke,
  OperationError,
} from "../src/index.ts";
import { fakeServices, fakeUserToken } from "../src/testing/index.ts";

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

let n = 0;
export const uid = (p: string) => `${p}${Date.now().toString(36)}${(n++).toString(36)}`;

export async function call<O = Record<string, unknown>>(
  op: string,
  input: unknown,
  actor: Actor,
  extra: { idempotencyKey?: string } = {},
): Promise<InvokeResult<O>> {
  return invoke<O>(deps, op, input, { actor, origin: { surface: "test" }, ...extra });
}

/** The output of an `ok` call. */
export async function ok<O = Record<string, unknown>>(
  op: string,
  input: unknown,
  actor: Actor,
  extra: { idempotencyKey?: string } = {},
): Promise<O> {
  return (await call<O>(op, input, actor, extra)).output;
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

/** A user who owns a fresh org. */
export async function world() {
  const userId = uid("usr_");
  const orgId = uid("org_");
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO core_user (id, name, email, github_login, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(userId, "Tim", `${userId}@example.com`, `gh-${userId}`, now, now),
    env.DB.prepare(
      "INSERT INTO core_organization (id, name, slug, kind, created_at) VALUES (?, ?, ?, 'personal', ?)",
    ).bind(orgId, "Personal", orgId, now),
    env.DB.prepare(
      "INSERT INTO core_member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'owner', ?)",
    ).bind(uid("mem_"), orgId, userId, now),
  ]);
  const human: Actor = { type: "human", id: userId };
  return { userId, orgId, human };
}

let repoIds = 1000;
/** A fresh numeric id (GitHub installation and repo ids are numbers). */
export const numericId = () => `${Date.now() % 1_000_000_000}${repoIds++}`;

/**
 * Connects an installation of the App on an organization account the user belongs to, through
 * github.connectStart → connectInstallation, as the website's setup redirect does (ADR 0055).
 */
export async function connect(human: Actor, orgId: string, owner = "acme") {
  const user = await first<{ github_login: string }>(
    "SELECT github_login FROM core_user WHERE id = ?",
    human.id,
  );
  const installationId = numericId();
  await services.github.putInstallation({
    installationId,
    account: { login: owner, type: "Organization" },
    repos: [],
    members: [user.github_login],
  });
  const start = await ok<{ state: string }>("github.connectStart", { orgId }, human);
  const connected = await ok<{ installation: { id: string } }>(
    "github.connectInstallation",
    { installationId, state: start.state, userAccessToken: fakeUserToken(user.github_login) },
    human,
  );
  return { installationId, recordId: connected.installation.id };
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
