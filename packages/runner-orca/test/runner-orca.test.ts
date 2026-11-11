import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLaunchRecord, SETTINGS_FILE } from "@software-factory/harness-claude";
import type { AdapterEvent, Job } from "@software-factory/runner-contract";
import { describe, expect, it } from "vitest";
import {
  agentStatus,
  checkRunningHarness,
  createOrcaRunner,
  type OrcaRunnerConfig,
} from "../src/adapter.ts";
import type { Exec } from "../src/exec.ts";
import type { OrcaAgentRow } from "../src/orca-cli.ts";

const ok = (result: unknown) => ({
  stdout: JSON.stringify({ ok: true, result }),
  stderr: "",
  code: 0,
});
const fail = (code: string) => ({
  stdout: JSON.stringify({ ok: false, error: { code, message: code } }),
  stderr: "",
  code: 1,
});

/** A scripted `orca` + `git`: answers by subcommand, records every call. */
function scripted(
  repoPath: string,
  agentStates: Array<Partial<OrcaAgentRow>>,
  wtPath: string,
  branch = "factory/7-add-a-line-run-1",
  opts: { trustDialog?: boolean } = {},
) {
  const calls: string[] = [];
  let ps = 0;
  let removed = false;
  let launched = false;
  let trustAnswered = !opts.trustDialog;
  const worktreeId = `repo1::${wtPath}`;
  const exec: Exec = async (cmd, args) => {
    const key = `${cmd} ${args
      .filter((a) => !a.startsWith("--"))
      .slice(0, 2)
      .join(" ")}`;
    calls.push(`${cmd} ${args.join(" ")}`);
    if (cmd === "git") {
      if (args[0] === "rev-parse" && args.includes("--verify"))
        return { stdout: "", stderr: "", code: 1 };
      if (args.includes("--git-path"))
        return { stdout: `${wtPath}/.git-exclude\n`, stderr: "", code: 0 };
      if (args.includes("--git-common-dir"))
        return {
          stdout: `${repoPath}/.git\n${repoPath}/.git/worktrees/sf-job_1\n`,
          stderr: "",
          code: 0,
        };
      if (args[0] === "rev-parse") return { stdout: "b".repeat(40), stderr: "", code: 0 };
      if (args.includes("--numstat")) return { stdout: "1\t0\tREADME.md\n", stderr: "", code: 0 };
      if (args[0] === "diff") return { stdout: "+hello\n", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    }
    switch (key) {
      case "orca repo list":
        return ok({ repos: [] });
      case "orca repo add":
        return ok({ repo: { id: "repo1", path: repoPath, displayName: "r" } });
      case "orca worktree create":
        return ok({
          worktree: {
            id: worktreeId,
            repoId: "repo1",
            path: wtPath,
            branch: `refs/heads/${branch}`,
            head: "a".repeat(40),
            comment: "sf-job:job_1",
          },
        });
      case "orca terminal create": {
        // "Runs" the launch script: it records its pid where the harness said.
        const script = /exec \/bin\/sh (\S+)/.exec(args[args.indexOf("--command") + 1] ?? "")?.[1];
        if (!script) return fail("bad_command");
        writeFileSync(join(script, "..", "claude.pid"), "4242\n");
        launched = true;
        return ok({ terminal: { handle: "term_1", paneKey: "p:1", processId: 4242 } });
      }
      case "orca terminal send":
        if (args.includes("\r")) trustAnswered = true;
        return ok({ sent: true });
      case "orca worktree ps": {
        if (removed) return ok({ worktrees: [] });
        if (launched && !trustAnswered) return ok({ worktrees: [] });
        const state = agentStates[Math.min(ps++, agentStates.length - 1)] ?? {};
        return ok({
          worktrees: [
            {
              worktreeId,
              repoId: "repo1",
              path: wtPath,
              comment: "sf-job:job_1",
              agents: [{ paneKey: "p:1", agentType: "claude", hasLivePty: true, ...state }],
            },
          ],
        });
      }
      case "orca terminal read":
        return ok({
          terminal: {
            handle: "term_1",
            status: "running",
            tail: trustAnswered
              ? []
              : ["Quick safety check", "❯ No, exit", "  Yes, I trust this folder"],
            nextCursor: "1",
          },
        });
      case "orca terminal close":
        return ok({ closed: 1 });
      case "orca worktree rm":
        if (removed) return fail("not_found");
        removed = true;
        return ok({ removed: true });
      case "orca project setup-delete":
        return ok({});
      default:
        return fail(`unscripted: ${key}`);
    }
  };
  return { exec, calls };
}

const job: Job = {
  jobId: "job_1",
  runId: "run_1",
  runNo: 1,
  stage: "build",
  workItem: { id: "wi_1", number: 7, title: "Add a line" },
  repo: {
    url: "https://github.com/acme/app.git",
    owner: "acme",
    name: "app",
    baseRef: "factory/7-add-a-line",
  },
  branch: "factory/7-add-a-line-run-1",
  harness: { id: "claude-code", role: "implement", prompt: "add a line" },
  context: {},
  requires: [],
  limits: { sessionTimeoutMs: 10_000 },
  lease: { fencingToken: 1, expiresAt: "2026-11-11T01:00:00Z" },
};

/** A `ps` that shows exactly what the launch record expects (what a correct launch looks like). */
const psAsLaunched = (runsDir: string) => async () =>
  (await readLaunchRecord(join(runsDir, "job_1")))?.argv.join(" ") ?? null;

async function setup(
  states: Array<Partial<OrcaAgentRow>>,
  extra: Partial<OrcaRunnerConfig> = {},
  branch?: string,
  opts: { trustDialog?: boolean } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "sf-unit-"));
  const repoPath = join(root, "repo");
  const wtPath = join(root, "workspaces", "sf-job_1");
  mkdirSync(repoPath, { recursive: true });
  mkdirSync(wtPath, { recursive: true });
  const { exec, calls } = scripted(repoPath, states, wtPath, branch, opts);
  const runsDir = join(root, "runs");
  const runner = createOrcaRunner({
    resolveRepoPath: () => repoPath,
    runsDir,
    exec,
    pollMs: 1,
    readCommand: psAsLaunched(runsDir),
    ...extra,
  });
  return { runner, calls, root, repoPath, wtPath };
}

async function drain(it: AsyncIterable<AdapterEvent>) {
  const out: AdapterEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe("runner-orca adapter", () => {
  it("maps Orca agent states onto contract statuses", () => {
    expect(agentStatus("working")).toBe("working");
    expect(agentStatus("done")).toBe("done");
    expect(agentStatus("waiting-permission")).toBe("waiting_input");
    expect(agentStatus("something-new")).toBe("idle");
  });

  it("runs a job: registers the clone when Orca has no repo, projects the harness, ends on done, cleans up", async () => {
    const { runner, calls, wtPath, root } = await setup([
      { state: "idle" }, // read by capacity()
      { state: "idle" }, // Claude is up (startSession)
      { state: "working", toolName: "Edit", toolInput: "README.md" },
      { state: "done", lastAssistantMessage: "added it", stateStartedAt: Date.now() + 10_000 },
    ]);
    const signal = new AbortController().signal;

    const ws = await runner.prepareWorkspace(job, signal);
    expect(ws.branch).toBe(job.branch);
    expect(calls.some((c) => c.includes("--comment sf-job:job_1"))).toBe(true);
    expect(calls.some((c) => c.includes("--base-branch factory/7-add-a-line"))).toBe(true);
    const settings = JSON.parse(await readFile(join(wtPath, SETTINGS_FILE), "utf8"));
    expect(settings.permissions.deny).toContain("Bash(git push:*)");
    expect(settings.env.GIT_CONFIG_GLOBAL).toBe(join(root, "runs", "job_1", "gitconfig"));
    expect(await readFile(join(wtPath, ".git-exclude"), "utf8")).toContain(
      "/.claude/settings.local.json",
    );
    expect((await runner.capacity()).inUse).toBe(1);

    const session = await runner.startSession(job, ws, signal);
    expect(session.takeover?.hint).toContain("term_1");
    const events = await drain(runner.events(job, session, signal));
    expect(events.map((e) => e.type)).toEqual([
      "agent.status",
      "tool",
      "agent.status",
      "session.ended",
    ]);
    expect(events.at(-1)).toMatchObject({ outcome: "completed", summary: "added it" });

    const artifacts = await runner.collectArtifacts(job, ws, session);
    expect(artifacts.every((a) => a.kind !== "diff")).toBe(true); // the host takes the diff

    await runner.release(job, ws, session);
    // ADR 0260: the repo stays registered; only the job's worktree and branch go.
    expect(calls.some((c) => c.startsWith("orca project setup-delete"))).toBe(false);
    expect(calls.some((c) => c.startsWith("orca worktree rm"))).toBe(true);
    // Safe to call twice: "already gone" is not an error.
    await expect(runner.release(job, ws, session)).resolves.toBeUndefined();
  });

  it("puts attachments outside the worktree, lets the harness read them, and removes them on release", async () => {
    const { runner, wtPath, root } = await setup([{ state: "idle" }]);
    const ws = await runner.prepareWorkspace(job, new AbortController().signal);
    const dir = join(root, "attachments", "job_1");
    expect(ws.attachmentsDir).toBe(dir);
    const settings = JSON.parse(await readFile(join(wtPath, SETTINGS_FILE), "utf8"));
    expect(settings.permissions.additionalDirectories).toEqual([dir]);
    const note = await runner.attachFiles?.(job, ws, [
      {
        meta: {
          id: "att_1",
          filename: "log.txt",
          contentType: "text/plain",
          sizeBytes: 2,
          sha256: "0".repeat(64),
          createdAt: new Date().toISOString(),
        },
        bytes: new TextEncoder().encode("hi"),
      },
    ]);
    const path = join(dir, "att_1", "log.txt");
    expect(await readFile(path, "utf8")).toBe("hi");
    expect(path.startsWith(wtPath)).toBe(false);
    expect(note).toContain(`path: ${path}`);
    expect(note).toContain("<untrusted-data");
    await runner.release(job, ws, undefined);
    await expect(readFile(path, "utf8")).rejects.toThrow();
  });

  it("refuses a workspace whose branch Orca renamed (one branch per run)", async () => {
    const { runner, calls } = await setup([{ state: "idle" }], {}, `${job.branch}-2`);
    await expect(runner.prepareWorkspace(job, new AbortController().signal)).rejects.toThrow(
      /not factory\/7-add-a-line-run-1/,
    );
    expect(calls.some((c) => c.startsWith("orca worktree rm"))).toBe(true);
  });

  it("starts from the host's start point", async () => {
    const { runner, calls } = await setup([{ state: "idle" }], {
      startPoint: () => "0123456789abcdef0123456789abcdef01234567",
    });
    await runner.prepareWorkspace(job, new AbortController().signal);
    expect(
      calls.some((c) => c.includes("--base-branch 0123456789abcdef0123456789abcdef01234567")),
    ).toBe(true);
  });

  it("ignores a stale `done` from before the prompt landed", async () => {
    const { runner } = await setup([
      { state: "idle" },
      { state: "done", stateStartedAt: 0, lastAssistantMessage: "old" },
      { state: "working" },
      { state: "done", lastAssistantMessage: "new" },
    ]);
    const signal = new AbortController().signal;
    const ws = await runner.prepareWorkspace(job, signal);
    const session = await runner.startSession(job, ws, signal);
    const events = await drain(runner.events(job, session, signal));
    expect(events.at(-1)).toMatchObject({ type: "session.ended", summary: "new" });
  });

  it("completes once the result file exists and the agent has gone quiet", async () => {
    const { runner, wtPath } = await setup([
      { state: "idle" },
      { state: "working" },
      { state: "idle" },
    ]);
    const signal = new AbortController().signal;
    const ws = await runner.prepareWorkspace(job, signal);
    const session = await runner.startSession(job, ws, signal);
    await writeFile(join(wtPath, ".factory-result.json"), "{}");
    const events = await drain(runner.events(job, session, signal));
    expect(events.at(-1)).toMatchObject({ type: "session.ended", outcome: "completed" });
  });

  it("fails a session stuck waiting for input", async () => {
    const { runner } = await setup([{ state: "waiting-permission" }], {
      waitingInputTimeoutMs: 5,
      pollMs: 3,
    });
    const signal = new AbortController().signal;
    const ws = await runner.prepareWorkspace(job, signal);
    const session = await runner.startSession(job, ws, signal);
    const events = await drain(runner.events(job, session, signal));
    expect(events.at(-1)).toMatchObject({ type: "session.ended", outcome: "failed" });
  });

  it("keeps a planning session (spec 20) in its session's worktree, waiting through idle and done until the host stops it", async () => {
    const { runner, calls } = await setup(
      [{ state: "idle" }, { state: "working" }, { state: "done", lastAssistantMessage: "drafted" }],
      { pollMs: 3 },
    );
    const planningJob: Job = {
      ...job,
      stage: "planning",
      planning: {
        sessionId: "ps_0123456789abcdef0123456789abcdef",
        sessionRef: "6f2c3a9e-1b2d-4c5e-8f90-123456789abc",
        resume: true,
      },
    };
    const controller = new AbortController();
    await expect(runner.prepareWorkspace(planningJob, controller.signal)).rejects.toThrow(/relay/);
    const ws = await runner.prepareWorkspace(planningJob, controller.signal, {
      planningRelay: { url: "http://127.0.0.1:1", token: "t" },
    });
    // The same path for every job of the session, so `claude --resume` finds the conversation.
    expect(calls.some((c) => c.includes("--name sf-plan-ps-0123456789abcdef"))).toBe(true);
    expect(ws.launch.argv).toContain("--resume");
    const session = await runner.startSession(planningJob, ws, controller.signal);
    setTimeout(() => controller.abort(new Error("the planning session yielded its slot")), 60);
    const events = await drain(runner.events(planningJob, session, controller.signal));
    expect(events.filter((e) => e.type === "session.ended")).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: "session.ended", outcome: "cancelled" });
  });

  it("ends as timed_out when the host aborts for a timeout", async () => {
    const { runner } = await setup([{ state: "working" }], { pollMs: 5 });
    const controller = new AbortController();
    const ws = await runner.prepareWorkspace(job, controller.signal);
    const session = await runner.startSession(job, ws, controller.signal);
    setTimeout(() => controller.abort(new Error("session timeout")), 30);
    const events = await drain(runner.events(job, session, controller.signal));
    expect(events.at(-1)).toMatchObject({ type: "session.ended", outcome: "timed_out" });
  });

  it("launches the harness's own command in an Orca terminal, checks it, then sends the prompt", async () => {
    const { runner, calls, wtPath, root } = await setup([{ state: "idle" }]);
    const signal = new AbortController().signal;
    const ws = await runner.prepareWorkspace(job, signal);
    const session = await runner.startSession(job, ws, signal);
    expect(session.handle).toBe("term_1");
    expect(calls.some((c) => c.startsWith("orca agent launch"))).toBe(false);
    const runDir = join(root, "runs", "job_1");
    expect(calls).toContainEqual(
      expect.stringContaining(`--command exec /bin/sh ${runDir}/launch.sh`),
    );

    // The harness's exact invocation: no user settings, the factory's mode for the stage.
    const record = await readLaunchRecord(runDir);
    expect(record?.argv).toEqual([
      "claude",
      "--permission-mode",
      "bypassPermissions",
      "--setting-sources",
      "project,local",
      "--settings",
      `${runDir}/claude-settings.json`,
      "--strict-mcp-config",
    ]);
    const script = await readFile(join(runDir, "launch.sh"), "utf8");
    expect(script).toContain(`exec ${record?.argv.join(" ")}`);

    // Orca's status hooks come with the factory's settings, never its permission-deciding ones.
    const settings = JSON.parse(await readFile(join(wtPath, SETTINGS_FILE), "utf8"));
    expect(Object.keys(settings.hooks)).toContain("Stop");
    expect(settings.hooks.PreToolUse).toBeUndefined();
    expect(settings.hooks.PermissionRequest).toBeUndefined();
    expect(settings.sandbox.allowUnsandboxedCommands).toBe(false);
    expect(settings.sandbox.filesystem.allowWrite).toContain(`${root}/repo/.git/objects`);

    // The prompt goes in only after the check, as a submitted turn.
    const prompt = calls.findIndex((c) => c.includes("--text add a line --enter"));
    const create = calls.findIndex((c) => c.startsWith("orca terminal create"));
    expect(prompt).toBeGreaterThan(create);
  });

  it("answers Claude's folder trust dialog for the job's worktree once", async () => {
    const { runner, calls } = await setup([{ state: "idle" }], {}, undefined, {
      trustDialog: true,
    });
    const signal = new AbortController().signal;
    const ws = await runner.prepareWorkspace(job, signal);
    await runner.startSession(job, ws, signal);
    const keys = calls.filter((c) => c.startsWith("orca terminal send") && !c.includes("--enter"));
    expect(keys).toEqual([
      "orca terminal send --terminal term_1 --text \u001b[B --json",
      "orca terminal send --terminal term_1 --text \r --json",
    ]);
  });

  it("kills the session and fails with harness-config-mismatch when the launcher changed the flags", async () => {
    // Incident 2026-11-11 #6: the launcher added the owner's own `--permission-mode auto`.
    const { runner, calls, root } = await setup([{ state: "idle" }], {
      readCommand: async () => "claude --permission-mode auto",
    });
    const signal = new AbortController().signal;
    const ws = await runner.prepareWorkspace(job, signal);
    await expect(runner.startSession(job, ws, signal)).rejects.toThrow(
      /^harness-config-mismatch: .*permission mode auto, expected bypassPermissions/,
    );
    expect(calls).toContain("orca terminal close --terminal term_1 --json");
    expect(calls.some((c) => c.includes("--enter"))).toBe(false); // no prompt, no work

    // The same check, for `sf-runner doctor` on a running job.
    const runDir = join(root, "runs", "job_1");
    const ok = await checkRunningHarness(runDir, psAsLaunched(join(root, "runs")));
    expect(ok?.problems).toEqual([]);
    await writeFile(join(ws.path, SETTINGS_FILE), "{}");
    const tampered = await checkRunningHarness(runDir, psAsLaunched(join(root, "runs")));
    expect(tampered?.problems).toEqual([
      `${join(ws.path, SETTINGS_FILE)} changed since it was projected`,
    ]);
  });

  it("runs verify in dontAsk", async () => {
    const { runner, root } = await setup([{ state: "idle" }]);
    await runner.prepareWorkspace({ ...job, stage: "verify" }, new AbortController().signal);
    const record = await readLaunchRecord(join(root, "runs", "job_1"));
    expect(record?.argv.slice(1, 3)).toEqual(["--permission-mode", "dontAsk"]);
  });
});
