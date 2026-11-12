// A container per job (ADR 0430): inside a container every stage defaults to bypassPermissions,
// the project's mode for a stage still wins, and Claude's own sandbox is off (the container is the
// floor). The rest of the settings are the sandbox runs' (ADR 0270).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JOB_STAGES, type Job } from "@software-factory/runner-contract";
import { afterEach, describe, expect, it } from "vitest";
import {
  claudeArgv,
  DEFAULT_MODES,
  projectHarness,
  readLaunchRecord,
  runSettings,
  stageMode,
} from "../src/index.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const job = (stage: Job["stage"], profile?: Job["harness"]["profile"]) => ({
  jobId: "job_1",
  stage,
  harness: {
    id: "claude-code" as const,
    role: "implement" as const,
    prompt: "p",
    ...(profile ? { profile } : {}),
  },
});

describe("container isolation (ADR 0430)", () => {
  it("runs every stage in bypassPermissions, in the settings and the argv", () => {
    for (const stage of JOB_STAGES) {
      const s = runSettings(job(stage), { worktree: "/w", runDir: "/r", isolation: "container" });
      expect(s.permissions.defaultMode, stage).toBe("bypassPermissions");
      expect(s.skipDangerousModePermissionPrompt, stage).toBe(true);
      const argv = claudeArgv(job(stage), { settingsPath: "/r/s.json", isolation: "container" });
      expect(argv.slice(1, 3), stage).toEqual(["--permission-mode", "bypassPermissions"]);
      // The sandbox runs keep their modes.
      expect(stageMode(stage), stage).toBe(DEFAULT_MODES[stage]);
    }
  });

  it("keeps the project's mode for a stage", () => {
    const profile = { permissionMode: { triage: "dontAsk" as const } };
    const s = runSettings(job("triage", profile), {
      worktree: "/w",
      runDir: "/r",
      isolation: "container",
      profile,
    });
    expect(s.permissions.defaultMode).toBe("dontAsk");
    expect(
      claudeArgv(job("triage", profile), { settingsPath: "/s", isolation: "container" }),
    ).toContain("dontAsk");
    expect(stageMode("build", profile, "container")).toBe("bypassPermissions");
  });

  it("turns Claude's sandbox off inside a container and keeps the rest of the floor", () => {
    const sandboxed = runSettings(job("build"), { worktree: "/w", runDir: "/r" });
    const contained = runSettings(job("build"), {
      worktree: "/w",
      runDir: "/r",
      isolation: "container",
    });
    expect(sandboxed.sandbox.enabled).toBe(true);
    expect(sandboxed.sandbox.failIfUnavailable).toBe(true);
    expect(contained.sandbox.enabled).toBe(false);
    expect(contained.sandbox.failIfUnavailable).toBe(false);
    expect(contained.sandbox.allowUnsandboxedCommands).toBe(false);
    expect(contained.permissions.deny).toEqual(sandboxed.permissions.deny);
    expect(contained.env).toEqual(sandboxed.env);
  });

  it("records the isolation in the launch record", async () => {
    const root = await mkdtemp(join(tmpdir(), "sf-iso-"));
    dirs.push(root);
    const runDir = join(root, "run");
    await projectHarness(job("spec"), {
      worktree: join(root, "work"),
      runDir,
      runTmp: join(root, "tmp"),
      isolation: "container",
      claudeBin: "claude",
    });
    const record = await readLaunchRecord(runDir);
    expect(record?.isolation).toBe("container");
    expect(record?.mode).toBe("bypassPermissions");
    expect(record?.argv.slice(0, 3)).toEqual(["claude", "--permission-mode", "bypassPermissions"]);
  });
});
