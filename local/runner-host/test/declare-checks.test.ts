// Fifth review (ADR 0501): a `sandbox` runner always declares `checks`, so an item whose project
// declares checks builds and reaches the gate even when no check can run here: each comes back not
// run with the reason, the same line doctor prints rides on the manifest for Factory > Runners. A
// runner that never runs checks here (a sprite runner) doesn't declare it.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type ExecutedCheck, RESULT_FILE } from "@software-factory/runner-contract";
import type { ContainerRuntime } from "@software-factory/runner-local";
import { afterEach, describe, expect, it } from "vitest";
import { localChecks, NO_MAC_CONTAINER_LINE } from "../src/check-mode.ts";
import { RunnerHost } from "../src/host.ts";
import {
  controlPlane,
  fakeAdapter,
  fakeCloud,
  git,
  job,
  NO_GIT_ATTR_SOURCE,
  scratchRepo,
} from "./helpers.ts";

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

/** OrbStack stopped: the runtime doesn't answer. */
const dead = {
  version: async () => {
    throw new Error("the Docker server isn't reachable: Cannot connect");
  },
} as unknown as ContainerRuntime;

async function host(declareChecks: boolean) {
  const repo = await scratchRepo();
  cleanups.push(repo.cleanup);
  const cloud = fakeCloud();
  const cp = await controlPlane(cloud);
  const j = job({
    checks: { commands: [{ name: "tests", run: "pnpm test", timeoutMs: 5_000 }], fixRounds: 2 },
  });
  cloud.queue.push(j);
  const h = new RunnerHost({
    adapter: fakeAdapter((x) => repo.host.clonePath(x), edit),
    cp,
    git: repo.host,
    maxConcurrent: 2,
    heartbeatMs: 60_000,
    log: () => {},
    checkSandbox: localChecks({ platform: "darwin", runtime: dead, sandbox: null }),
    declareChecks,
    checksNote: async () => `not run here: ${NO_MAC_CONTAINER_LINE}`,
  });
  await h.start();
  await h.idle();
  await h.stop();
  return { cloud, j };
}

describe("declaring `checks` (fifth review)", () => {
  it.skipIf(NO_GIT_ATTR_SOURCE)(
    "a Mac sandbox runner with no runtime declares them, builds, and hands each back not run with the reason",
    async () => {
      const { cloud, j } = await host(true);
      const manifest = cloud.heartbeats[0]?.manifest;
      expect(manifest?.capabilities).toContain("checks");
      expect(manifest?.checksNote).toBe(
        "not run here: this Mac runner has no container runtime (OrbStack is not answering): start it, or set checks.weakerMacSandbox",
      );
      const handback = cloud.handbacks.get(j.jobId) as {
        outcome: string;
        checks?: ExecutedCheck[];
      };
      expect(handback.outcome).toBe("completed");
      expect(handback.checks).toMatchObject([
        { name: "tests", exitCode: null, notRun: NO_MAC_CONTAINER_LINE },
      ]);
    },
  );

  it("a runner that never runs checks here doesn't declare them", async () => {
    const { cloud } = await host(false);
    expect(cloud.heartbeats[0]?.manifest.capabilities).not.toContain("checks");
  });
});
