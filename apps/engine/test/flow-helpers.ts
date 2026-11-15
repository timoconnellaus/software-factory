// The new core's test people (spec 70): a person in their own org, signed in to the CLI with a
// write token, with a runner of theirs on the signed channel. Shared by flow-ops and flow-plugins.
import { env } from "cloudflare:workers";
import { httpControlPlane, runnerChannelKey } from "@software-factory/runner-contract";
import worker from "../src/index.ts";
import { MANIFEST, ok, uid } from "./helpers.ts";

export const base = "https://sf-engine.example";

export const post = (path: string, body: unknown, token?: string) =>
  worker.fetch(
    new Request(`${base}/cli/v1/${path}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    }),
    env,
  );

/** A person in their own org, signed in to the CLI with a write token, and a runner of theirs. */
export async function person() {
  const userId = uid("usr_");
  const orgId = uid("org_");
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO core_user (id, name, email, github_login, created_at, updated_at) VALUES (?, 'Sam', ?, ?, ?, ?)",
    ).bind(userId, `${userId}@example.com`, `gh-${userId}`, now, now),
    env.DB.prepare(
      "INSERT INTO core_organization (id, name, slug, kind, created_at) VALUES (?, 'Acme', ?, 'team', ?)",
    ).bind(orgId, orgId, now),
    env.DB.prepare(
      "INSERT INTO core_member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'owner', ?)",
    ).bind(uid("mem_"), orgId, userId, now),
  ]);
  const human = { type: "human" as const, id: userId };
  const started = (await (
    await post("device/start", { name: "sam@m5", scope: "write" })
  ).json()) as {
    deviceCode: string;
    userCode: string;
  };
  await ok("cli.approveDevice", { userCode: started.userCode, scope: "write" }, human);
  const { token } = (await (
    await post("device/poll", { deviceCode: started.deviceCode })
  ).json()) as {
    token: string;
  };
  const runner = await ok<{ runnerId: string; key: string }>(
    "runner.register",
    { name: "M5" },
    human,
  );
  const channel = httpControlPlane({
    baseUrl: base,
    runnerId: runner.runnerId,
    key: await runnerChannelKey("test-channel-secret", runner.runnerId, 1),
    fetch: async (input, init) => worker.fetch(new Request(input, init), env),
  });
  /** One flow.* call through the door, as this person; throws on a refusal. */
  const call = async <T = Record<string, unknown>>(op: string, input: Record<string, unknown>) => {
    const res = await post("call", { op, input: { orgId, ...input } }, token);
    const body = (await res.json()) as { result?: T; error?: string; code?: string };
    if (res.status !== 200) throw new Error(`${op}: ${res.status} ${body.code} ${body.error}`);
    return body.result as T;
  };
  return { userId, orgId, token, runner, channel, call };
}

export type Person = Awaited<ReturnType<typeof person>>;

export const CAPACITY = { max: 1, inUse: 0, accepting: true, light: { max: 2, inUse: 0 } };

export async function claim(p: Person) {
  return (await p.channel.claim({ claimId: uid("claim-"), manifest: MANIFEST, capacity: CAPACITY }))
    .job;
}
