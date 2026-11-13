// Where a `sandbox` runner's checks run (ADR 0501, fourth review): Linux on the OS sandbox; a Mac in
// a check container when a runtime answers, else not run, unless its owner opted in to the weaker
// macOS sandbox. Fakes only: the real container path is runner-local's integration test.
import { realpathSync } from "node:fs";
import type { ExecResult, Job } from "@software-factory/runner-contract";
import type { ContainerRuntime } from "@software-factory/runner-local";
import { describe, expect, it } from "vitest";
import { checkModeReport, localChecks, NO_MAC_CONTAINER_LINE } from "../src/check-mode.ts";
import { macTempDenies, macUserDirs } from "../src/check-sandbox.ts";
import { hostManifest, runChecks } from "../src/checks.ts";
import { configSchema, paths } from "../src/config.ts";
import { checkLine, checkReadiness } from "../src/runner.ts";

const never = new AbortController().signal;
const job = {
  jobId: "job_1",
  harness: { id: "claude-code", role: "implement", prompt: "" },
} as Job;
const dirs = { root: "/c/job_1-x/r0-0", dir: "/c/job_1-x/r0-0/tree" };
const SHA = "a".repeat(40);

const runtime = (answers: boolean) =>
  ({
    version: async () => {
      if (!answers) throw new Error("the Docker server isn't reachable: Cannot connect");
      return "28.0";
    },
  }) as unknown as ContainerRuntime;

const ran = (isolation: ExecResult["isolation"]) => () => async (): Promise<ExecResult> => ({
  exitCode: 0,
  timedOut: false,
  output: `ran in ${isolation}`,
  ...(isolation ? { isolation } : {}),
});

describe("where a sandbox runner's checks run (ADR 0501, fourth review)", () => {
  it("on a Mac with a container runtime: in a check container", async () => {
    const exec = localChecks({
      platform: "darwin",
      runtime: runtime(true),
      sandbox: ran("weaker-sandbox"),
      container: ran("container"),
    });
    const [r] = await runChecks(
      [{ name: "tests", run: "pnpm test", timeoutMs: 1_000 }],
      exec?.(job, dirs) ?? null,
      SHA,
      0,
      never,
    );
    expect(r).toMatchObject({ exitCode: 0, isolation: "container" });
    expect(r?.notRun).toBeUndefined();
  });

  it("on a Mac without one: not run, with the reason, never the weaker sandbox by default", async () => {
    const exec = localChecks({
      platform: "darwin",
      runtime: runtime(false),
      sandbox: ran("weaker-sandbox"),
      container: ran("container"),
    });
    const [r] = await runChecks(
      [{ name: "tests", run: "pnpm test", timeoutMs: 1_000 }],
      exec?.(job, dirs) ?? null,
      SHA,
      0,
      never,
    );
    expect(r).toMatchObject({ exitCode: null, notRun: NO_MAC_CONTAINER_LINE });
    expect(r?.isolation).toBeUndefined();
    expect(r?.logTail).toContain("Cannot connect");
    // No runtime configured at all: the same.
    const none = localChecks({ platform: "darwin", runtime: null, sandbox: ran("weaker-sandbox") });
    expect((await none?.(job, dirs)({ run: "x", timeoutMs: 1 }, never))?.notRun).toBe(
      NO_MAC_CONTAINER_LINE,
    );
  });

  it("on a Mac whose owner opted in: the weaker sandbox, and the result says so", async () => {
    const exec = localChecks({
      platform: "darwin",
      runtime: runtime(false),
      weakerMacSandbox: true,
      sandbox: ran("weaker-sandbox"),
      container: ran("container"),
    });
    const [r] = await runChecks(
      [{ name: "tests", run: "pnpm test", timeoutMs: 1_000 }],
      exec?.(job, dirs) ?? null,
      SHA,
      0,
      never,
    );
    expect(r).toMatchObject({ exitCode: 0, isolation: "weaker-sandbox" });
  });

  it("on Linux: the OS sandbox, whatever the runtime", () => {
    const sandbox = ran("sandbox");
    expect(localChecks({ platform: "linux", runtime: runtime(true), sandbox })).toBe(sandbox);
  });

  it("says which mode and why, for sf-runner doctor", async () => {
    expect(
      await checkModeReport({ platform: "darwin", runtime: runtime(true), sandboxAvailable: true }),
    ).toMatchObject({ mode: "container" });
    const none = await checkModeReport({
      platform: "darwin",
      runtime: runtime(false),
      sandboxAvailable: true,
    });
    expect(none.mode).toBe("none");
    expect(none.why).toBe(NO_MAC_CONTAINER_LINE);
    expect(none.why).toContain("checks.weakerMacSandbox");
    expect(
      await checkModeReport({
        platform: "darwin",
        runtime: runtime(false),
        weakerMacSandbox: true,
        sandboxAvailable: true,
      }),
    ).toMatchObject({ mode: "weaker-sandbox" });
    expect(
      await checkModeReport({ platform: "linux", runtime: null, sandboxAvailable: true }),
    ).toMatchObject({ mode: "sandbox" });
    expect(
      await checkModeReport({ platform: "linux", runtime: null, sandboxAvailable: false }),
    ).toMatchObject({ mode: "none" });
  });

  it("denies a Mac check the shared temp dirs and the user's /var/folders", () => {
    expect(macTempDenies(["/var/folders/ab/cd1234/T/"])).toEqual([
      "/tmp",
      "/private/tmp",
      "/var/folders/ab/cd1234",
      "/private/var/folders/ab/cd1234",
    ]);
    expect(macTempDenies(["/private/var/folders/ab/cd1234/T"])).toContain("/var/folders/ab/cd1234");
    expect(
      macTempDenies(["/var/folders/ab/cd1234/T/", "/var/folders/ab/cd1234/C/"]).filter((d) =>
        d.includes("cd1234"),
      ),
    ).toEqual(["/var/folders/ab/cd1234", "/private/var/folders/ab/cd1234"]);
  });

  it.runIf(process.platform === "darwin")(
    "finds the user's /var/folders from the system, not TMPDIR (the launchd job sets none)",
    () => {
      // As the runner's launchd job runs it: PATH and HOME, no TMPDIR.
      const dirs = macUserDirs({ PATH: "/usr/bin:/bin", HOME: process.env.HOME });
      expect(dirs).toHaveLength(2);
      const denied = macTempDenies(dirs);
      const real = realpathSync(dirs[0] as string);
      const parent = /^(?:\/private)?(\/var\/folders\/[^/]+\/[^/]+)/.exec(real)?.[1];
      expect(parent).toBeDefined();
      expect(denied).toContain(parent);
      expect(denied).toContain(`/private${parent}`);
    },
  );
  it("declares `checks` when told to, with the one line on where they run", () => {
    const m = { contractVersion: 1, capabilities: ["git-push"] } as unknown as Parameters<
      typeof hostManifest
    >[0];
    expect(hostManifest(m).capabilities).toContain("checks");
    expect(hostManifest(m, false).capabilities).not.toContain("checks");
    // An adapter that claims it, on a host that doesn't declare it (a sprite runner): not declared.
    const claims = { ...m, capabilities: ["git-push", "checks"] } as typeof m;
    expect(hostManifest(claims, false).capabilities).toEqual(["git-push"]);
    expect(hostManifest(m, true, "container: a fresh check container").checksNote).toBe(
      "container: a fresh check container",
    );
  });

  it("says a Mac with no answering runtime can't run them, in the same line its checks report", async () => {
    const base = configSchema.parse({ runnerId: "r_abcdef12", key: "k".repeat(32) });
    const dead = async () => ({
      code: 1,
      stdout: "",
      stderr: "Cannot connect to the Docker daemon",
    });
    const r = await checkReadiness(base, paths(), dead, "darwin");
    expect(r).toMatchObject({ mode: "none", ok: false, why: NO_MAC_CONTAINER_LINE });
    expect(checkLine(r)).toBe(
      "not run here: this Mac runner has no container runtime (neither Docker Desktop nor OrbStack is answering): start one, or set checks.weakerMacSandbox",
    );
  });

  it("says a sprite runner runs no checks here, and a container runner checks in containers", async () => {
    const base = configSchema.parse({ runnerId: "r_abcdef12", key: "k".repeat(32) });
    const sprites = await checkReadiness({ ...base, isolation: "sprites" }, paths());
    expect(sprites).toMatchObject({ mode: "none", ok: false });
    const containers = await checkReadiness({ ...base, isolation: "container" }, paths());
    expect(containers).toMatchObject({ mode: "container", ok: true });
  });
});
