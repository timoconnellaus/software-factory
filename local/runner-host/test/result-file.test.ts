// The stage result is read only as a regular file in the worktree, in every isolation mode: a
// symlink the agent left there (to a key, a config) is refused and never followed. And the host's
// sweep (ADR 0480) runs while it runs and says loudly when it fails.
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { RESULT_FILE } from "@software-factory/runner-contract";
import { afterEach, describe, expect, it } from "vitest";
import { RunnerHost } from "../src/host.ts";
import { readResultFile } from "../src/job.ts";
import { controlPlane, fakeAdapter, fakeCloud } from "./helpers.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

describe("the stage result file", () => {
  it("is read when it is a regular file in the worktree, refused when a symlink or elsewhere", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "sf-result-")));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const work = join(root, "work");
    await mkdir(work);
    const secret = join(root, "secret.json");
    await writeFile(secret, '{"key":"the owner\'s"}');
    const notes: string[] = [];
    const path = join(work, RESULT_FILE);
    expect(await readResultFile(work, path, notes)).toBeNull();
    await writeFile(path, '{"notes":"ok"}');
    expect(await readResultFile(work, path, notes)).toBe('{"notes":"ok"}');
    await rm(path);
    await symlink(secret, path);
    expect(await readResultFile(work, path, notes)).toBeNull();
    expect(notes.at(-1)).toMatch(/not a regular file in the worktree/);
    await rm(path);
    await mkdir(path);
    expect(await readResultFile(work, path, notes)).toBeNull();
  });
});

describe("the host's sweep", () => {
  it("runs on its interval with the live jobs, and logs a failure loudly", async () => {
    const cloud = fakeCloud();
    const cp = await controlPlane(cloud);
    const seen: Set<string>[] = [];
    const logs: string[] = [];
    let fail = false;
    const host = new RunnerHost({
      adapter: fakeAdapter(
        () => "/nonexistent",
        async () => [],
      ),
      cp,
      maxConcurrent: 1,
      // The sweep never touches git; the host only needs one to claim jobs, and none are claimed.
      git: {} as never,
      heartbeatMs: 60_000,
      log: (m) => logs.push(m),
      sweepMs: 20,
      sweep: async (running) => {
        seen.push(running);
        if (fail) throw new Error("the API is down");
        return [];
      },
    });
    await host.start();
    await sleep(80);
    fail = true;
    await sleep(60);
    await host.stop({ timeoutMs: 1_000 });
    const count = seen.length;
    await sleep(60);
    expect(count).toBeGreaterThanOrEqual(2);
    expect(seen.length).toBe(count);
    expect(
      logs.some((l) =>
        /SWEEP FAILED, sandboxes may still be running and billed: the API is down/.test(l),
      ),
    ).toBe(true);
  });
});
