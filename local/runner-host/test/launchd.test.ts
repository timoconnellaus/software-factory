// Spec 08 criterion 7 (with Orca gone, spec 30): `sf-runner install` from a shell without them
// (an SSH session) still gives the service the directories of `tmux` and `claude`, retries a
// bootstrap that fails right after bootout, and runs the wrapper.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec } from "@software-factory/runner-local";
import { afterEach, describe, expect, it } from "vitest";
import { install, plist } from "../src/launchd.ts";
import { findOnPath, serviceNode } from "../src/pairing.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

describe("the service PATH gets tmux's and claude's directories", () => {
  const files =
    (...present: string[]) =>
    (f: string) =>
      present.includes(f);

  it("finds claude in ~/.local/bin and tmux in Homebrew when the shell's PATH has neither (an SSH session)", () => {
    const isFile = files("/opt/homebrew/bin/tmux", "/Users/t/.local/bin/claude");
    const tmux = findOnPath("tmux", "/usr/bin:/bin", isFile, ["/Users/t/.local/bin"]);
    const claude = findOnPath("claude", "/usr/bin:/bin", isFile, ["/Users/t/.local/bin"]);
    expect([tmux, claude]).toEqual(["/opt/homebrew/bin/tmux", "/Users/t/.local/bin/claude"]);
    expect(
      serviceNode({
        execPath: "/n/bin/node",
        version: "v24.1.0",
        path: "/usr/bin:/bin",
        tools: [tmux, claude].filter((t): t is string => !!t),
      }).path,
    ).toBe("/n/bin:/usr/bin:/bin:/opt/homebrew/bin:/Users/t/.local/bin");
  });

  it("prefers the shell's PATH and finds nothing that isn't there", () => {
    expect(findOnPath("tmux", "/x:/usr/bin", files("/x/tmux", "/opt/homebrew/bin/tmux"))).toBe(
      "/x/tmux",
    );
    expect(findOnPath("claude", "/usr/bin", () => false, ["/Users/t/.local/bin"])).toBeNull();
  });
});

describe("plist", () => {
  it("runs the wrapper with the pinned Node, the state dir and the PATH", () => {
    const text = plist({
      node: "/n/bin/node",
      wrapper: "/r/local/runner-host/bin/sf-runner-service",
      workingDirectory: "/r/local/runner-host",
      path: `/n/bin:/usr/bin:/opt/homebrew/bin`,
      home: "/Users/t",
      logFile: "/Users/t/Library/Logs/software-factory/runner.log",
      stateDir: "/Users/t/.local/state/software-factory/runner",
    });
    expect(text).toContain(
      "<array>\n    <string>/bin/sh</string>\n    <string>/r/local/runner-host/bin/sf-runner-service</string>\n  </array>",
    );
    expect(text).toContain("<key>SF_RUNNER_NODE</key>\n    <string>/n/bin/node</string>");
    expect(text).toContain(
      "<key>SF_RUNNER_STATE_DIR</key>\n    <string>/Users/t/.local/state/software-factory/runner</string>",
    );
    expect(text).toContain(
      `<key>PATH</key>\n    <string>/n/bin:/usr/bin:/opt/homebrew/bin</string>`,
    );
    expect(text).toMatch(/<key>SuccessfulExit<\/key>\s*<false\/>/);
  });
});

describe("launchctl bootstrap after bootout", () => {
  async function fakeLaunchctl(failures: number) {
    const dir = await mkdtemp(join(tmpdir(), "sf-launchd-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const calls: string[] = [];
    let left = failures;
    const exec: Exec = async (cmd, args) => {
      calls.push(`${cmd} ${args[0]}`);
      if (args[0] === "bootstrap" && left-- > 0) {
        return { code: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const slept: number[] = [];
    const sleep = async (ms: number) => {
      slept.push(ms);
    };
    return { file: join(dir, "agents", "x.plist"), calls, exec, slept, sleep };
  }

  it("retries a bootstrap that fails right after bootout", async () => {
    const f = await fakeLaunchctl(2);
    await install(f.exec, f.file, "<plist/>", { sleep: f.sleep });
    expect(f.calls).toEqual([
      "launchctl bootout",
      "launchctl bootstrap",
      "launchctl bootstrap",
      "launchctl bootstrap",
    ]);
    expect(f.slept).toEqual([1_000, 2_000]);
    expect(await readFile(f.file, "utf8")).toBe("<plist/>");
  });

  it("gives up after five tries with launchctl's error", async () => {
    const f = await fakeLaunchctl(99);
    await expect(install(f.exec, f.file, "<plist/>", { sleep: f.sleep })).rejects.toThrow(
      /failed 5 times: Bootstrap failed: 5: Input\/output error/,
    );
    expect(f.calls.filter((c) => c === "launchctl bootstrap")).toHaveLength(5);
  });
});
