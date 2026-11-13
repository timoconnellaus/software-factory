// The updater's decisions (spec 40 M4): what may be applied, and what is refused.
import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { liveJobs, liveJobsFile, runnerChildEnv } from "../src/bun/runner-jobs.ts";
import type { Exec } from "../src/bun/update-verify.ts";
import {
  bundleInfo,
  requirement,
  stagedUpdate,
  teamIdOf,
  verifyBundle,
} from "../src/bun/update-verify.ts";
import {
  installProblem,
  OFF_DEV,
  OFF_UNSIGNED,
  plainReason,
  RETRY_MS,
  type UpdaterLike,
  Updates,
} from "../src/bun/updates.ts";
import type { UpdateStatus } from "../src/shared/rpc.ts";
import { checkSummary, checkView, lastCheckedText } from "../src/shared/update-check.ts";
import { compareVersions, isNewer } from "../src/shared/version.ts";

const APP = "/Applications/Software Factory.app";
const STAGED = `${APP}.prepared-abc`;
const TEAM = "ABCDE12345";
const NOW = 1_800_000_000_000;

function fakeUpdater(
  over: Partial<{
    manifest: string;
    running: string;
    ready: boolean;
    error: string;
    channel: string;
    checkError: string;
    /** Electrobun already prepared the manifest's version (its check says updateReady). */
    prepared: boolean;
  }> = {},
) {
  const calls: string[] = [];
  const s = {
    manifest: "0.1.5",
    running: "0.1.4",
    ready: true,
    error: "",
    channel: "canary",
    checkError: "",
    prepared: false,
    ...over,
  };
  const updater: UpdaterLike = {
    checkForUpdate: async () => {
      calls.push("check");
      if (s.checkError) return { version: "", updateAvailable: false, error: s.checkError };
      return {
        version: s.manifest,
        updateAvailable: s.manifest !== s.running,
        updateReady: s.prepared,
        error: "",
      };
    },
    downloadUpdate: async () => {
      calls.push("download");
    },
    updateInfo: () => ({ version: s.manifest, updateReady: s.ready, error: s.error }),
    applyUpdate: async () => {
      calls.push("apply");
    },
    getLocalInfo: async () => ({ version: s.running, channel: s.channel }),
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
  over: {
    appPath?: string;
    writable?: (p: string) => void;
    staged?: string | null;
    /** What the staged bundle's own version.json says; by default the staged version, on canary. */
    bundle?: { version: string; channel: string } | null;
  } = {},
) {
  const timers: number[] = [];
  const phases: string[] = [];
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
      bundle:
        over.bundle === undefined
          ? () => ({ version: over.staged ?? u.s.manifest, channel: "canary" })
          : over.bundle === null
            ? () => null
            : () => over.bundle ?? null,
      setInterval: () => 0,
      setTimeout: (_fn, ms) => timers.push(ms),
      now: () => NOW,
    },
    (st) => phases.push(st.phase),
  );
  return { updates, timers, phases };
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

  it("refuses an old signed build served under a manifest that says it is newer", async () => {
    // A bucket attacker serves a genuine, signed, notarized 0.1.3 as "9.9.9".
    const u = fakeUpdater({ manifest: "9.9.9", running: "0.1.4" });
    const { updates } = make(u, fakeExec(), { bundle: { version: "0.1.3", channel: "canary" } });
    await updates.check();
    expect(updates.state.ready).toBe(false);
    expect(updates.state.error).toMatch(/is version 0\.1\.3, not what the manifest says/);
  });

  it("refuses a build from another channel, and one with no readable version", async () => {
    const other = make(fakeUpdater(), fakeExec(), {
      bundle: { version: "0.1.5", channel: "stable" },
    });
    await other.updates.check();
    expect(other.updates.state.error).toMatch(/stable build, this is canary/);
    const none = make(fakeUpdater(), fakeExec(), { bundle: null });
    await none.updates.check();
    expect(none.updates.state.error).toMatch(/no readable version/);
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

  it("resolves it from the child's environment, not the app's", () => {
    const saved = { ...process.env };
    try {
      process.env.XDG_STATE_HOME = "/app-only/state";
      process.env.SF_RUNNER_STATE_DIR = "/app-only/runner";
      expect(liveJobsFile()).toBe(liveJobsFile(runnerChildEnv("", process.env.HOME)));
      expect(liveJobsFile()).not.toMatch(/app-only/);
    } finally {
      process.env = saved;
    }
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

/** Runs a real command on this Mac (the tests run on Node, so not Bun.spawn). */
const nodeExec: Exec = (cmd, args) =>
  new Promise((done) =>
    execFile(cmd, args, (err, stdout, stderr) =>
      done({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: `${stdout}${stderr}` }),
    ),
  );

/** A minimal .app, ad-hoc signed, whose version.json says `version` on `channel`. */
function adHocApp(dir: string, version: string, channel: string): string {
  const app = join(dir, "Staged.app");
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  mkdirSync(join(app, "Contents", "Resources"), { recursive: true });
  copyFileSync("/usr/bin/true", join(app, "Contents", "MacOS", "launcher"));
  writeFileSync(
    join(app, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.software-factory.desktop</string>
<key>CFBundleExecutable</key><string>launcher</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>`,
  );
  writeFileSync(
    join(app, "Contents", "Resources", "version.json"),
    JSON.stringify({ version, channel, identifier: "com.software-factory.desktop" }),
  );
  return app;
}

// A real signature on a real bundle: ad hoc (no certificate), so codesign's seal is real but the
// Team ID requirement and Gatekeeper can't be met here; those two are faked, the seal is not.
describe.runIf(process.platform === "darwin")("a real signed bundle (macOS)", () => {
  const sign = async (app: string) => {
    const r = await nodeExec("/usr/bin/codesign", ["--force", "--sign", "-", app]);
    expect(r.code, r.out).toBe(0);
  };
  /** The real codesign --verify, minus the -R requirement an ad-hoc signature can't meet. */
  const exec: Exec = (cmd, args) => {
    if (args[0] === "-dv") return Promise.resolve({ code: 0, out: `TeamIdentifier=${TEAM}\n` });
    if (cmd.endsWith("spctl")) return Promise.resolve({ code: 0, out: "accepted" });
    return nodeExec(
      cmd,
      args.filter((a) => !a.startsWith("-R=")),
    );
  };

  it("reads its version from inside the seal, and the seal covers version.json", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-bundle-"));
    try {
      const app = adHocApp(dir, "0.1.5", "canary");
      await sign(app);
      expect(bundleInfo(app)).toEqual({ version: "0.1.5", channel: "canary" });
      expect(await verifyBundle(app, TEAM, exec)).toBeNull();
      // Rewriting the version after signing breaks the seal.
      writeFileSync(
        join(app, "Contents", "Resources", "version.json"),
        JSON.stringify({ version: "9.9.9", channel: "canary" }),
      );
      expect(await verifyBundle(app, TEAM, exec)).toMatch(/signature doesn't check out/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("applies a genuine newer build and refuses a genuine older one sold as 9.9.9", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-bundle-"));
    try {
      const app = adHocApp(dir, "0.1.5", "canary");
      await sign(app);
      // The real version.json reader, not the fake one make() gives.
      const real = new Updates(
        {
          updater: fakeUpdater({ manifest: "0.1.5" }).updater,
          exec,
          appPath: APP,
          writable: () => {},
          staged: () => ({ version: "0.1.5", hash: "abc", path: app }),
          setInterval: () => 0,
          setTimeout: () => 0,
        },
        () => {},
      );
      await real.check();
      expect(real.state).toMatchObject({ ready: true, version: "0.1.5" });

      const old = adHocApp(mkdtempSync(join(dir, "old-")), "0.1.3", "canary");
      await sign(old);
      const attack = new Updates(
        {
          updater: fakeUpdater({ manifest: "9.9.9", running: "0.1.4" }).updater,
          exec,
          appPath: APP,
          writable: () => {},
          staged: () => ({ version: "9.9.9", hash: "abc", path: old }),
          setInterval: () => 0,
          setTimeout: () => 0,
        },
        () => {},
      );
      await attack.check();
      expect(attack.state.ready).toBe(false);
      expect(attack.state.error).toMatch(/is version 0\.1\.3/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Check for updates, pressed by a person", () => {
  it("says up to date, with the installed version and when it checked", async () => {
    const u = fakeUpdater({ manifest: "0.1.4", running: "0.1.4" });
    const { updates, phases } = make(u);
    await updates.checkByPerson();
    expect(updates.state).toMatchObject({
      phase: "up-to-date",
      installed: "0.1.4",
      channel: "canary",
      checkedAt: NOW,
      ready: false,
    });
    expect(phases).toContain("checking");
    expect(u.calls).toEqual(["check"]);
  });

  it("finds an update, downloads and verifies it, and offers the restart", async () => {
    const u = fakeUpdater();
    const { updates, phases } = make(u);
    await updates.checkByPerson();
    expect(updates.state).toMatchObject({ phase: "ready", ready: true, version: "0.1.5" });
    expect(phases).toEqual(expect.arrayContaining(["checking", "downloading", "ready"]));
    expect(phases.indexOf("downloading")).toBeLessThan(phases.indexOf("ready"));
    expect(u.calls.filter((c) => c === "download")).toHaveLength(1);
  });

  it("never downloads an update already staged again", async () => {
    const u = fakeUpdater();
    const { updates } = make(u);
    await updates.check();
    expect(updates.state.ready).toBe(true);
    await updates.checkByPerson();
    await updates.checkByPerson();
    expect(updates.state).toMatchObject({ phase: "ready", version: "0.1.5" });
    expect(u.calls).toEqual(["check", "download"]);
  });

  it("doesn't download a version Electrobun already prepared, but still verifies it", async () => {
    const u = fakeUpdater({ prepared: true });
    const e = fakeExec();
    const { updates } = make(u, e);
    await updates.checkByPerson();
    expect(updates.state.phase).toBe("ready");
    expect(u.calls).not.toContain("download");
    expect(e.runs.some((r) => r[0]?.endsWith("spctl"))).toBe(true);
  });

  it("says why an update was refused, in plain words, and nothing is offered", async () => {
    const sig = make(fakeUpdater(), fakeExec({ badSignature: true }));
    await sig.updates.checkByPerson();
    expect(sig.updates.state).toMatchObject({
      phase: "failed",
      ready: false,
      reason: "Version 0.1.5 was refused: its signature didn't check out.",
    });
    const down = make(fakeUpdater({ manifest: "0.1.3" }));
    await down.updates.checkByPerson();
    expect(down.updates.state.reason).toBe(
      "Version 0.1.3 was refused: it isn't newer than this version (0.1.4).",
    );
    const gk = make(fakeUpdater(), fakeExec({ gatekeeper: false }));
    await gk.updates.checkByPerson();
    expect(gk.updates.state.reason).toMatch(/Gatekeeper rejected it/);
  });

  it("says when it couldn't reach the server, and tries again later", async () => {
    const u = fakeUpdater({ checkError: "Failed to check for updates: fetch failed" });
    const { updates, timers } = make(u);
    await updates.checkByPerson();
    expect(updates.state).toMatchObject({ phase: "failed", checkedAt: NOW });
    expect(updates.state.reason).toMatch(/Couldn't reach the update server/);
    expect(timers).toEqual([RETRY_MS]);
  });

  it("joins a check already running when pressed twice", async () => {
    const u = fakeUpdater();
    const { updates } = make(u);
    await Promise.all([updates.checkByPerson(), updates.checkByPerson(), updates.check()]);
    expect(u.calls.filter((c) => c === "check")).toHaveLength(1);
    expect(u.calls.filter((c) => c === "download")).toHaveLength(1);
    expect(updates.state.phase).toBe("ready");
  });

  it("isn't held back by the automatic triggers' gap", async () => {
    const u = fakeUpdater({ manifest: "0.1.4", running: "0.1.4" });
    const { updates } = make(u);
    await updates.checkNow(1_000);
    await updates.checkNow(2_000);
    await updates.checkByPerson();
    await updates.checkByPerson();
    expect(u.calls.filter((c) => c === "check")).toHaveLength(3);
  });

  it("says updates are off in a dev build, and never checks", async () => {
    const u = fakeUpdater({ channel: "dev" });
    const { updates } = make(u);
    await updates.checkByPerson();
    await updates.start();
    expect(updates.state).toMatchObject({ phase: "off", reason: OFF_DEV, channel: "dev" });
    expect(u.calls).toEqual([]);
  });

  it("says updates are off in an unsigned build, and never downloads", async () => {
    const u = fakeUpdater();
    const { updates } = make(u, fakeExec({ unsigned: true }));
    await updates.checkByPerson();
    await updates.start();
    expect(updates.state).toMatchObject({ phase: "off", reason: OFF_UNSIGNED, error: null });
    expect(u.calls).toEqual([]);
  });
});

describe("plainReason", () => {
  it("names a manifest that couldn't be read, and a failed download", () => {
    expect(plainReason("Failed to check for updates: HTTP 404")).toBe(
      "Couldn't read the update server's list of versions (HTTP 404).",
    );
    expect(plainReason("Failed to check for updates: update.json is not valid JSON")).toBe(
      "Couldn't read the update server's list of versions.",
    );
    expect(plainReason("Failed to download update: HTTP 500")).toMatch(/couldn't be downloaded/);
  });
});

describe("what the person sees", () => {
  const base: UpdateStatus = {
    required: false,
    ready: false,
    version: null,
    error: null,
    needsMove: false,
    jobs: 0,
    waitingForRunner: null,
    downloadUrl: "https://downloads.zerobsai.com/desktop/canary-macos-arm64-Software-Factory.zip",
    phase: "idle",
    checkedAt: null,
    installed: "0.1.4",
    channel: "canary",
    reason: null,
  };
  const view = (u: Partial<UpdateStatus>) => checkView({ ...base, ...u });

  it("disables the button while a check runs", () => {
    expect(view({ phase: "checking" })).toMatchObject({ line: "Checking…", busy: true });
    expect(view({ phase: "downloading", version: "0.1.5" })).toMatchObject({
      line: "Downloading 0.1.5…",
      busy: true,
    });
  });

  it("shows exactly one outcome", () => {
    expect(view({ phase: "up-to-date" }).line).toBe("You're up to date (0.1.4)");
    const ready = view({ phase: "ready", ready: true, version: "0.1.5" });
    expect(ready.line).toBe("0.1.5 is ready: Restart to update");
    expect(ready.actions.map((a) => a.action)).toEqual(["restart"]);
    const failed = view({ phase: "failed", reason: "Couldn't reach the update server." });
    expect(failed).toMatchObject({ tone: "error", line: "Couldn't reach the update server." });
    expect(failed.actions.map((a) => a.label)).toEqual(["Try again"]);
    expect(view({ phase: "off", reason: OFF_DEV })).toMatchObject({ line: OFF_DEV, actions: [] });
  });

  it("never offers a plain restart while the runner has jobs", () => {
    const v = view({ phase: "ready", ready: true, version: "0.1.5", jobs: 2 });
    expect(v.actions.map((a) => a.action)).toEqual(["restart-when-idle", "restart-anyway"]);
    expect(v.actions[1]?.label).toMatch(/cancels 2 jobs/);
    expect(
      view({ phase: "ready", ready: true, version: "0.1.5", waitingForRunner: 1 }).actions,
    ).toEqual([]);
  });

  it("says when it last checked, and what a notification says", () => {
    expect(lastCheckedText(null)).toBe("Not checked yet");
    expect(lastCheckedText(NOW - 30_000, NOW)).toBe("Last checked just now");
    expect(lastCheckedText(NOW - 5 * 60_000, NOW)).toBe("Last checked 5 minutes ago");
    expect(lastCheckedText(NOW - 3 * 3_600_000, NOW)).toBe("Last checked 3 hours ago");
    expect(checkSummary({ ...base, phase: "up-to-date" })).toBe("You're up to date (0.1.4).");
    expect(checkSummary({ ...base, phase: "failed", reason: "Offline." })).toBe("Offline.");
  });
});
