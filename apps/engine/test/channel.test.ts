import { env } from "cloudflare:workers";
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
    expect(beat).toEqual({
      commands: [],
      leases: [],
      desiredVersion: null,
      minRunnerCompat: RUNNER_COMPAT,
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

  it("a heartbeat no newer than the last changes no runner state", async () => {
    const w = await world();
    let n = 0;
    const send = async (capacityMax: number, at: Date, activeJobs: unknown[] = []) => {
      const body = JSON.stringify({
        manifest: MANIFEST,
        capacity: { max: capacityMax, inUse: 1, accepting: true },
        activeJobs,
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
    const now = Date.now();

    // Out of order (or a captured beat replayed): the older one reports nothing.
    expect((await send(3, new Date(now - 40_000))).status).toBe(200);
    expect((await send(2, new Date(now - 30_000))).status).toBe(200);
    expect((await send(1, new Date(now - 40_000))).status).toBe(200);
    expect(await capacity()).toBe(2);

    // `sf-runner doctor`'s beat in the same second as the service's: the same.
    expect((await send(1, new Date(now - 30_000))).status).toBe(200);
    expect(await capacity()).toBe(2);

    // A clock that ran ahead and was put back: real time has to catch up first.
    expect((await send(5, new Date(now + 120_000))).status).toBe(200);
    expect((await send(2, new Date(now))).status).toBe(200);
    expect(await capacity()).toBe(5);
    expect((await send(4, new Date(now + 121_000))).status).toBe(200);
    expect(await capacity()).toBe(4);
  });

  it("cancels a held job that isn't a flow run, and refuses calls on one", async () => {
    const w = await world();
    const c = await client(w.runner.runnerId);
    const beat = await c.heartbeat({
      manifest: MANIFEST,
      capacity: { max: 2, inUse: 1, accepting: true },
      activeJobs: [{ jobId: `job_${"a".repeat(32)}`, fencingToken: 1 }],
    });
    expect(beat.commands).toEqual([
      { kind: "cancel", jobId: `job_${"a".repeat(32)}`, reason: "not assigned to this runner" },
    ]);
    const refused = await c
      .release({ jobId: `job_${"a".repeat(32)}`, fencingToken: 1, finalState: "failed" })
      .catch((e) => e);
    expect(refused).toBeInstanceOf(ChannelCallError);
    expect((refused as ChannelCallError).status).toBe(404);
  });

  it("an empty claim answers no job, records the runner's report, and is never stored", async () => {
    const w = await world();
    const c = await client(w.runner.runnerId);
    const claimed = await c.claim({
      claimId: uid("claim-"),
      manifest: MANIFEST,
      capacity: { max: 3, inUse: 0, accepting: true },
    });
    expect(claimed.job).toBeNull();
    expect(
      (
        await first<{ capacity_max: number }>(
          "SELECT capacity_max FROM core_runners WHERE id = ?",
          w.runner.runnerId,
        )
      )?.capacity_max,
    ).toBe(3);
    expect(
      await all("SELECT 1 FROM core_channel_requests WHERE runner_id = ?", w.runner.runnerId),
    ).toEqual([]);
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
