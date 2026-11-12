// Spec 43 (ADRs 0550, 0552): the host backs off claiming under load, heavy first, with hysteresis,
// and says why on the heartbeat; a job whose processes may still be running is never released.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RESULT_FILE, ReleaseIncomplete } from "@software-factory/runner-contract";
import { afterEach, describe, expect, it } from "vitest";
import { configSchema } from "../src/config.ts";
import { RunnerHost } from "../src/host.ts";
import { runJob } from "../src/job.ts";
import { DEFAULT_LOAD_POLICY, LoadGate, loadPolicySchema } from "../src/load.ts";
import { controlPlane, fakeAdapter, fakeCloud, git, job, scratchRepo } from "./helpers.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const edit = async (wt: string) => {
  await writeFile(join(wt, "README.md"), "# scratch\nx\n");
  git(wt, "-c", "user.name=a", "-c", "user.email=a@x.invalid", "commit", "-qam", "x");
  await writeFile(join(wt, RESULT_FILE), "{}");
  return [{ type: "session.ended" as const, outcome: "completed" as const }];
};

describe("the load gate", () => {
  it("stops heavy past 1.5× cores, light past 2.0×, and resumes each below 0.8× its stop", () => {
    let load1 = 0;
    const logs: string[] = [];
    const gate = new LoadGate(
      DEFAULT_LOAD_POLICY,
      () => ({ load1, cores: 10 }),
      (m) => logs.push(m),
    );
    const at = (l: number) => {
      load1 = l;
      return gate.check()?.pools ?? [];
    };
    expect(at(14)).toEqual([]);
    expect(at(15.5)).toEqual(["heavy"]);
    // Hysteresis: heavy stays stopped down to 12 (1.5 × 0.8 × 10).
    expect(at(13)).toEqual(["heavy"]);
    expect(at(21)).toEqual(["heavy", "light"]);
    expect(at(17)).toEqual(["heavy", "light"]); // light resumes below 16
    expect(at(15.9)).toEqual(["heavy"]);
    expect(at(12.5)).toEqual(["heavy"]);
    expect(at(11.9)).toEqual([]);
    expect(logs).toEqual([
      "load 15.5 on 10 cores (1.55×): not claiming heavy jobs",
      "load 21.0 on 10 cores (2.10×): not claiming heavy or light jobs",
      "load 15.9 on 10 cores (1.59×): not claiming heavy jobs",
      "load 11.9 on 10 cores (1.19×): claiming again",
    ]);
    load1 = 30;
    expect(gate.check()).toEqual({
      reason: "load",
      pools: ["heavy", "light"],
      load1: 30,
      cores: 10,
    });
  });

  it("is configurable in runner.json, on by default, and can be turned off", () => {
    const base = { runnerId: "r_abcdef", key: "k".repeat(24) };
    expect(configSchema.parse(base).load).toBeUndefined();
    const set = configSchema.parse({ ...base, load: { heavyStop: 2, lightStop: 3 } }).load;
    expect(set).toEqual({ enabled: true, heavyStop: 2, lightStop: 3, resumeFactor: 0.8 });
    expect(() => loadPolicySchema.parse({ heavyStop: 3, lightStop: 2 })).toThrow();
    const off = new LoadGate(loadPolicySchema.parse({ enabled: false }), () => ({
      load1: 99,
      cores: 1,
    }));
    expect(off.check()).toBeNull();
  });
});

describe("the host under load", () => {
  async function host(load: number) {
    const repo = await scratchRepo();
    cleanups.push(repo.cleanup);
    const cloud = fakeCloud();
    const cp = await controlPlane(cloud);
    cloud.queue.push(job());
    const h = new RunnerHost({
      adapter: fakeAdapter((x) => repo.host.clonePath(x), edit),
      cp,
      git: repo.host,
      maxConcurrent: 2,
      heartbeatMs: 60_000,
      log: () => {},
      load: new LoadGate(DEFAULT_LOAD_POLICY, () => ({ load1: load, cores: 8 })),
    });
    await h.start();
    const claimed = h.activeJobs.length;
    await h.idle();
    await h.stop();
    return { cloud, claimed };
  }

  it("reports the reason on the heartbeat and claims nothing past both thresholds", async () => {
    const { cloud, claimed } = await host(20);
    expect(cloud.heartbeats[0]?.capacity).toMatchObject({
      accepting: false,
      paused: { reason: "load", pools: ["heavy", "light"], load1: 20, cores: 8 },
    });
    expect(claimed).toBe(0);
    expect(cloud.queue).toHaveLength(1);
  });

  it("past the heavy threshold only: still accepting, heavy paused (the scheduler sends light work)", async () => {
    const { cloud } = await host(13);
    expect(cloud.heartbeats[0]?.capacity).toMatchObject({
      accepting: true,
      paused: { reason: "load", pools: ["heavy"] },
    });
  });

  it("under the thresholds: no pause, claims", async () => {
    const { cloud, claimed } = await host(4);
    expect(cloud.heartbeats[0]?.capacity.paused).toBeUndefined();
    expect(claimed).toBe(1);
  });
});

describe("a job whose processes may still be running", () => {
  it("is not reported released; the report and the log say so", async () => {
    const repo = await scratchRepo();
    cleanups.push(repo.cleanup);
    const cloud = fakeCloud();
    const cp = await controlPlane(cloud);
    const adapter = fakeAdapter((x) => repo.host.clonePath(x), edit);
    const release = adapter.release.bind(adapter);
    adapter.release = async (j, w, s) => {
      await release(j, w, s);
      throw new ReleaseIncomplete("the job's Claude is still running after TERM and KILL");
    };
    const logs: string[] = [];
    const j = job();
    cloud.claims.set("claim-1", j);
    const report = await runJob({ adapter, cp, git: repo.host, job: j, log: (m) => logs.push(m) });
    expect(report.processesAlive).toBe(true);

    expect(cloud.released.has(j.jobId)).toBe(false);
    expect(report.error).toMatch(/still running/);
    expect(cloud.handbacks.get(j.jobId)?.outcome).toBe("completed");
    expect(logs.some((l) => l.includes("NOT released"))).toBe(true);
    const states = (cloud.events.get(j.jobId) ?? []).filter((e) => e.type === "job.state");
    expect(states.map((e) => (e as { state: string }).state)).not.toContain("released");
  });
});
