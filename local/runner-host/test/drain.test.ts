// The desktop app's "Restart to update" (spec 40 M4) asks its runner to stop claiming (SIGUSR2 →
// RunnerHost.drain) and waits for the live-jobs file to be rewritten before it stops the runner.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { RunnerHost } from "../src/host.ts";
import { readLiveJobs } from "../src/live-jobs.ts";
import { controlPlane, fakeAdapter, fakeCloud, job, scratchRepo } from "./helpers.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

describe("drain (asked locally)", () => {
  it("claims nothing afterwards and rewrites the live-jobs file once the claim in flight landed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sf-drain-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const repo = await scratchRepo();
    cleanups.push(repo.cleanup);
    const cloud = fakeCloud();
    const file = join(dir, "live-jobs.json");
    const host = new RunnerHost({
      adapter: fakeAdapter(
        () => "/nonexistent",
        async () => [],
      ),
      cp: await controlPlane(cloud),
      git: repo.host,
      maxConcurrent: 1,
      heartbeatMs: 20,
      log: () => {},
      liveJobsFile: file,
    });
    await host.start();
    const before = (await readLiveJobs(file))?.updatedAt;
    await sleep(5);
    await host.drain();
    const after = await readLiveJobs(file);
    expect(after?.updatedAt).not.toBe(before);
    const claims = cloud.claimCapacities.length;
    cloud.queue.push(job());
    await sleep(150);
    await host.stop();
    expect(cloud.claimCapacities.length).toBe(claims);
    expect(cloud.queue).toHaveLength(1);
  });
});
