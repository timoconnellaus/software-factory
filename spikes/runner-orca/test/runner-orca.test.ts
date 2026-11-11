import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AdapterEvent, Job } from "../src/contract/types.ts";
import type { Exec } from "../src/host/exec.ts";
import { agentStatus, createOrcaRunner } from "../src/runner-orca/adapter.ts";
import type { OrcaAgentRow } from "../src/runner-orca/orca-cli.ts";

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
function scripted(repoPath: string, agentStates: Array<Partial<OrcaAgentRow>>) {
  const calls: string[] = [];
  let ps = 0;
  let removed = false;
  const worktreeId = `repo1::/orca/workspaces/r/sf-job_1`;
  const exec: Exec = async (cmd, args) => {
    const key = `${cmd} ${args
      .filter((a) => !a.startsWith("--"))
      .slice(0, 2)
      .join(" ")}`;
    calls.push(`${cmd} ${args.join(" ")}`);
    if (cmd === "git") {
      if (args[0] === "rev-parse" && args.includes("--verify"))
        return { stdout: "", stderr: "", code: 1 };
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
            path: "/orca/workspaces/r/sf-job_1",
            branch: "refs/heads/sf/wi_1-2",
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
              path: "/orca/workspaces/r/sf-job_1",
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
  workItemId: "wi_1",
  attempt: 1,
  stage: "implement",
  repo: { url: "https://github.com/acme/app.git", baseRef: "main" },
  branch: "sf/wi_1",
  harness: { id: "claude-code", prompt: "add a line" },
  requires: [],
  output: "diff",
  limits: { sessionTimeoutMs: 10_000 },
  lease: { leaseId: "l", expiresAt: "2026-11-11T01:00:00Z" },
};

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

  it("runs a job: registers the repo, reports the branch Orca really made, ends on done", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "sf-unit-"));
    const { exec, calls } = scripted(repoPath, [
      { state: "idle" }, // read by capacity()
      { state: "working", toolName: "Edit", toolInput: "README.md" },
      { state: "done", lastAssistantMessage: "added it", stateStartedAt: Date.now() + 10_000 },
    ]);
    const runner = createOrcaRunner({ resolveRepoPath: () => repoPath, exec, pollMs: 1 });
    const signal = new AbortController().signal;

    const ws = await runner.prepareWorkspace(job, signal);
    expect(ws.branch).toBe("sf/wi_1-2"); // Orca suffixed a taken name
    expect(calls.some((c) => c.includes("--comment sf-job:job_1"))).toBe(true);
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
    expect(artifacts[0]).toMatchObject({ kind: "diff", stats: { files: 1, insertions: 1 } });

    await runner.release(job, ws, session);
    expect(calls.some((c) => c.startsWith("orca project setup-delete --setup repo1"))).toBe(true);
    // Safe to call twice: "already gone" is not an error.
    await expect(runner.release(job, ws, session)).resolves.toBeUndefined();
  });

  it("ignores a stale `done` from before the prompt landed", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "sf-unit-"));
    const { exec } = scripted(repoPath, [
      { state: "done", stateStartedAt: 0, lastAssistantMessage: "old" },
      { state: "working" },
      { state: "done", lastAssistantMessage: "new" },
    ]);
    const runner = createOrcaRunner({ resolveRepoPath: () => repoPath, exec, pollMs: 1 });
    const signal = new AbortController().signal;
    const ws = await runner.prepareWorkspace(job, signal);
    const session = await runner.startSession(job, ws, signal);
    const events = await drain(runner.events(job, session, signal));
    expect(events.at(-1)).toMatchObject({ type: "session.ended", summary: "new" });
  });

  it("ends as timed_out when the host aborts for a timeout", async () => {
    const repoPath = await mkdtemp(join(tmpdir(), "sf-unit-"));
    const { exec } = scripted(repoPath, [{ state: "working" }]);
    const runner = createOrcaRunner({ resolveRepoPath: () => repoPath, exec, pollMs: 5 });
    const controller = new AbortController();
    const ws = await runner.prepareWorkspace(job, controller.signal);
    const session = await runner.startSession(job, ws, controller.signal);
    setTimeout(() => controller.abort(new Error("session timeout")), 30);
    const events = await drain(runner.events(job, session, controller.signal));
    expect(events.at(-1)).toMatchObject({ type: "session.ended", outcome: "timed_out" });
  });
});
