// The updater's decisions (spec 40 M4): what may be applied, and what is refused.
import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  lastFailure,
  parseUpdateResult,
  plainInstallFailure,
  readUpdateResults,
  recordVerdict,
  syncInstallRecord,
  type UpdateResult,
} from "../src/bun/install-record.ts";
import { liveJobs, liveJobsFile, runnerChildEnv } from "../src/bun/runner-jobs.ts";
import type { Exec } from "../src/bun/update-verify.ts";
import {
  bundleInfo,
  discardStaged,
  requirement,
  stagedBundle,
  stagedUpdate,
  TIMED_OUT,
  teamIdOf,
  verifyBundle,
  withTimeout,
} from "../src/bun/update-verify.ts";
import {
  CHANGED_ON_DISK,
  installProblem,
  OFF_DEV,
  OFF_UNSIGNED,
  plainReason,
  RETRY_MS,
  type UpdaterLike,
  Updates,
  VERIFIED_FOR_MS,
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
    results?: UpdateResult[];
    synced?: string[];
    /** The staged bundle's content hash, as it is each time it is taken. */
    fingerprint?: () => Promise<string>;
    now?: () => number;
    discarded?: string[][];
    logs?: string[];
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
      now: over.now ?? (() => NOW),
      discard: (folder, staging) => {
        over.discarded?.push([folder, staging]);
      },
      syncRecord: async (root) => {
        over.synced?.push(root);
      },
      results: () => over.results ?? [],
      fingerprint: over.fingerprint ?? (async () => "same"),
      log: (line) => {
        over.logs?.push(line);
      },
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
    expect(
      e.runs.some(
        (r) => r.includes(`-R=${requirement(TEAM)}`) && r.includes(stagedBundle(STAGED, APP)),
      ),
    ).toBe(true);
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
    // A bundle that changed hashes differently from the one checked at download.
    const { updates } = make(
      u,
      { exec, runs: e.runs },
      { fingerprint: async () => (bad ? "changed" : "checked") },
    );
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

  it("checks the app inside Electrobun's staging folder, named as the running app", () => {
    // The real record: staging_path is `<App>.app.prepared-<hash>`, a folder holding the bundle.
    expect(
      stagedBundle(
        "/Applications/Software Factory-canary.app.prepared-32y1jrsr4ihvs",
        "/Applications/Software Factory-canary.app",
      ),
    ).toBe(
      "/Applications/Software Factory-canary.app.prepared-32y1jrsr4ihvs/Software Factory-canary.app",
    );
    // A record that names a bundle directly is checked as it is.
    expect(stagedBundle("/tmp/x/New.app", "/Applications/Old.app")).toBe("/tmp/x/New.app");
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

describe("Electrobun's install record (InvalidUpdateIdentity)", () => {
  const record = (path: string) =>
    JSON.stringify({
      schema_version: 2,
      identifier: "com.software-factory.desktop",
      app_bundle_path: path,
      channel: "canary",
    });

  it("leaves a record that names the running bundle alone", () => {
    expect(
      recordVerdict({ record: record(APP), helper: true, appPath: APP, channel: "canary" }),
    ).toEqual({
      action: "ok",
    });
  });

  it("rewrites one that names another copy (the app was moved after its first run)", () => {
    const dev = "/Users/x/repo/apps/desktop/build/canary-macos-arm64/Software Factory-canary.app";
    expect(
      recordVerdict({ record: record(dev), helper: true, appPath: APP, channel: "canary" }),
    ).toEqual({
      action: "bootstrap",
      why: "moved",
      recorded: dev,
    });
  });

  it("rewrites one for another identifier or channel (the helper refuses those too)", () => {
    const facts = (over: Record<string, unknown>) => ({
      record: JSON.stringify({
        identifier: "com.software-factory.desktop",
        channel: "canary",
        app_bundle_path: APP,
        ...over,
      }),
      helper: true,
      appPath: APP,
      channel: "canary",
    });
    expect(recordVerdict(facts({ channel: "stable" }))).toEqual({
      action: "bootstrap",
      why: "identity",
      recorded: "com.software-factory.desktop/stable",
    });
    expect(recordVerdict(facts({ identifier: "com.example.other" }))).toMatchObject({
      why: "identity",
    });
    expect(recordVerdict(facts({ identifier: undefined }))).toMatchObject({ why: "unreadable" });
    expect(recordVerdict({ ...facts({}), record: "null" })).toMatchObject({ why: "unreadable" });
    expect(recordVerdict(facts({}))).toEqual({ action: "ok" });
  });

  it("rewrites a missing or unreadable record, or a missing helper copy", () => {
    expect(
      recordVerdict({ record: null, helper: true, appPath: APP, channel: "canary" }),
    ).toMatchObject({
      why: "missing",
    });
    expect(
      recordVerdict({ record: record(APP), helper: false, appPath: APP, channel: "canary" }),
    ).toMatchObject({
      why: "missing",
    });
    expect(
      recordVerdict({ record: "{", helper: true, appPath: APP, channel: "canary" }),
    ).toMatchObject({
      why: "unreadable",
    });
    expect(
      recordVerdict({ record: "{}", helper: true, appPath: APP, channel: "canary" }),
    ).toMatchObject({
      why: "unreadable",
    });
  });

  it("runs the running bundle's own helper with --bootstrap-install, and only when needed", async () => {
    const runs: string[][] = [];
    const exec: Exec = async (cmd, args) => {
      runs.push([cmd, ...args]);
      return { code: 0, out: "" };
    };
    const deps = (rec: string | null) => ({
      exec,
      read: () => rec,
      exists: () => true,
      realpath: (p: string) => p,
      log: () => {},
    });
    await syncInstallRecord("/data/canary", APP, "canary", deps(record(APP)));
    expect(runs).toEqual([]);
    const out = await syncInstallRecord(
      "/data/canary",
      APP,
      "canary",
      deps(record("/elsewhere/A.app")),
    );
    expect(out).toMatchObject({ action: "bootstrap", why: "moved" });
    expect(runs).toEqual([
      [`${APP}/Contents/Resources/uninstall`, "--bootstrap-install", "/data/canary", "--quiet"],
    ]);
  });

  it("reports a helper that fails, and never throws", async () => {
    const out = await syncInstallRecord("/data/canary", APP, "canary", {
      exec: async () => ({ code: 1, out: "InvalidInstallLocation" }),
      read: () => null,
      exists: () => false,
      realpath: (p) => p,
      log: () => {},
    });
    expect(out).toMatchObject({ action: "failed" });
    const thrown = await syncInstallRecord("/data/canary", APP, "canary", {
      exec: async () => ({ code: 0, out: "" }),
      realpath: () => {
        throw new Error("ENOENT");
      },
      log: () => {},
    });
    expect(thrown).toMatchObject({ action: "failed", error: "ENOENT" });
  });

  it("gives up on a helper that hangs, so update checks carry on", async () => {
    const out = await syncInstallRecord("/data/canary", APP, "canary", {
      exec: () => new Promise(() => {}),
      read: () => null,
      exists: () => false,
      realpath: (p) => p,
      log: () => {},
      timeoutMs: 5,
    });
    expect(out).toMatchObject({ action: "failed" });
    expect((out as { error: string }).error).toMatch(/didn't finish: .* timed out after 0.005 s/);
  });

  it("puts the record right before checking and again before applying", async () => {
    const synced: string[] = [];
    const u = fakeUpdater();
    const { updates } = make(u, fakeExec(), { synced });
    await updates.start();
    expect(synced).toEqual(["/data"]);
    expect(u.calls[0]).toBe("check");
    await updates.apply();
    expect(synced).toEqual(["/data", "/data"]);
  });
});

describe("an update that didn't install", () => {
  const failed: UpdateResult = {
    success: false,
    phase: "validating",
    message: "InvalidUpdateIdentity",
    version: "0.1.70",
    modifiedAt: 2,
  };

  it("finds the newest result when it failed for a newer version", () => {
    expect(lastFailure([failed], "0.1.56")).toEqual({
      version: "0.1.70",
      message: "InvalidUpdateIdentity",
      phase: "validating",
    });
    // Installed since (or a later attempt succeeded): nothing to say.
    expect(lastFailure([failed], "0.1.70")).toBeNull();
    expect(lastFailure([failed, { ...failed, success: true, modifiedAt: 3 }], "0.1.56")).toBeNull();
    expect(lastFailure([], "0.1.56")).toBeNull();
  });

  it("says it in plain words", () => {
    expect(plainInstallFailure(failed)).toBe(
      "The update to 0.1.70 didn't install: the updater's record of where the app is installed named another copy (the app was moved after it was first opened).",
    );
    expect(
      plainInstallFailure({ version: "0.1.70", message: "AccessDenied", phase: "swapping" }),
    ).toBe("The update to 0.1.70 didn't install: the updater stopped while replacing the app.");
    // Codes and phases this app doesn't know are never shown as written.
    expect(plainInstallFailure({ version: "<b>9</b>", message: "Weird", phase: "elsewhere" })).toBe(
      "The update to the new version didn't install: the updater stopped before it finished.",
    );
  });

  it("passes only semver versions and bare codes from a result file", () => {
    const doc = (over: Record<string, unknown>) =>
      JSON.stringify({
        success: false,
        phase: "validating",
        message: "InvalidUpdateIdentity",
        version: "0.1.70",
        ...over,
      });
    expect(parseUpdateResult(doc({}), 5)).toEqual({
      success: false,
      phase: "validating",
      message: "InvalidUpdateIdentity",
      version: "0.1.70",
      modifiedAt: 5,
    });
    expect(parseUpdateResult(doc({ version: "0.1.70-canary.3" }), 5)).not.toBeNull();
    for (const bad of [
      { version: "0.1" },
      { version: "0.1.70 <script>" },
      { version: `0.1.70-${"x".repeat(80)}` },
      { phase: "validating!" },
      { message: "Couldn't open /Users/someone/file" },
      { message: "A".repeat(65) },
      { message: "" },
      { success: "no" },
    ])
      expect(parseUpdateResult(doc(bad), 5)).toBeNull();
    expect(parseUpdateResult("[1]", 5)).toBeNull();
    expect(parseUpdateResult("nope", 5)).toBeNull();
  });

  it("sorts result files newest first before the limit, and prunes the older ones", () => {
    // 25 results; the newest failure listed last (directory order is arbitrary).
    const names = Array.from(
      { length: 25 },
      (_, i) => `.electrobun-update-${i.toString(16).padStart(32, "0")}.result.json`,
    );
    const mtime = (path: string) => Number.parseInt(path.slice(-44, -12), 16);
    const removed: string[] = [];
    const results = readUpdateResults("/data", 20, {
      list: () => [...names].reverse().concat("other.json"),
      stat: (p) => ({ isFile: () => true, size: 100, mtimeMs: mtime(p) }),
      read: (p) =>
        JSON.stringify({
          success: mtime(p) !== 24,
          phase: mtime(p) === 24 ? "swapping" : "complete",
          message: mtime(p) === 24 ? "AccessDenied" : "ok",
          version: `0.1.${mtime(p)}`,
        }),
      remove: (p) => removed.push(p),
    });
    expect(results).toHaveLength(20);
    expect(results[0]).toMatchObject({ success: false, version: "0.1.24" });
    expect(lastFailure(results, "0.1.1")?.version).toBe("0.1.24");
    expect(removed.map(mtime).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
  });

  it("reads the helper's result files and nothing else", () => {
    const dir = mkdtempSync(join(tmpdir(), "sf-results-"));
    try {
      writeFileSync(
        join(dir, `.electrobun-update-${"a".repeat(32)}.result.json`),
        JSON.stringify({
          schema_version: 1,
          transaction_id: "a".repeat(32),
          success: false,
          phase: "validating",
          message: "InvalidUpdateIdentity",
          identifier: "com.software-factory.desktop",
          channel: "canary",
          version: "0.1.70",
          hash: "16goeidwc86x6",
        }),
      );
      writeFileSync(join(dir, ".electrobun-update-nothex.result.json"), "{}");
      writeFileSync(join(dir, `.electrobun-update-${"b".repeat(32)}.result.json`), "not json");
      const results = readUpdateResults(dir);
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ success: false, version: "0.1.70" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is shown after the relaunch with Retry, not as a fresh Restart to update", async () => {
    const u = fakeUpdater({ manifest: "0.1.70", running: "0.1.56", prepared: true });
    const { updates } = make(u, fakeExec(), { results: [failed] });
    await updates.start();
    expect(updates.state).toMatchObject({ ready: true, version: "0.1.70" });
    expect(updates.state.installFailure?.reason).toMatch(/^The update to 0.1.70 didn't install/);
    const status: UpdateStatus = {
      required: false,
      ready: true,
      version: "0.1.70",
      error: null,
      needsMove: false,
      jobs: 0,
      waitingForRunner: null,
      downloadUrl: "",
      phase: "ready",
      checkedAt: NOW,
      installed: "0.1.56",
      channel: "canary",
      reason: null,
      installFailure: updates.state.installFailure ?? null,
    };
    const v = checkView(status);
    expect(v.tone).toBe("error");
    expect(v.line).toMatch(/didn't install/);
    expect(v.actions).toEqual([
      { action: "restart", label: "Retry the update", variant: "default" },
    ]);
  });
});

describe("the click is fast: the check is done at download", () => {
  const verifies = (runs: string[][]) =>
    runs.filter((r) => r.includes("--verify") || r[0]?.endsWith("spctl")).length;

  it("checks the staged bundle when it lands, and only hashes it again to apply", async () => {
    const u = fakeUpdater();
    const e = fakeExec();
    const { updates } = make(u, e);
    await updates.check();
    expect(updates.state.ready).toBe(true);
    expect(verifies(e.runs)).toBe(2); // codesign --verify and spctl, once
    expect(await updates.verifyForApply()).toBeNull();
    await updates.apply();
    expect(verifies(e.runs)).toBe(2); // not again
    expect(u.calls).toContain("apply");
  });

  it("never applies a bundle that changed since it was checked: counts it, says so and downloads it again", async () => {
    const u = fakeUpdater();
    const e = fakeExec();
    let hash = "first";
    const discarded: string[][] = [];
    const logs: string[] = [];
    const { updates } = make(u, e, { fingerprint: async () => hash, discarded, logs });
    await updates.check();
    const checks = verifies(e.runs);
    const downloads = u.calls.filter((c) => c === "download").length;
    hash = "changed";
    const why = await updates.verifyForApply();
    expect(why).toBe(CHANGED_ON_DISK);
    expect(updates.state.reason).toBe(
      "The downloaded update changed on disk: downloading it again.",
    );
    expect(updates.hashMismatches).toBe(1);
    expect(logs.some((l) => /changed on disk .*hash mismatch 1 this session/.test(l))).toBe(true);
    expect(discarded).toEqual([["/data", STAGED]]);
    // Not silently checked again in place: downloaded again, then checked in full when it lands.
    await updates.check();
    expect(u.calls.filter((c) => c === "download").length).toBe(downloads + 1);
    expect(verifies(e.runs)).toBe(checks + 2);
    expect(u.calls).not.toContain("apply");
  });

  it("checks in full again at the click when the last full check is more than a day old", async () => {
    const u = fakeUpdater();
    const e = fakeExec();
    let now = NOW;
    const logs: string[] = [];
    const { updates } = make(u, e, { now: () => now, logs });
    await updates.check();
    const before = verifies(e.runs);
    now = NOW + VERIFIED_FOR_MS - 1;
    expect(await updates.verifyForApply()).toBeNull();
    expect(verifies(e.runs)).toBe(before); // a day, just: the hash is enough
    now = NOW + VERIFIED_FOR_MS + 1;
    expect(await updates.verifyForApply()).toBeNull();
    expect(verifies(e.runs)).toBe(before + 2); // codesign --verify and spctl again
    expect(logs.some((l) => /checked 24 h ago: checking it in full again/.test(l))).toBe(true);
    // Checked in full just now: the next click only hashes again.
    expect(await updates.verifyForApply()).toBeNull();
    expect(verifies(e.runs)).toBe(before + 2);
  });

  it("refuses a bundle that fails its full check again", async () => {
    const u = fakeUpdater();
    const e = fakeExec();
    let now = NOW;
    let bad = false;
    const exec: Exec = (cmd, args) =>
      bad && cmd.endsWith("codesign") && args[0] === "--verify"
        ? Promise.resolve({ code: 1, out: "CSSMERR_TP_CERT_REVOKED" })
        : e.exec(cmd, args);
    const { updates } = make(u, { exec, runs: e.runs }, { now: () => now });
    await updates.check();
    now = NOW + VERIFIED_FOR_MS + 1;
    bad = true;
    expect(await updates.verifyForApply()).toMatch(/signature/);
    expect(updates.state.reason).toBe("Version 0.1.5 was refused: its signature didn't check out.");
    await updates.apply();
    expect(u.calls).not.toContain("apply");
  });

  it("discards only Electrobun's own staging folder and its record", () => {
    const removed: string[] = [];
    discardStaged("/data", "/Applications/A.app.prepared-16goeidwc86x6", (p) => removed.push(p));
    discardStaged("/data", "/Users/someone", (p) => removed.push(p));
    expect(removed).toEqual([
      "/data/self-extraction/.electrobun-prepared-update.json",
      "/Applications/A.app.prepared-16goeidwc86x6",
      "/data/self-extraction/.electrobun-prepared-update.json",
    ]);
  });

  it("bounds a command that hangs (withTimeout)", async () => {
    const hung = withTimeout(() => new Promise(() => {}), 5);
    expect(await hung("/usr/sbin/spctl", [])).toEqual({
      code: TIMED_OUT,
      out: "/usr/sbin/spctl timed out after 0.005 s",
    });
    const quick = withTimeout(async () => ({ code: 0, out: "ok" }), 1_000);
    expect(await quick("x", [])).toEqual({ code: 0, out: "ok" });
  });

  it("doesn't remember a bundle that changed while it was being checked", async () => {
    const u = fakeUpdater();
    const e = fakeExec();
    let n = 0;
    const { updates } = make(u, e, { fingerprint: async () => `take-${n++}` });
    await updates.check();
    expect(updates.state.ready).toBe(true);
    const before = verifies(e.runs);
    await updates.verifyForApply();
    expect(verifies(e.runs)).toBe(before + 2); // checked in full again
  });

  it("checks in full when another version is staged now", async () => {
    const u = fakeUpdater();
    const e = fakeExec();
    let staged = "0.1.5";
    const { updates } = make(u, e);
    await updates.check();
    // The staged record changes under it (a later download), same hash: still checked in full.
    const before = verifies(e.runs);
    staged = "0.1.6";
    (updates as unknown as { d: { staged: () => unknown; bundle: () => unknown } }).d.staged =
      () => ({
        version: staged,
        hash: "def",
        path: `${STAGED}-2`,
      });
    (updates as unknown as { d: { bundle: () => unknown } }).d.bundle = () => ({
      version: staged,
      channel: "canary",
    });
    expect(await updates.verifyForApply()).toBeNull();
    expect(verifies(e.runs)).toBe(before + 2);
  });
});
