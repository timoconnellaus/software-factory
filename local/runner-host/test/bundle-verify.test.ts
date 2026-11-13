import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  developerIdRequirement,
  type Exec,
  NODE_IDENTIFIER,
  RUNNER_IDENTIFIER,
  teamIdOf,
  verifyRunnerBundle,
} from "../src/bundle-verify.ts";

const TEAM = "ABCDE12345";
const APP = "/tmp/staged/SF Runner.app";
const VERSION = { version: "0.2.0", channel: "canary", runnerSha: "a".repeat(40), runnerSeq: 120 };

function fake(opts: { sig?: number; node?: number; gk?: number } = {}): {
  exec: Exec;
  calls: string[][];
} {
  const calls: string[][] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd.endsWith("codesign") && args[0] === "-dv")
      return { code: 0, out: `Identifier=${RUNNER_IDENTIFIER}\nTeamIdentifier=${TEAM}\n` };
    if (cmd.endsWith("codesign") && args.at(-1)?.endsWith("/Contents/Helpers/node"))
      return { code: opts.node ?? 0, out: "test requirement not satisfied" };
    if (cmd.endsWith("codesign"))
      return { code: opts.sig ?? 0, out: "a sealed resource is missing or invalid" };
    return { code: opts.gk ?? 0, out: "rejected" };
  };
  return { exec, calls };
}

const reading = (doc: object | string) => () =>
  typeof doc === "string" ? doc : JSON.stringify(doc);

describe("bundle-verify (spec 45 §2, §5)", () => {
  it("passes a bundle signed by this team, accepted by Gatekeeper, sealed with what was expected", async () => {
    const { exec, calls } = fake();
    expect(await verifyRunnerBundle(APP, TEAM, VERSION, exec, reading(VERSION))).toBeNull();
    expect(calls[0]).toContain(`-R=${developerIdRequirement(RUNNER_IDENTIFIER, TEAM)}`);
    expect(calls[0]).toContain("--deep");
    // The nested Node, against its own identifier and the same team.
    expect(calls[1]).toContain(`-R=${developerIdRequirement(NODE_IDENTIFIER, TEAM)}`);
    expect(calls[1]?.at(-1)).toBe(`${APP}/Contents/Helpers/node`);
    expect(calls[2]?.[0]).toBe("/usr/sbin/spctl");
  });

  it("refuses without a Team ID of its own, a bad seal, Gatekeeper's no, or the wrong version.json", async () => {
    const ok = reading(VERSION);
    expect(await verifyRunnerBundle(APP, null, VERSION, fake().exec, ok)).toMatch(/no Team ID/);
    expect(await verifyRunnerBundle(APP, 'X" or true', VERSION, fake().exec, ok)).toMatch(
      /no Team ID/,
    );
    expect(await verifyRunnerBundle(APP, TEAM, VERSION, fake({ sig: 1 }).exec, ok)).toMatch(
      /signature/,
    );
    // The outer seal checks out, but Node is another team's or another identifier.
    expect(await verifyRunnerBundle(APP, TEAM, VERSION, fake({ node: 3 }).exec, ok)).toMatch(
      /Contents\/Helpers\/node: its signature/,
    );
    expect(await verifyRunnerBundle(APP, TEAM, VERSION, fake({ gk: 3 }).exec, ok)).toMatch(
      /Gatekeeper/,
    );
    expect(await verifyRunnerBundle(APP, TEAM, VERSION, fake().exec, reading("{"))).toMatch(
      /no sealed/,
    );
    for (const [key, value] of [
      ["version", "0.1.9"],
      ["channel", "stable"],
      ["runnerSha", "b".repeat(40)],
      ["runnerSeq", 119],
    ] as const) {
      const why = await verifyRunnerBundle(
        APP,
        TEAM,
        VERSION,
        fake().exec,
        reading({ ...VERSION, [key]: value }),
      );
      expect(why, key).toMatch(new RegExp(`sealed ${key}`));
    }
  });

  it("reads the Team ID only from a real signature", async () => {
    expect(await teamIdOf(APP, fake().exec)).toBe(TEAM);
    expect(
      await teamIdOf(APP, async () => ({ code: 0, out: "TeamIdentifier=not set\n" })),
    ).toBeNull();
  });

  it.skipIf(process.platform !== "darwin")(
    "codesign parses the requirement, and an ad-hoc bundle doesn't meet it",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "sf-verify-"));
      const app = join(dir, "SF Runner.app");
      mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
      cpSync("/usr/bin/true", join(app, "Contents", "MacOS", "sf-runner"));
      writeFileSync(
        join(app, "Contents", "Info.plist"),
        `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${RUNNER_IDENTIFIER}</string><key>CFBundleExecutable</key><string>sf-runner</string></dict></plist>`,
      );
      execFileSync("codesign", ["--force", "--sign", "-", app], { stdio: "ignore" });
      const r = spawnSync(
        "codesign",
        [
          "--verify",
          "--deep",
          "--strict",
          `-R=${developerIdRequirement(RUNNER_IDENTIFIER, TEAM)}`,
          app,
        ],
        { encoding: "utf8" },
      );
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/does not satisfy|failed to satisfy/);
      expect(r.stderr).not.toMatch(/syntax|parse/i);
    },
  );
});
