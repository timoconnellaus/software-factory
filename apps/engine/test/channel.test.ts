import { env } from "cloudflare:workers";
import {
  ChannelCallError,
  DEVICE_PATHS,
  httpControlPlane,
  PATHS,
  runnerChannelKey,
  signRunnerRequest,
} from "@software-factory/runner-contract";
import { describe, expect, it } from "vitest";
import worker from "../src/index.ts";
import { all, first, MANIFEST, ok, uid, world } from "./helpers.ts";

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
    expect(beat).toEqual({ commands: [], leases: [] });
    const seen = await first<{ capacity_max: number; last_seen_at: string }>(
      "SELECT capacity_max, last_seen_at FROM core_runners WHERE id = ?",
      w.runner.runnerId,
    );
    expect(seen?.capacity_max).toBe(2);
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

  it("answers a replayed request id from the store without running the handler again", async () => {
    const w = await world();
    const body = JSON.stringify({
      claimId: "claim-replay-1",
      manifest: MANIFEST,
      capacity: { max: 1, inUse: 0, accepting: true },
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
    const first_ = await worker.fetch(await signed(), env);
    const again = await worker.fetch(await signed(), env);
    expect(await again.text()).toBe(await first_.text());
    expect(again.headers.get("x-sf-replayed")).toBe("1");
    const audits = await all(
      "SELECT id FROM core_audit WHERE operation = 'job.claim' AND actor_id = ?",
      w.runner.runnerId,
    );
    expect(audits).toHaveLength(1);
  });

  it("maps a fenced write to 409 with code `fenced`, and never stores the job token", async () => {
    const w = await world();
    const item = await ok<{ workItemId: string }>(
      "workItem.create",
      { projectId: w.projectId, title: "Channel item" },
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

describe("attachments over the channel (ADR 0260)", () => {
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
      { projectId: w.projectId, title: "Attachment item" },
      w.human,
    );
    const other = await ok<{ workItemId: string }>(
      "workItem.create",
      { projectId: w.projectId, title: "Someone else's" },
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
    ).resolves.toEqual({ commands: [], leases: [] });
    expect(
      await (await post(DEVICE_PATHS.poll, { deviceCode: s.deviceCode })).json(),
    ).toMatchObject({ status: "expired", key: null });
  });

  it("answers bad input as a refusal", async () => {
    const r = await post(DEVICE_PATHS.poll, { deviceCode: "short" });
    expect(r.status).toBe(400);
  });
});
