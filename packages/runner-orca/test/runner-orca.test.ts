import { mkdirSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SETTINGS_FILE } from "@software-factory/harness-claude";
import type { AdapterEvent, Job } from "@software-factory/runner-contract";
import { describe, expect, it } from "vitest";
import { agentStatus, createOrcaRunner, type OrcaRunnerConfig } from "../src/adapter.ts";
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
) {
  const calls: string[] = [];
  let ps = 0;
  let removed = false;
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
      case "orca agent launch":
        return ok({ launch: { outcome: { kind: "terminal", handle: "term_1", paneKey: "p:1" } } });
      case "orca worktree ps": {
        if (removed) return ok({ worktrees: [] });
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
        return ok({ terminal: { handle: "term_1", status: "running", tail: [], nextCursor: "1" } });
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

async function setup(
  states: Array<Partial<OrcaAgentRow>>,
  extra: Partial<OrcaRunnerConfig> = {},
  branch?: string,
) {
  const root = await mkdtemp(join(tmpdir(), "sf-unit-"));
  const repoPath = join(root, "repo");
  const wtPath = join(root, "workspaces", "sf-job_1");
  mkdirSync(repoPath, { recursive: true });
  mkdirSync(wtPath, { recursive: true });
  const { exec, calls } = scripted(repoPath, states, wtPath, branch);
  const runner = createOrcaRunner({
    resolveRepoPath: () => repoPath,
    runsDir: join(root, "runs"),
    exec,
    pollMs: 1,
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

  it("runs a job: registers the repo, projects the harness, ends on done, cleans up", async () => {
    const { runner, calls, wtPath, root } = await setup([
      { state: "idle" }, // read by capacity()
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
    expect(calls.some((c) => c.startsWith("orca project setup-delete --setup repo1"))).toBe(true);
    // Safe to call twice: "already gone" is not an error.
    await expect(runner.release(job, ws, session)).resolves.toBeUndefined();
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
    const { runner, wtPath } = await setup([{ state: "working" }, { state: "idle" }]);
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

  it("ends as timed_out when the host aborts for a timeout", async () => {
    const { runner } = await setup([{ state: "working" }], { pollMs: 5 });
    const controller = new AbortController();
    const ws = await runner.prepareWorkspace(job, controller.signal);
    const session = await runner.startSession(job, ws, controller.signal);
    setTimeout(() => controller.abort(new Error("session timeout")), 30);
    const events = await drain(runner.events(job, session, controller.signal));
    expect(events.at(-1)).toMatchObject({ type: "session.ended", outcome: "timed_out" });
  });
});
