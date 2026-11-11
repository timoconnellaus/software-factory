// runner-local (sketch): the same contract with no Orca at all. A job becomes a plain
// `git worktree`, Claude Code runs headless (`claude -p --output-format stream-json`), events are
// the parsed stream-json lines, and the diff comes from the same host/git.ts helper. It declares
// only `headless` and `own-hardware`: no takeover UI, no browser, no session auto-registration.

import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  type AdapterEvent,
  type Artifact,
  type CapabilityManifest,
  type Capacity,
  CONTRACT_VERSION,
  type RunnerAdapter,
  type SessionHandle,
  type WorkspaceHandle,
} from "../contract/types.ts";
import { type Exec, nodeExec, run } from "../host/exec.ts";
import { collectDiff, deleteBranch, headSha } from "../host/git.ts";

export interface LocalWorkspace extends WorkspaceHandle {
  repoPath: string;
}

export interface LocalSession extends SessionHandle {
  child: ChildProcess;
  stderr: string[];
}

export interface LocalRunnerConfig {
  resolveRepoPath: (repoUrl: string) => Promise<string> | string;
  /** Where job worktrees go, e.g. ~/.software-factory/worktrees. */
  worktreeRoot: string;
  maxConcurrent?: number;
  claudeBin?: string;
  /** Claude Code permission mode for unattended runs. */
  permissionMode?: "acceptEdits" | "bypassPermissions" | "auto";
  exec?: Exec;
}

/** One stream-json line from `claude -p --output-format stream-json --verbose` → contract events. */
export function streamJsonToEvents(line: string): AdapterEvent[] {
  let msg: {
    type?: string;
    subtype?: string;
    result?: string;
    is_error?: boolean;
    message?: { content?: Array<{ type: string; text?: string; name?: string; input?: unknown }> };
  };
  try {
    msg = JSON.parse(line);
  } catch {
    return [{ type: "log", stream: "stdout", text: line }];
  }
  if (msg.type === "system" && msg.subtype === "init")
    return [{ type: "agent.status", status: "working" }];
  if (msg.type === "assistant") {
    return (msg.message?.content ?? []).flatMap((part): AdapterEvent[] => {
      if (part.type === "tool_use") {
        return [{ type: "tool", name: part.name ?? "", input: JSON.stringify(part.input ?? {}) }];
      }
      if (part.type === "text" && part.text)
        return [{ type: "log", stream: "stdout", text: part.text }];
      return [];
    });
  }
  if (msg.type === "result") {
    const ok = msg.subtype === "success" && !msg.is_error;
    return [
      { type: "agent.status", status: ok ? "done" : "error" },
      {
        type: "session.ended",
        outcome: ok ? "completed" : "failed",
        ...(msg.result ? { summary: msg.result } : {}),
      },
    ];
  }
  return [];
}

export function createLocalRunner(
  config: LocalRunnerConfig,
): RunnerAdapter<LocalWorkspace, LocalSession> {
  const exec = config.exec ?? nodeExec;
  const active = new Set<string>();

  return {
    async manifest(): Promise<CapabilityManifest> {
      return {
        contractVersion: CONTRACT_VERSION,
        runnerKind: "local",
        harnesses: ["claude-code"],
        capabilities: ["headless", "own-hardware"],
      };
    },

    async capacity(): Promise<Capacity> {
      return { max: config.maxConcurrent ?? 2, inUse: active.size, accepting: true };
    },

    async prepareWorkspace(job): Promise<LocalWorkspace> {
      const repoPath = await realpath(await config.resolveRepoPath(job.repo.url));
      await mkdir(config.worktreeRoot, { recursive: true });
      const path = join(config.worktreeRoot, job.jobId);
      await run(exec, "git", ["worktree", "add", "-b", job.branch, path, job.repo.baseRef], {
        cwd: repoPath,
      });
      active.add(job.jobId);
      return {
        jobId: job.jobId,
        path,
        branch: job.branch,
        baseSha: await headSha(exec, path),
        repoPath,
      };
    },

    async startSession(job, workspace, signal): Promise<LocalSession> {
      const args = [
        "-p",
        job.harness.prompt,
        "--output-format",
        "stream-json",
        "--verbose",
        "--permission-mode",
        config.permissionMode ?? "acceptEdits",
        ...(job.harness.model ? ["--model", job.harness.model] : []),
      ];
      const child = spawn(config.claudeBin ?? "claude", args, {
        cwd: workspace.path,
        signal,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stderr: string[] = [];
      child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
      return { jobId: job.jobId, sessionRef: `pid:${child.pid ?? "?"}`, child, stderr };
    },

    async *events(_job, session, signal): AsyncIterable<AdapterEvent> {
      const stdout = session.child.stdout;
      if (!stdout) throw new Error("claude has no stdout");
      let ended = false;
      for await (const line of createInterface({ input: stdout })) {
        for (const event of streamJsonToEvents(line)) {
          if (event.type === "session.ended") ended = true;
          yield event;
        }
      }
      if (!ended) {
        const reason = String(signal.reason ?? "");
        yield {
          type: "session.ended",
          outcome: signal.aborted
            ? reason.includes("timeout")
              ? "timed_out"
              : "cancelled"
            : "failed",
          summary: session.stderr.join("").slice(-2000) || "claude exited without a result",
        };
      }
    },

    async collectArtifacts(_job, workspace, session): Promise<Artifact[]> {
      const artifacts: Artifact[] = [
        await collectDiff(exec, workspace.path, workspace.baseSha, workspace.branch),
      ];
      if (session?.stderr.length) {
        artifacts.push({ kind: "log", name: "claude-stderr", text: session.stderr.join("") });
      }
      return artifacts;
    },

    async release(job, workspace, session): Promise<void> {
      if (session && session.child.exitCode === null) session.child.kill("SIGTERM");
      if (workspace) {
        await exec("git", ["worktree", "remove", "--force", workspace.path], {
          cwd: workspace.repoPath,
        });
        await deleteBranch(exec, workspace.repoPath, workspace.branch);
      }
      active.delete(job.jobId);
    },
  };
}
