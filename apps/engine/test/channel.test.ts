import { env } from "cloudflare:workers";
import { FOREMAN } from "@software-factory/core";
import {
  ChannelCallError,
  DEVICE_PATHS,
  httpControlPlane,
  PATHS,
  RUNNER_COMPAT,
  runnerChannelKey,
  signRunnerRequest,
} from "@software-factory/runner-contract";
import { describe, expect, it } from "vitest";
import worker from "../src/index.ts";
import { all, first, MANIFEST, ok, uid, waitFor, world } from "./helpers.ts";
import { type Recorded, recordingEnv } from "./query-plans.ts";

const base = "https://sf-engine.example";
const engineFetch: typeof fetch = async (input, init) =>
  worker.fetch(new Request(input, init), env);

async function client(runnerId: string, opts: { now?: () => Date; key?: string } = {}) {
  return httpControlPlane({
    baseUrl: base,
    runnerId,
    key: opts.key ?? (await runnerChannelKey("test-channel-secret", runnerId, 1)),
    fetch: engineFetch,
    ...(opts.now ? { now: opts.now } : {}),
  });
}

describe("the signed runner channel", () => {
  it("serves heartbeat and claim to a registered runner with its key", async () => {
    const w = await world();
    expect(w.runner.key).toBe(await runnerChannelKey("test-channel-secret", w.runner.runnerId, 1));
    const c = await client(w.runner.runnerId);
    const beat = await c.heartbeat({
      manifest: MANIFEST,
      capacity: { max: 2, inUse: 0, accepting: true },
      activeJobs: [],
    });
    expect(beat).toEqual({
      commands: [],
      leases: [],
      desiredVersion: null,
      minRunnerCompat: RUNNER_COMPAT,
      engine: { capabilities: ["job-line"] },
    });
    const seen = await first<{ capacity_max: number; last_seen_at: string }>(
      "SELECT capacity_max, last_seen_at FROM core_runners WHERE id = ?",
      w.runner.runnerId,
    );
    expect(seen?.capacity_max).toBe(2);
    // Naturally idempotent, so never stored in the channel's idempotency store.
    expect(
      await all("SELECT 1 FROM core_channel_requests WHERE runner_id = ?", w.runner.runnerId),
    ).toEqual([]);
  });

  it("refuses a bad signature, a stale timestamp, an unknown runner and a revoked key", async () => {
    const w = await world();
    const wrongKey = await client(w.runner.runnerId, { key: "not-the-key" });
    const bad = await wrongKey
      .heartbeat({
        manifest: MANIFEST,
        capacity: { max: 1, inUse: 0, accepting: true },
        activeJobs: [],
      })
      .catch((e) => e);
    expect(bad).toBeInstanceOf(ChannelCallError);
    expect((bad as ChannelCallError).status).toBe(401);

    const stale = await client(w.runner.runnerId, { now: () => new Date(Date.now() - 6 * 60_000) });
    const old = await stale
      .heartbeat({
        manifest: MANIFEST,
        capacity: { max: 1, inUse: 0, accepting: true },
        activeJobs: [],
      })
      .catch((e) => e);
    expect((old as ChannelCallError).status).toBe(401);

    const ghost = await client("r_doesnotexist0");
    expect(
      (
        (await ghost
          .heartbeat({
            manifest: MANIFEST,
            capacity: { max: 1, inUse: 0, accepting: true },
            activeJobs: [],
          })
          .catch((e) => e)) as ChannelCallError
      ).status,
    ).toBe(401);

    const rotated = await ok<{ key: string; keyVersion: number }>(
      "runner.rotateKey",
      { runnerId: w.runner.runnerId },
      w.human,
    );
    expect(rotated.keyVersion).toBe(2);
    const oldKey = await client(w.runner.runnerId);
    expect(
      (
        (await oldKey
          .heartbeat({
            manifest: MANIFEST,
            capacity: { max: 1, inUse: 0, accepting: true },
            activeJobs: [],
          })
          .catch((e) => e)) as ChannelCallError
      ).status,
    ).toBe(401);
    const newKey = await client(w.runner.runnerId, { key: rotated.key });
    await newKey.heartbeat({
      manifest: MANIFEST,
      capacity: { max: 1, inUse: 0, accepting: true },
      activeJobs: [],
    });
  });

  it("a heartbeat no newer than the last changes no runner state but still renews its leases", async () => {
    const w = await world();
    const item = await ok<{ workItemId: string }>(
      "workItem.create",
      { state: "queued", projectId: w.projectId, title: "Beat" },
      w.human,
    );
    const c = await client(w.runner.runnerId);
    let job = null;
    for (let i = 0; i < 100 && !job; i++) {
      job = (
        await c.claim({
          claimId: uid("claim-"),
          manifest: MANIFEST,
          capacity: { max: 4, inUse: 0, accepting: true },
        })
      ).job;
      if (!job) await new Promise((r) => setTimeout(r, 50));
    }
    if (!job) throw new Error("no job");
    // The setup's claim was signed now; the beats below are signed earlier.
    await env.DB.prepare("UPDATE core_runners SET last_signed_at = NULL WHERE id = ?")
      .bind(w.runner.runnerId)
      .run();
    const held = [{ jobId: job.jobId, fencingToken: job.lease.fencingToken }];
    let n = 0;
    const send = async (capacityMax: number, at: Date) => {
      const body = JSON.stringify({
        manifest: MANIFEST,
        capacity: { max: capacityMax, inUse: 1, accepting: true },
        activeJobs: held,
      });
      return worker.fetch(
        new Request(`${base}${PATHS.heartbeat}`, {
          method: "POST",
          headers: await signRunnerRequest({
            key: w.runner.key,
            runner: w.runner.runnerId,
            method: "POST",
            path: PATHS.heartbeat,
            body,
            idempotencyKey: `beat:order-${String(++n).padStart(4, "0")}`,
            now: at,
          }),
          body,
        }),
        env,
      );
    };
    const capacity = async () =>
      (
        await first<{ capacity_max: number }>(
          "SELECT capacity_max FROM core_runners WHERE id = ?",
          w.runner.runnerId,
        )
      )?.capacity_max;
    const OLD = "2000-01-01T00:00:00.000Z";
    const ageLease = () =>
      env.DB.prepare("UPDATE core_leases SET expires_at = ? WHERE work_item_id = ?")
        .bind(OLD, item.workItemId)
        .run();
    const leaseRenewed = async () =>
      (
        await first<{ expires_at: string }>(
          "SELECT expires_at FROM core_leases WHERE work_item_id = ?",
          item.workItemId,
        )
      )?.expires_at !== OLD;
    const now = Date.now();

    // Out of order (or a captured beat replayed): the older one reports nothing, renews the lease.
    expect((await send(3, new Date(now - 40_000))).status).toBe(200);
    expect((await send(2, new Date(now - 30_000))).status).toBe(200);
    await ageLease();
    expect((await send(1, new Date(now - 40_000))).status).toBe(200);
    expect(await capacity()).toBe(2);
    expect(await leaseRenewed()).toBe(true);

    // `sf-runner doctor`'s beat in the same second as the service's: the same.
    await ageLease();
    expect((await send(1, new Date(now - 30_000))).status).toBe(200);
    expect(await capacity()).toBe(2);
    expect(await leaseRenewed()).toBe(true);

    // A clock that ran ahead and was put back: its beats keep the lease until real time catches up.
    expect((await send(5, new Date(now + 120_000))).status).toBe(200);
    await ageLease();
    expect((await send(2, new Date(now))).status).toBe(200);
    expect(await capacity()).toBe(5);
    expect(await leaseRenewed()).toBe(true);
    expect((await send(4, new Date(now + 121_000))).status).toBe(200);
    expect(await capacity()).toBe(4);
  });

  it("an old claim replayed gets nothing and writes nothing; a lost response's retry gets its job", async () => {
    const w = await world();
    let n = 0;
    const claim = async (claimId: string, at: Date, capacityMax: number, key?: string) => {
      const body = JSON.stringify({
        claimId,
        manifest: MANIFEST,
        capacity: { max: capacityMax, inUse: 0, accepting: true },
      });
      const res = await worker.fetch(
        new Request(`${base}${PATHS.claim}`, {
          method: "POST",
          headers: await signRunnerRequest({
            key: w.runner.key,
            runner: w.runner.runnerId,
            method: "POST",
            path: PATHS.claim,
            body,
            idempotencyKey: key ?? `claim:order-${String(++n).padStart(4, "0")}`,
            now: at,
          }),
          body,
        }),
        env,
      );
      expect(res.status).toBe(200);
      return ((await res.json()) as { job: { jobId: string } | null }).job;
    };
    const capacity = async () =>
      (
        await first<{ capacity_max: number }>(
          "SELECT capacity_max FROM core_runners WHERE id = ?",
          w.runner.runnerId,
        )
      )?.capacity_max;
    const now = Date.now();
    // An empty claim, then a newer one, then work arrives.
    expect(await claim("claim-old-empty", new Date(now - 60_000), 1, "claim:old-empty")).toBeNull();
    expect(await claim("claim-newer", new Date(now - 40_000), 3)).toBeNull();
    const item = await ok<{ workItemId: string }>(
      "workItem.create",
      { state: "queued", projectId: w.projectId, title: "Replayed" },
      w.human,
    );
    await waitFor("a queued job", () =>
      first(
        "SELECT id FROM core_jobs WHERE work_item_id = ? AND status = 'queued'",
        item.workItemId,
      ),
    );
    // The old empty claim replayed: nothing, and its old capacity isn't written back.
    expect(await claim("claim-old-empty", new Date(now - 60_000), 1, "claim:old-empty")).toBeNull();
    expect(await capacity()).toBe(3);
    expect(
      await all(
        "SELECT 1 FROM core_jobs WHERE work_item_id = ? AND status = 'queued'",
        item.workItemId,
      ),
    ).toHaveLength(1);
    // Out of order: a claim signed before the last accepted one gets nothing either.
    expect(await claim("claim-late", new Date(now - 50_000), 2)).toBeNull();
    // A real claim, then its exact retry after a lost response: the same job.
    const got = await claim("claim-real", new Date(now - 30_000), 3, "claim:real");
    expect(got).not.toBeNull();
    const retried = await claim("claim-real", new Date(now - 30_000), 3, "claim:real");
    expect(retried?.jobId).toBe(got?.jobId);
  });

  it("a retried claim gets the same job, never a second, without the idempotency store", async () => {
    const w = await world();
    const item = await ok<{ workItemId: string }>(
      "workItem.create",
      { state: "queued", projectId: w.projectId, title: "Replay" },
      w.human,
    );
    await ok(
      "workItem.create",
      { state: "queued", projectId: w.projectId, title: "Next" },
      w.human,
    );
    await waitFor("two queued jobs", async () => {
      const rows = await all(
        "SELECT 1 FROM core_jobs WHERE project_id = ? AND status = 'queued'",
        w.projectId,
      );
      return rows.length >= 2;
    });
    const body = JSON.stringify({
      claimId: "claim-replay-1",
      manifest: MANIFEST,
      capacity: { max: 4, inUse: 0, accepting: true },
    });
    const signed = async () =>
      new Request(`${base}${PATHS.claim}`, {
        method: "POST",
        headers: await signRunnerRequest({
          key: w.runner.key,
          runner: w.runner.runnerId,
          method: "POST",
          path: PATHS.claim,
          body,
          idempotencyKey: `claim:${w.runner.runnerId}:claim-replay-1`,
        }),
        body,
      });
    // Two at once (a retry racing the first) and one after: one job, the same one each time.
    const answers = await Promise.all([
      worker.fetch(await signed(), env),
      worker.fetch(await signed(), env),
    ]);
    const later = await worker.fetch(await signed(), env);
    const jobs = new Set<string>();
    for (const res of [...answers, later]) {
      if (res.status === 409) continue; // the loser of the race: "the state changed"
      expect(res.status).toBe(200);
      expect(res.headers.get("x-sf-replayed")).toBeNull();
      const out = (await res.json()) as { job: { jobId: string; workItem: { id: string } } | null };
      if (out.job) jobs.add(out.job.jobId);
    }
    expect(jobs.size).toBe(1);
    const claimed = await all<{ id: string }>(
      "SELECT id FROM core_jobs WHERE runner_id = ? AND claim_id = 'claim-replay-1'",
      w.runner.runnerId,
    );
    expect(claimed.map((j) => j.id)).toEqual([...jobs]);
    expect(
      await all("SELECT 1 FROM core_runs WHERE work_item_id = ?", item.workItemId),
    ).toHaveLength(1);
    // Audited once as a claim: not its retries (a race's loser is recorded as a conflict); and
    // nothing stored for it.
    expect(
      await all(
        "SELECT id FROM core_audit WHERE operation = 'job.claim' AND actor_id = ? AND outcome = 'ok'",
        w.runner.runnerId,
      ),
    ).toHaveLength(1);
    expect(
      await all(
        "SELECT 1 FROM core_channel_requests WHERE runner_id = ? AND idempotency_key LIKE 'claim:%'",
        w.runner.runnerId,
      ),
    ).toEqual([]);

    // A stored call (hand-back events) is still answered from the store on a replay.
    const [jobId] = [...jobs];
    const lease = await first<{ fencing_token: number }>(
      "SELECT fencing_token FROM core_leases WHERE work_item_id = ?",
      item.workItemId,
    );
    const eventsBody = JSON.stringify({
      fencingToken: lease?.fencing_token,
      events: [
        {
          type: "log",
          stream: "terminal",
          text: "hi",
          jobId,
          seq: 1,
          at: new Date().toISOString(),
        },
      ],
    });
    const path = PATHS.events(jobId as string);
    const signedEvents = async () =>
      new Request(`${base}${path}`, {
        method: "POST",
        headers: await signRunnerRequest({
          key: w.runner.key,
          runner: w.runner.runnerId,
          method: "POST",
          path,
          body: eventsBody,
          idempotencyKey: `events:${jobId}:replay-1`,
        }),
        body: eventsBody,
      });
    const firstEvents = await worker.fetch(await signedEvents(), env);
    const againEvents = await worker.fetch(await signedEvents(), env);
    expect(await againEvents.text()).toBe(await firstEvents.text());
    expect(againEvents.headers.get("x-sf-replayed")).toBe("1");
  });

  it("maps a fenced write to 409 with code `fenced`, and never stores the job token", async () => {
    const w = await world();
    const item = await ok<{ workItemId: string }>(
      "workItem.create",
      { state: "queued", projectId: w.projectId, title: "Channel item" },
      w.human,
    );
    const c = await client(w.runner.runnerId);
    let job = null;
    for (let i = 0; i < 100 && !job; i++) {
      job = (
        await c.claim({
          claimId: uid("claim-"),
          manifest: MANIFEST,
          capacity: { max: 2, inUse: 0, accepting: true },
        })
      ).job;
      if (!job) await new Promise((r) => setTimeout(r, 50));
    }
    if (!job) throw new Error("no job");
    expect(job.workItem.id).toBe(item.workItemId);
    const token = await c.token(job.jobId, job.lease.fencingToken);
    expect(token.token).toMatch(/^ghs_fake_/);
    expect(token.pushBranch).toBe(job.branch);
    const stored = await all<{ response: string | null }>(
      "SELECT response FROM core_channel_requests WHERE runner_id = ?",
      w.runner.runnerId,
    );
    expect(stored.some((r) => r.response?.includes(token.token))).toBe(false);

    await ok(
      "lease.claim",
      { workItemId: item.workItemId, holderId: "local", takeover: true },
      w.human,
    );
    const fenced = await c
      .events(job.jobId, {
        fencingToken: job.lease.fencingToken,
        events: [
          {
            jobId: job.jobId,
            seq: 0,
            at: new Date().toISOString(),
            type: "log",
            stream: "stdout",
            text: "hi",
          },
        ],
      })
      .catch((e) => e);
    expect(fenced).toBeInstanceOf(ChannelCallError);
    expect((fenced as ChannelCallError).status).toBe(409);
    expect((fenced as ChannelCallError).code).toBe("fenced");
  });
});

describe("attachments over the channel (ADR 0310)", () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

  async function claimed(w: Awaited<ReturnType<typeof world>>) {
    const c = await client(w.runner.runnerId);
    for (let i = 0; i < 100; i++) {
      const { job } = await c.claim({
        claimId: uid("claim-"),
        manifest: {
          ...MANIFEST,
          capabilities: [...MANIFEST.capabilities, "work-item-attachments"],
        },
        capacity: { max: 4, inUse: 0, accepting: true },
      });
      if (job) return { c, job };
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("no job");
  }

  it("lists and fetches the job's own work item's files from R2, never stored, and nothing else's", async () => {
    const w = await world();
    const item = await ok<{ workItemId: string }>(
      "workItem.create",
      { state: "queued", projectId: w.projectId, title: "Attachment item" },
      w.human,
    );
    const other = await ok<{ workItemId: string }>(
      "workItem.create",
      { state: "queued", projectId: w.projectId, title: "Someone else's" },
      w.human,
    );
    const mine = await ok<{ attachment: { id: string } }>(
      "workItem.attachment.add",
      { workItemId: item.workItemId, filename: "shot.png", contentType: "image/png", bytes: PNG },
      w.human,
    );
    const theirs = await ok<{ attachment: { id: string } }>(
      "workItem.attachment.add",
      { workItemId: other.workItemId, filename: "x.png", contentType: "image/png", bytes: PNG },
      w.human,
    );
    // The bytes are in the real R2 binding, keyed by org, item and id.
    const key = `${w.orgId}/${item.workItemId}/${mine.attachment.id}`;
    expect(await env.ATTACHMENTS.head(key)).not.toBeNull();

    let found = null;
    for (let i = 0; i < 10 && !found; i++) {
      const { c, job } = await claimed(w);
      if (job.workItem.id === item.workItemId) found = { c, job };
    }
    if (!found) throw new Error("didn't claim the attachment item's job");
    const { c, job } = found;
    const listed = await c.attachments?.(job.jobId, job.lease.fencingToken);
    expect(listed?.attachments.map((a) => a.id)).toEqual([mine.attachment.id]);
    expect(listed?.attachments[0]).not.toHaveProperty("uploader");
    const file = await c.attachment?.(job.jobId, job.lease.fencingToken, mine.attachment.id);
    expect(file?.attachment.filename).toBe("shot.png");
    expect([...Uint8Array.from(atob(file?.base64 ?? ""), (ch) => ch.charCodeAt(0))]).toEqual([
      ...PNG,
    ]);

    const cross = await c
      .attachment?.(job.jobId, job.lease.fencingToken, theirs.attachment.id)
      .catch((e) => e);
    expect(cross).toBeInstanceOf(ChannelCallError);
    expect((cross as ChannelCallError).status).toBe(404);

    const stored = await all<{ response: string | null }>(
      "SELECT response FROM core_channel_requests WHERE runner_id = ? AND idempotency_key LIKE 'att:%'",
      w.runner.runnerId,
    );
    expect(stored.every((r) => r.response === null)).toBe(true);
  });
});

describe("device login over the channel (ADR 0056)", () => {
  const post = (path: string, body: unknown) =>
    engineFetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("starts and polls unsigned, and hands the key over once after approval", async () => {
    const w = await world();
    const start = await post(DEVICE_PATHS.start, { name: "m5" });
    expect(start.status).toBe(200);
    expect(start.headers.get("cache-control")).toBe("no-store");
    const s = (await start.json()) as { deviceCode: string; userCode: string };
    const pending = await (await post(DEVICE_PATHS.poll, { deviceCode: s.deviceCode })).json();
    expect(pending).toMatchObject({ status: "pending", key: null });

    const approved = await ok<{ runnerId: string }>(
      "runner.approveDevice",
      { userCode: s.userCode, name: "m5" },
      w.human,
    );
    const got = (await (await post(DEVICE_PATHS.poll, { deviceCode: s.deviceCode })).json()) as {
      status: string;
      runnerId: string;
      key: string;
    };
    expect(got.status).toBe("approved");
    expect(got.runnerId).toBe(approved.runnerId);
    expect(got.key).toBe(await runnerChannelKey("test-channel-secret", approved.runnerId, 1));
    // The key works on the signed channel.
    const c = await client(got.runnerId, { key: got.key });
    await expect(
      c.heartbeat({
        manifest: MANIFEST,
        capacity: { max: 1, inUse: 0, accepting: true },
        activeJobs: [],
      }),
    ).resolves.toEqual({
      commands: [],
      leases: [],
      desiredVersion: null,
      minRunnerCompat: RUNNER_COMPAT,
      engine: { capabilities: ["job-line"] },
    });
    expect(
      await (await post(DEVICE_PATHS.poll, { deviceCode: s.deviceCode })).json(),
    ).toMatchObject({ status: "expired", key: null });
  });

  it("answers bad input as a refusal", async () => {
    const r = await post(DEVICE_PATHS.poll, { deviceCode: "short" });
    expect(r.status).toBe(400);
  });
});

describe("planning over the channel (spec 20, ADR 0350)", () => {
  async function planningJob(w: Awaited<ReturnType<typeof world>>) {
    const item = await ok<{ workItemId: string }>(
      "workItem.create",
      { state: "queued", projectId: w.projectId, title: "Plan me" },
      w.human,
    );
    await ok("planning.start", { workItemId: item.workItemId }, FOREMAN);
    const c = await client(w.runner.runnerId);
    for (let i = 0; i < 200; i++) {
      const { job } = await c.claim({
        claimId: uid("claim-"),
        manifest: MANIFEST,
        capacity: { max: 2, inUse: 0, accepting: true, light: { max: 6, inUse: 0 } },
      });
      if (job?.stage === "planning") return { c, job, item };
      if (!job) await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("no planning job");
  }

  it("runs the agent's operations as the runner, and holds a wait until a person writes", async () => {
    const w = await world();
    const { c, job, item } = await planningJob(w);
    const call = (op: string, input: Record<string, unknown> = {}) =>
      c.planning?.(job.jobId, {
        fencingToken: job.lease.fencingToken,
        op: op as "planning.news",
        input,
      });
    const asked = (await call("question.ask", {
      questions: [{ kind: "yes-no", prompt: "Respect filters?", default: "Yes" }],
    })) as { numbers: number[] };
    expect(asked.numbers).toEqual([1]);

    const started = Date.now();
    const waiting = call("planning.wait", { timeoutMs: 20_000 }) as Promise<{
      due: boolean;
      events: { type: string; text?: string }[];
    }>;
    await new Promise((r) => setTimeout(r, 300));
    await ok("chat.send", { workItemId: item.workItemId, text: "Use UTC" }, w.human);
    const woke = await waiting;
    expect(woke.due).toBe(true);
    expect(woke.events).toEqual([
      expect.objectContaining({ type: "chat.message", text: "Use UTC" }),
    ]);
    expect(Date.now() - started).toBeLessThan(10_000);

    // An operation off the allowlist is refused before it runs.
    const off = await c
      .planning?.(job.jobId, {
        fencingToken: job.lease.fencingToken,
        op: "spec.approve" as "planning.news",
        input: {},
      })
      .catch((e) => e);
    expect((off as ChannelCallError).status).toBe(400);
    // Nothing a planning call answered is kept in the idempotency store.
    const stored = await all<{ idempotency_key: string }>(
      "SELECT idempotency_key FROM core_channel_requests WHERE runner_id = ? AND idempotency_key LIKE 'plan:%'",
      w.runner.runnerId,
    );
    expect(stored).toEqual([]);
  });

  it("an idle held wait wakes no object and writes the session at most once (spec 44 part A3)", async () => {
    const w = await world();
    const { job } = await planningJob(w);
    const seen: Recorded[] = [];
    const objects: string[] = [];
    const counted = (ns: DurableObjectNamespace, name: string) =>
      new Proxy(ns, {
        get(target, prop) {
          const value = Reflect.get(target, prop);
          if (prop === "get" && typeof value === "function") {
            return (...args: unknown[]) => {
              objects.push(name);
              return value.apply(target, args);
            };
          }
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    const e = {
      ...recordingEnv(env, seen),
      TERMINAL_RELAY: counted(env.TERMINAL_RELAY as never, "TerminalRelay"),
    } as Env;
    const c = await httpControlPlane({
      baseUrl: base,
      runnerId: w.runner.runnerId,
      key: await runnerChannelKey("test-channel-secret", w.runner.runnerId, 1),
      fetch: async (input, init) => worker.fetch(new Request(input, init), e),
    });
    // The first evaluation goes idle (a write); then 8 s of nothing.
    await c.planning?.(job.jobId, {
      fencingToken: job.lease.fencingToken,
      op: "planning.wait",
      input: { timeoutMs: 0 },
    });
    // That evaluation's own `planning.changed` reaches the hub for the website's SSE stream (until
    // spec 44 PR 3); count only what the hold itself touches.
    await new Promise((r) => setTimeout(r, 300));
    seen.length = 0;
    objects.length = 0;
    const hold = 8_000;
    const answer = (await c.planning?.(job.jobId, {
      fencingToken: job.lease.fencingToken,
      op: "planning.wait",
      input: { timeoutMs: hold },
    })) as { due: boolean };
    expect(answer.due).toBe(false);
    expect(objects).toEqual([]);
    const sessionWrites = seen.filter((r) => /update "core_planning_sessions"/i.test(r.sql));
    expect(sessionWrites.length).toBeLessThanOrEqual(1);
    const peeks = seen.filter((r) => /from "core_planning_events"/i.test(r.sql));
    expect(peeks.length).toBeGreaterThanOrEqual(2);
    console.log(
      `spec 44 measure: an idle ${hold} ms planning hold = ${seen.length} D1 statements, ${sessionWrites.length} session writes, ${objects.length} object calls`,
    );
  });
});

describe("steering over the channel (spec 31, ADR 0400)", () => {
  it("holds the steer call until the runner's owner sends one, hands it over once, never stores it", async () => {
    const w = await world();
    const item = await ok<{ workItemId: string }>(
      "workItem.create",
      { state: "queued", projectId: w.projectId, title: "Steer me" },
      w.human,
    );
    const c = await client(w.runner.runnerId);
    let job = null;
    for (let i = 0; i < 100 && !job; i++) {
      job = (
        await c.claim({
          claimId: uid("claim-"),
          manifest: { ...MANIFEST, capabilities: [...MANIFEST.capabilities, "steer"] },
          capacity: { max: 2, inUse: 0, accepting: true },
        })
      ).job;
      if (!job) await new Promise((r) => setTimeout(r, 50));
    }
    if (!job) throw new Error("no job");
    expect(job.workItem.id).toBe(item.workItemId);
    const fence = job.lease.fencingToken;

    // Nothing queued and no wait: an empty answer at once.
    expect(await c.steers?.(job.jobId, { fencingToken: fence, waitMs: 0 })).toEqual({ steers: [] });

    const live = await ok<{ run: { id: string } }>(
      "run.live",
      { workItemId: item.workItemId },
      w.human,
    );
    const started = Date.now();
    const waiting = c.steers?.(job.jobId, { fencingToken: fence, waitMs: 20_000 });
    await new Promise((r) => setTimeout(r, 300));
    await ok(
      "run.steer",
      { workItemId: item.workItemId, runId: live.run.id, text: "also say thanks" },
      w.human,
    );
    const got = await waiting;
    expect(got?.steers).toEqual([expect.objectContaining({ text: "also say thanks" })]);
    expect(Date.now() - started).toBeLessThan(10_000);
    // Delivered once.
    expect(await c.steers?.(job.jobId, { fencingToken: fence, waitMs: 0 })).toEqual({ steers: [] });
    const stored = await all<{ idempotency_key: string }>(
      "SELECT idempotency_key FROM core_channel_requests WHERE runner_id = ? AND idempotency_key LIKE 'steer:%'",
      w.runner.runnerId,
    );
    expect(stored).toEqual([]);

    // A stale fencing token is `fenced` (409: the host stops the job).
    const stale = await c
      .steers?.(job.jobId, { fencingToken: fence + 3, waitMs: 0 })
      .catch((e) => e);
    expect((stale as ChannelCallError).status).toBe(409);
    expect((stale as ChannelCallError).code).toBe("fenced");
  });
});
