// Spec 08 criterion 7: `sf-runner install` from a shell without Orca still gives the service
// Orca's bin directory, retries a bootstrap that fails right after bootout, and runs the wrapper.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec } from "@software-factory/runner-orca";
import { afterEach, describe, expect, it } from "vitest";
import { install, plist } from "../src/launchd.ts";
import { ORCA_APP_BIN, withOrcaOnPath } from "../src/pairing.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

describe("the service PATH gets Orca's bin directory", () => {
  const files =
    (...present: string[]) =>
    (f: string) =>
      present.includes(f);

  it("adds Orca.app's bin directory when orca isn't on the installing shell's PATH (an SSH session)", () => {
    expect(
      withOrcaOnPath({
        path: "/n/bin:/usr/bin:/bin",
        isFile: files(`${ORCA_APP_BIN}/orca`),
      }),
    ).toEqual({ path: `/n/bin:/usr/bin:/bin:${ORCA_APP_BIN}`, added: ORCA_APP_BIN });
  });

  it("prefers the config's orcaBin", () => {
    expect(
      withOrcaOnPath({
        path: "/usr/bin",
        orcaBin: "/opt/orca/bin/orca",
        isFile: files("/opt/orca/bin/orca", `${ORCA_APP_BIN}/orca`),
      }),
    ).toEqual({ path: "/usr/bin:/opt/orca/bin", added: "/opt/orca/bin" });
  });

  it("leaves a PATH that already has orca alone", () => {
    expect(
      withOrcaOnPath({ path: "/x:/usr/bin", isFile: files("/x/orca", `${ORCA_APP_BIN}/orca`) }),
    ).toEqual({ path: "/x:/usr/bin", added: null });
  });

  it("adds nothing when there is no Orca to find", () => {
    expect(withOrcaOnPath({ path: "/usr/bin", isFile: () => false })).toEqual({
      path: "/usr/bin",
      added: null,
    });
  });
});

describe("plist", () => {
  it("runs the wrapper with the pinned Node, the state dir and the PATH", () => {
    const text = plist({
      node: "/n/bin/node",
      wrapper: "/r/local/runner-host/bin/sf-runner-service",
      workingDirectory: "/r/local/runner-host",
      path: `/n/bin:/usr/bin:${ORCA_APP_BIN}`,
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
    expect(text).toContain(`<key>PATH</key>\n    <string>/n/bin:/usr/bin:${ORCA_APP_BIN}</string>`);
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
