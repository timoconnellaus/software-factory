// "Restart to update" (spec 40 M4): drain, re-read, then stop; and always bring things back.
import { describe, expect, it } from "vitest";
import { type RestartDeps, restartToUpdate } from "../src/bun/restart-update.ts";

function deps(over: Partial<RestartDeps> & { jobsAfterDrain?: string[] } = {}) {
  const calls: string[] = [];
  let drained = false;
  const d: RestartDeps = {
    drain: async () => {
      calls.push("drain");
      drained = true;
      return "confirmed";
    },
    liveJobs: () => (drained ? (over.jobsAfterDrain ?? []) : []),
    stopLive: () => calls.push("stopLive"),
    startLive: () => calls.push("startLive"),
    stopRunner: async () => {
      calls.push("stopRunner");
    },
    startRunner: () => calls.push("startRunner"),
    apply: async () => {
      calls.push("apply");
    },
    ...over,
  };
  return { d, calls };
}

describe("restartToUpdate", () => {
  it("drains first, and stops nothing when a job was claimed in the window", async () => {
    const { d, calls } = deps({ jobsAfterDrain: ["job-1"] });
    expect(await restartToUpdate(d, { anyway: false })).toBe("deferred");
    expect(calls).toEqual(["drain"]);
  });

  it("defers when the runner doesn't confirm the drain", async () => {
    const { d, calls } = deps({ drain: async () => "timeout" });
    expect(await restartToUpdate(d, { anyway: false })).toBe("deferred");
    expect(calls).toEqual([]);
  });

  it("drains, stops, applies; brings everything back when the update didn't start", async () => {
    const { d, calls } = deps();
    expect(await restartToUpdate(d, { anyway: false })).toBe("failed");
    expect(calls).toEqual(["drain", "stopLive", "stopRunner", "apply", "startRunner", "startLive"]);
  });

  it("restarting anyway skips the drain", async () => {
    const { d, calls } = deps({ jobsAfterDrain: ["job-1"] });
    await restartToUpdate(d, { anyway: true });
    expect(calls[0]).toBe("stopLive");
  });

  it("a throw from apply still brings the runner and the live socket back", async () => {
    const { d, calls } = deps({
      apply: async () => {
        throw new Error("boom");
      },
    });
    await expect(restartToUpdate(d, { anyway: false })).rejects.toThrow("boom");
    expect(calls.slice(-2)).toEqual(["startRunner", "startLive"]);
  });
});
