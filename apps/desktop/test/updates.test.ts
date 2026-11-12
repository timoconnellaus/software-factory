// The updater's decisions (spec 40 M4): what may be applied, and what is refused.
import { describe, expect, it } from "vitest";
import { liveJobs, liveJobsFile } from "../src/bun/runner-jobs.ts";
import type { Exec } from "../src/bun/update-verify.ts";
import { requirement, stagedUpdate, teamIdOf, verifyBundle } from "../src/bun/update-verify.ts";
import { installProblem, RETRY_MS, type UpdaterLike, Updates } from "../src/bun/updates.ts";
import { compareVersions, isNewer } from "../src/shared/version.ts";

const APP = "/Applications/Software Factory.app";
const STAGED = `${APP}.prepared-abc`;
const TEAM = "ABCDE12345";

function fakeUpdater(
  over: Partial<{ manifest: string; running: string; ready: boolean; error: string }> = {},
) {
  const calls: string[] = [];
  const s = { manifest: "0.1.5", running: "0.1.4", ready: true, error: "", ...over };
  const updater: UpdaterLike = {
    checkForUpdate: async () => {
      calls.push("check");
      return { version: s.manifest, updateAvailable: s.manifest !== s.running, error: "" };
    },
    downloadUpdate: async () => {
      calls.push("download");
    },
    updateInfo: () => ({ version: s.manifest, updateReady: s.ready, error: s.error }),
    applyUpdate: async () => {
      calls.push("apply");
    },
    getLocalInfo: async () => ({ version: s.running, channel: "canary" }),
    appDataFolder: async () => "/data",
  };
  return { updater, calls, s };
}

/** codesign/spctl: signed by TEAM and passing, unless told otherwise. */
function fakeExec(opts: { badSignature?: boolean; gatekeeper?: boolean; unsigned?: boolean } = {}) {
  const runs: string[][] = [];
  const exec: Exec = async (cmd, args) => {
    runs.push([cmd, ...args]);
    if (args[0] === "-dv")
      return opts.unsigned
        ? { code: 1, out: "code object is not signed at all" }
        : { code: 0, out: `Identifier=com.software-factory.desktop\nTeamIdentifier=${TEAM}\n` };
    if (cmd.endsWith("codesign"))
      return opts.badSignature
        ? { code: 3, out: "test-requirement: code failed to satisfy specified code requirement(s)" }
        : { code: 0, out: "" };
    return opts.gatekeeper === false ? { code: 3, out: "rejected" } : { code: 0, out: "accepted" };
  };
  return { exec, runs };
}

function make(
  u: ReturnType<typeof fakeUpdater>,
  e = fakeExec(),
  over: { appPath?: string; writable?: (p: string) => void; staged?: string | null } = {},
) {
  const timers: number[] = [];
  const updates = new Updates(
    {
      updater: u.updater,
      exec: e.exec,
      appPath: over.appPath ?? APP,
      writable: over.writable ?? (() => {}),
      staged: () =>
        over.staged === null
          ? null
          : { version: over.staged ?? u.s.manifest, hash: "abc", path: STAGED },
      setInterval: () => 0,
      setTimeout: (_fn, ms) => timers.push(ms),
    },
    () => {},
  );
  return { updates, timers };
}

describe("versions", () => {
  it("compares numerically, part by part", () => {
    expect(isNewer("0.1.10", "0.1.9")).toBe(true);
    expect(isNewer("1.0.0", "0.1.999")).toBe(true);
    expect(isNewer("0.1.4", "0.1.4")).toBe(false);
    expect(isNewer("0.1.3", "0.1.4")).toBe(false);
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1.2.x", "1.2.0")).toBeNull();
    expect(isNewer("9.9.9-evil", "0.0.1")).toBe(false);
  });
});

describe("Updates", () => {
  it("offers a newer, signed, staged update", async () => {
    const u = fakeUpdater();
    const e = fakeExec();
    const { updates } = make(u, e);
    await updates.check();
    expect(updates.state).toMatchObject({ ready: true, version: "0.1.5", error: null });
    // Pinned to this build's own Team ID, and Gatekeeper asked too.
    expect(e.runs.some((r) => r.includes(`-R=${requirement(TEAM)}`) && r.includes(STAGED))).toBe(
      true,
    );
    expect(e.runs.some((r) => r[0]?.endsWith("spctl"))).toBe(true);
  });

  it("refuses a downgrade without downloading it", async () => {
    const u = fakeUpdater({ manifest: "0.1.3", running: "0.1.4" });
    const { updates } = make(u);
    await updates.check();
    expect(updates.state.ready).toBe(false);
    expect(updates.state.error).toMatch(/not newer/);
    expect(u.calls).not.toContain("download");
  });

  it("refuses a staged bundle older than the running one", async () => {
    const u = fakeUpdater();
    const { updates } = make(u, fakeExec(), { staged: "0.1.2" });
    await updates.check();
    expect(updates.state.ready).toBe(false);
    expect(updates.state.error).toMatch(/not newer/);
  });

  it("doesn't mark a failed download ready, and tries again later", async () => {
    const u = fakeUpdater({ ready: false, error: "Failed to download update: HTTP 404" });
    const { updates, timers } = make(u);
    await updates.check();
    expect(updates.state).toMatchObject({
      ready: false,
      error: "Failed to download update: HTTP 404",
    });
    expect(timers).toEqual([RETRY_MS]);
  });

  it("refuses a staged update whose signature fails", async () => {
    const u = fakeUpdater();
    const { updates } = make(u, fakeExec({ badSignature: true }));
    await updates.check();
    expect(updates.state.ready).toBe(false);
    expect(updates.state.error).toMatch(/signature doesn't check out/);
  });

  it("refuses one Gatekeeper rejects", async () => {
    const { updates } = make(fakeUpdater(), fakeExec({ gatekeeper: false }));
    await updates.check();
    expect(updates.state.error).toMatch(/Gatekeeper/);
  });

  it("takes no update when the running build is unsigned", async () => {
    const { updates } = make(fakeUpdater(), fakeExec({ unsigned: true }));
    await updates.check();
    expect(updates.state).toMatchObject({ ready: false });
    expect(updates.state.error).toMatch(/isn't signed/);
  });

  it("refuses when nothing checkable is staged", async () => {
    const { updates } = make(fakeUpdater(), fakeExec(), { staged: null });
    await updates.check();
    expect(updates.state.error).toMatch(/no staged update/);
  });

  it("checks again right before applying, and doesn't apply a bundle that changed", async () => {
    const u = fakeUpdater();
    let bad = false;
    const e = fakeExec();
    const exec: Exec = (cmd, args) =>
      bad && cmd.endsWith("codesign") && args[0] === "--verify"
        ? Promise.resolve({ code: 1, out: "a sealed resource is missing or invalid" })
        : e.exec(cmd, args);
    const { updates } = make(u, { exec, runs: e.runs });
    await updates.check();
    expect(updates.state.ready).toBe(true);
    bad = true;
    await updates.apply();
    expect(u.calls).not.toContain("apply");
    expect(updates.state.ready).toBe(false);
  });

  it("reports an apply that returned (nothing restarted)", async () => {
    const u = fakeUpdater();
    const { updates } = make(u);
    await updates.check();
    u.s.ready = false;
    u.s.error = "Update restart was cancelled";
    await updates.apply();
    expect(u.calls).toContain("apply");
    expect(updates.state).toMatchObject({ ready: false, error: "Update restart was cancelled" });
  });

  it("tells the person to move a translocated or read-only app", async () => {
    const u = fakeUpdater();
    const t = make(u, fakeExec(), {
      appPath: "/private/var/folders/x/AppTranslocation/ABC/d/Software Factory.app",
    });
    await t.updates.check();
    expect(t.updates.state).toMatchObject({ ready: false, needsMove: true });
    expect(t.updates.state.error).toMatch(/Applications/);
    expect(u.calls).not.toContain("check");

    const ro = make(fakeUpdater(), fakeExec(), {
      writable: () => {
        throw new Error("EACCES");
      },
    });
    await ro.updates.check();
    expect(ro.updates.state.needsMove).toBe(true);
  });

  it("installProblem is null for a writable /Applications copy", () => {
    expect(installProblem(APP, () => {})).toBeNull();
  });
});

describe("update-verify", () => {
  it("reads the Team ID only from a real signature", async () => {
    expect(await teamIdOf(APP, fakeExec().exec)).toBe(TEAM);
    expect(await teamIdOf(APP, fakeExec({ unsigned: true }).exec)).toBeNull();
  });

  it("won't check against a malformed Team ID", async () => {
    expect(await verifyBundle(STAGED, 'X" or true', fakeExec().exec)).toMatch(/no Team ID/);
  });

  it("reads Electrobun's staged-bundle record, and nothing else", () => {
    const rec = (doc: object) => () => JSON.stringify(doc);
    expect(
      stagedUpdate(
        "/data",
        rec({ schema_version: 2, staging_path: STAGED, version: "0.1.5", hash: "abc" }),
      ),
    ).toEqual({ version: "0.1.5", hash: "abc", path: STAGED });
    expect(
      stagedUpdate("/data", rec({ schema_version: 1, retained_tar_path: "/x.tar", version: "1" })),
    ).toBeNull();
    expect(
      stagedUpdate("/data", () => {
        throw new Error("ENOENT");
      }),
    ).toBeNull();
  });
});

describe("runner jobs", () => {
  it("finds the runner host's file where it writes it", () => {
    expect(liveJobsFile({ HOME: "/Users/a" })).toBe(
      "/Users/a/.local/state/software-factory/runner/live-jobs.json",
    );
    expect(liveJobsFile({ HOME: "/h", SF_RUNNER_STATE_DIR: "/s" })).toBe("/s/live-jobs.json");
  });

  it("counts jobs only while their host is alive", () => {
    const file = () => JSON.stringify({ pid: 42, jobs: ["j1", "j2"], updatedAt: "" });
    expect(liveJobs("/f", file, () => true)).toEqual(["j1", "j2"]);
    expect(liveJobs("/f", file, () => false)).toEqual([]);
    expect(
      liveJobs(
        "/f",
        () => {
          throw new Error("ENOENT");
        },
        () => true,
      ),
    ).toEqual([]);
  });
});
