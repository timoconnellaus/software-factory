import { env } from "cloudflare:workers";
import { type Actor, type InvokeResult, invoke } from "@software-factory/core";
import { fakeGitHub, fakeUserToken } from "@software-factory/core/testing";
import { type CapabilityManifest, CONTRACT_VERSION } from "@software-factory/runner-contract";
import { invokeDeps } from "../src/deps.ts";

export const github = fakeGitHub(env.DB);

let n = 0;
export const uid = (p: string) => `${p}${Date.now().toString(36)}${(n++).toString(36)}`;

export async function call<O = Record<string, unknown>>(
  op: string,
  input: unknown,
  actor: Actor,
): Promise<InvokeResult<O>> {
  return invoke<O>(invokeDeps(env), op, input, { actor, origin: { surface: "test" } });
}

export async function ok<O = Record<string, unknown>>(
  op: string,
  input: unknown,
  actor: Actor,
): Promise<O> {
  return (await call<O>(op, input, actor)).output;
}

export const MANIFEST: CapabilityManifest = {
  contractVersion: CONTRACT_VERSION,
  runnerKind: "test",
  harnesses: ["claude-code"],
  capabilities: ["hooks", "headless", "flow"],
};

/**
 * A person who owns a fresh org with the GitHub App's installation connected (as the website's
 * setup redirect does it, ADR 0055) and a registered runner.
 */
export async function world() {
  const userId = uid("usr_");
  const orgId = uid("org_");
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO core_user (id, name, email, github_login, created_at, updated_at) VALUES (?, 'Tim', ?, ?, ?, ?)",
    ).bind(userId, `${userId}@example.com`, `gh-${userId}`, now, now),
    env.DB.prepare(
      "INSERT INTO core_organization (id, name, slug, kind, created_at) VALUES (?, 'Personal', ?, 'personal', ?)",
    ).bind(orgId, orgId, now),
    env.DB.prepare(
      "INSERT INTO core_member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'owner', ?)",
    ).bind(uid("mem_"), orgId, userId, now),
  ]);
  const human: Actor = { type: "human", id: userId };
  const installationId = `${Date.now() % 1_000_000_000}${n++}`;
  await github.putInstallation({
    installationId,
    account: { login: "timoconnellaus", type: "Organization" },
    repos: [],
    members: [`gh-${userId}`],
  });
  const started = await ok<{ state: string }>("github.connectStart", { orgId }, human);
  const connected = await ok<{ installation: { id: string } }>(
    "github.connectInstallation",
    { installationId, state: started.state, userAccessToken: fakeUserToken(`gh-${userId}`) },
    human,
  );
  const runner = await ok<{ runnerId: string; key: string }>(
    "runner.register",
    { name: "M5" },
    human,
  );
  const runnerActor: Actor = { type: "runner", id: runner.runnerId };
  return {
    userId,
    orgId,
    human,
    runner,
    runnerActor,
    installationId,
    installationRecordId: connected.installation.id,
  };
}
export type World = Awaited<ReturnType<typeof world>>;

export async function waitFor<T>(
  what: string,
  probe: () => Promise<T | null | undefined | false>,
  ms = 15_000,
): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

export async function first<T>(sql: string, ...params: unknown[]): Promise<T | null> {
  return env.DB.prepare(sql)
    .bind(...params)
    .first<T>();
}

export async function all<T>(sql: string, ...params: unknown[]): Promise<T[]> {
  return (
    await env.DB.prepare(sql)
      .bind(...params)
      .all<T>()
  ).results;
}
