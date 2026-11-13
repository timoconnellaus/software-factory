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
  it("says it is restarting once the runner is idle, before anything is stopped", async () => {
    const { d, calls } = deps();
    d.restarting = () => calls.push("restarting");
    expect(await restartToUpdate(d, { anyway: false })).toBe("failed");
    expect(calls.slice(0, 3)).toEqual(["drain", "restarting", "stopLive"]);
    const busy = deps({ jobsAfterDrain: ["job-1"] });
    busy.d.restarting = () => busy.calls.push("restarting");
    await restartToUpdate(busy.d, { anyway: false });
    expect(busy.calls).not.toContain("restarting");
  });

  it("drains first, and stops nothing when a job was claimed in the window", async () => {
    const { d, calls } = deps({ jobsAfterDrain: ["job-1"] });
    expect(await restartToUpdate(d, { anyway: false })).toBe("deferred");
    expect(calls).toEqual(["drain"]);
  });

  it("reports a timeout when the runner doesn't confirm the drain, and stops nothing", async () => {
    const { d, calls } = deps({ drain: async () => "timeout" });
    expect(await restartToUpdate(d, { anyway: false })).toBe("timeout");
    expect(calls).toEqual([]);
  });

  it("shows the wait with its deadline, and clears it however the drain ends", async () => {
    const shown: (number | null)[] = [];
    let asked = 0;
    const { d } = deps({
      now: () => 1_000,
      waiting: (until) => shown.push(until),
      drain: async (ms) => {
        asked = ms;
        return "confirmed";
      },
    });
    await restartToUpdate(d, { anyway: false, timeoutMs: 5_000 });
    expect(asked).toBe(5_000);
    expect(shown).toEqual([6_000, null]);
  });

  it("gives up on a drain that never answers once the deadline has passed", async () => {
    const shown: (number | null)[] = [];
    const { d, calls } = deps({
      waiting: (until) => shown.push(until),
      drain: () => new Promise(() => {}),
    });
    expect(await restartToUpdate(d, { anyway: false, timeoutMs: 10 })).toBe("timeout");
    expect(calls).toEqual([]);
    expect(shown.at(-1)).toBeNull();
  });

  it("drains, stops, applies; brings everything back when the update didn't start", async () => {
    const { d, calls } = deps();
    expect(await restartToUpdate(d, { anyway: false })).toBe("failed");
    expect(calls).toEqual(["drain", "stopLive", "stopRunner", "apply", "startRunner", "startLive"]);
  });

  it("restarting anyway skips the drain", async () => {
    const { d, calls } = deps({ jobsAfterDrain: ["job-1"] });
    const shown: (number | null)[] = [];
    await restartToUpdate({ ...d, waiting: (u) => shown.push(u) }, { anyway: true });
    expect(calls[0]).toBe("stopLive");
    expect(shown).toEqual([]);
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

  it("a restart that hangs (applyUpdate or its helper) is reported as stalled, and everything comes back", async () => {
    const { d, calls } = deps({
      apply: () => {
        calls.push("apply");
        return new Promise(() => {});
      },
    });
    d.restarting = () => calls.push("restarting");
    expect(await restartToUpdate(d, { anyway: false, applyTimeoutMs: 5 })).toBe("stalled");
    expect(calls).toEqual([
      "drain",
      "restarting",
      "stopLive",
      "stopRunner",
      "apply",
      "startRunner",
      "startLive",
    ]);
  });

  it("an apply given up on is cancelled: it reaches the gate later and never applies", async () => {
    let reachGate: () => void = () => {};
    const handedOff: boolean[] = [];
    const { d, calls } = deps({
      apply: async (gate) => {
        calls.push("apply");
        // The record rewrite and the hash take longer than the watchdog.
        await new Promise<void>((resolve) => {
          reachGate = resolve;
        });
        const go = gate.handoff();
        handedOff.push(go);
        if (go) calls.push("applyUpdate");
      },
    });
    expect(await restartToUpdate(d, { anyway: true, applyTimeoutMs: 5 })).toBe("stalled");
    expect(calls.slice(-2)).toEqual(["startRunner", "startLive"]);
    reachGate();
    await new Promise((r) => setTimeout(r, 0));
    expect(handedOff).toEqual([false]);
    expect(calls).not.toContain("applyUpdate");
  });

  it("once the handoff has started the watchdog brings nothing back", async () => {
    let finish: () => void = () => {};
    const lines: string[] = [];
    const { d, calls } = deps({
      log: (line) => lines.push(line),
      apply: async (gate) => {
        calls.push("apply");
        expect(gate.handoff()).toBe(true);
        // applyUpdate is waiting on the helper.
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
    });
    let outcome: string | undefined;
    const done = restartToUpdate(d, { anyway: true, applyTimeoutMs: 5 }).then((o) => {
      outcome = o;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(outcome).toBeUndefined();
    expect(calls).not.toContain("startRunner");
    expect(calls).not.toContain("startLive");
    expect(lines.join("\n")).toMatch(/still restarting/);
    // applyUpdate returned after all (the app didn't restart): only now does everything come back.
    finish();
    await done;
    expect(outcome).toBe("failed");
    expect(calls.slice(-2)).toEqual(["startRunner", "startLive"]);
  });

  it("a handed-off apply that hangs past the stuck bound is stuck, and nothing comes back", async () => {
    const lines: string[] = [];
    const { d, calls } = deps({
      log: (line) => lines.push(line),
      apply: async (gate) => {
        calls.push("apply");
        expect(gate.handoff()).toBe(true);
        // applyUpdate never returns, and the app never restarts.
        await new Promise<void>(() => {});
      },
    });
    expect(await restartToUpdate(d, { anyway: true, applyTimeoutMs: 5, stuckTimeoutMs: 20 })).toBe(
      "stuck",
    );
    expect(calls).not.toContain("startRunner");
    expect(calls).not.toContain("startLive");
    expect(lines.join("\n")).toMatch(/quit and reopen/);
  });

  it("an apply that returns in time is not stalled", async () => {
    const { d } = deps();
    expect(await restartToUpdate(d, { anyway: true, applyTimeoutMs: 1_000 })).toBe("failed");
  });
});
