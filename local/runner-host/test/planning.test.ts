// Spec 20 on the runner: a planning job's harness reaches its planning operations only through the
// host's relay (ADR 0350), its hooks bring news while it works (criterion 2), and a yield ends the
// session and hands back without a push.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  callRelay,
  handleMcp,
  PLANNING_CLI,
  type RelayInfo,
  runNewsHook,
  runStopHook,
} from "@software-factory/harness-claude";
import type { PlanningNewsEvent, PlanningRelay } from "@software-factory/runner-contract";
import { afterEach, describe, expect, it } from "vitest";
import { RunnerHost } from "../src/host.ts";
import { runJob } from "../src/job.ts";
import { controlPlane, fakeAdapter, fakeCloud, git, job, scratchRepo } from "./helpers.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const SESSION = {
  sessionId: "ps_0123456789abcdef0123456789abcdef",
  sessionRef: "6f2c3a9e-1b2d-4c5e-8f90-123456789abc",
  resume: false,
};
const planningJob = () =>
  job({
    stage: "planning",
    harness: { id: "claude-code", role: "triage", prompt: "Plan it" },
    planning: SESSION,
  });

const answer: PlanningNewsEvent = {
  type: "answer.submitted",
  cursor: 12,
  at: new Date().toISOString(),
  questionId: "q_1",
  number: 1,
  prompt: "Which time zone?",
  answer: "UTC",
  revision: 1,
  skipped: false,
  note: null,
  acceptedDefault: false,
  by: "Tim",
};
const news = (events: PlanningNewsEvent[], extra: Record<string, unknown> = {}) => ({
  workItemId: "wi_1",
  cursor: 12,
  events,
  openQuestions: 0,
  present: ["Tim"],
  yield: false,
  ended: false,
  ...extra,
});

async function relayFileFor(relay: PlanningRelay, jobId: string) {
  const dir = await mkdtemp(join(tmpdir(), "sf-plan-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const info: RelayInfo = { ...relay, jobId, workItemNumber: 7 };
  const file = join(dir, "planning.json");
  await writeFile(file, JSON.stringify(info));
  return { file, info };
}

/** Runs the projected hook command as Claude Code would: payload on stdin, JSON on stdout. */
function runHookProcess(event: string, relayFile: string, payload: unknown) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(
      process.execPath,
      ["--experimental-transform-types", "--no-warnings", PLANNING_CLI, "hook", event, relayFile],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

describe("a planning job on the runner host (spec 20)", () => {
  it("relays the agent's tools and hooks with the job's fencing token, brings an answer in through PostToolUse, and hands back on a yield", async () => {
    const repo = await scratchRepo();
    cleanups.push(repo.cleanup);
    const cloud = fakeCloud();
    const cp = await controlPlane(cloud);
    let waits = 0;
    cloud.planning = ({ op }) => {
      if (op === "question.ask") return { questionIds: ["q_1"], numbers: [1], round: 0 };
      if (op === "planning.news") return news([answer]);
      if (op === "planning.wait") {
        waits++;
        return { ...news([]), due: false, recheckAt: null, yield: waits >= 2 };
      }
      if (op === "planning.yield") return { yielded: true };
      return {};
    };
    const j = planningJob();
    cloud.claims.set("c", j);
    const seen: { tool?: unknown; context?: string; throttled?: unknown; process?: string } = {};
    const adapter = fakeAdapter(
      (x) => repo.host.clonePath(x),
      async (_wt, jj, signal, relay) => {
        if (!relay) throw new Error("no relay for a planning job");
        const { file, info } = await relayFileFor(relay, jj.jobId);
        // The agent adds a question through its MCP server.
        seen.tool = await handleMcp(
          {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "question_ask",
              arguments: { questions: [{ prompt: "Which time zone?", default: "UTC" }] },
            },
          },
          relay,
        );
        // Mid-work, PostToolUse brings the answer in (a real hook process, as Claude runs it).
        const hook = await runHookProcess("post-tool-use", file, { tool_name: "Read" });
        seen.process = hook.stdout;
        // A second tool call within 15 s is throttled.
        seen.throttled = (
          await runNewsHook(
            "PostToolUse",
            { tool_name: "Grep" },
            {
              relayFile: file,
              relay: info,
            },
          )
        ).response;
        // The agent ends its turn: the Stop hook waits; the factory asks it to yield.
        const woke = await runStopHook({ relayFile: file, relay: info, retryMs: 10 });
        seen.context = woke.response ?? "(let it stop)";
        // The host ends the harness once the yield went through.
        if (!signal.aborted) {
          await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        }
        return [{ type: "session.ended", outcome: "cancelled" }];
      },
    );
    const report = await runJob({ adapter, cp, git: repo.host, job: j, flushMs: 5 });

    expect(report.outcome).toBe("completed");
    expect(report.handedBack).toBe(true);
    expect(cloud.handbacks.get(j.jobId)?.result).toEqual({ planning: "yielded" });
    // Nothing pushed, no diff taken.
    expect(() => git(repo.bare, "rev-parse", "--verify", j.branch)).toThrow();
    expect([...cloud.artifacts.values()].some((a) => a.kind === "diff")).toBe(false);
    expect(adapter.calls).toContain("release");

    // Every planning call carried the job and its fencing token, in this order.
    expect(cloud.planningCalls.map((c) => c.op)).toEqual([
      "question.ask",
      "planning.news",
      "planning.wait",
      "planning.wait",
      "planning.yield",
    ]);
    expect(cloud.planningCalls.every((c) => c.jobId === j.jobId)).toBe(true);
    // The hook holds what it fetches until it has shown it (spec 26)…
    expect(cloud.planningCalls[1]?.input).toEqual({ hold: true, activity: "reading the repo" });
    // …and the next call acknowledges the cursor it showed.
    expect(cloud.planningCalls[2]?.input).toMatchObject({ hold: true, ack: 12 });
    expect(JSON.stringify(seen.tool)).toContain("questionIds");
    const out = JSON.parse(seen.process ?? "{}") as {
      hookSpecificOutput?: { hookEventName: string; additionalContext: string };
    };
    expect(out.hookSpecificOutput?.hookEventName).toBe("PostToolUse");
    expect(out.hookSpecificOutput?.additionalContext).toContain('"answer":"UTC"');
    expect(out.hookSpecificOutput?.additionalContext).toContain("work item #7");
    expect(seen.throttled).toEqual({});
    expect(seen.context).toBe("(let it stop)");
  }, 30_000);

  it("wakes an idle agent from its Stop hook with the news once a wait is due", async () => {
    const cloud = fakeCloud();
    const cp = await controlPlane(cloud);
    const j = planningJob();
    cloud.claims.set("c", j);
    cloud.planning = ({ op }) =>
      op === "planning.wait"
        ? {
            ...news([{ ...answer, type: "answer.revised", answer: "Europe/London" }]),
            due: true,
            recheckAt: null,
          }
        : {};
    const { startPlanningRelay } = await import("../src/planning-relay.ts");
    const relay = await startPlanningRelay(j, cp, { onYield: () => {}, onStop: () => {} });
    cleanups.push(relay.close);
    const { file } = await relayFileFor(relay, j.jobId);
    // The Stop hook process exits 2 with the news on stderr: Claude's asyncRewake wakes the model.
    const stop = await runHookProcess("stop", file, { session_id: "s" });
    expect(stop.code).toBe(2);
    expect(stop.stderr).toContain("arrived while you were waiting");
    expect(stop.stderr).toContain("Europe/London");
    // The relay refuses anyone without the job's secret.
    await expect(
      callRelay({ url: relay.url, token: "wrong" }, "planning.news"),
    ).rejects.toMatchObject({ status: 401 });
    // A fenced session lets the agent stop instead of waking it.
    cloud.fenced.add(j.jobId);
    const fenced = await runHookProcess("stop", file, {});
    expect(fenced.code).toBe(0);
  }, 30_000);

  it("serves the planning MCP server over stdio: every tool but the wait, with its schema", async () => {
    const cloud = fakeCloud();
    const cp = await controlPlane(cloud);
    const j = planningJob();
    cloud.claims.set("c", j);
    cloud.planning = () => ({ specId: "spec_1", version: 2 });
    const { startPlanningRelay } = await import("../src/planning-relay.ts");
    const relay = await startPlanningRelay(j, cp, { onYield: () => {}, onStop: () => {} });
    cleanups.push(relay.close);
    const { file } = await relayFileFor(relay, j.jobId);
    const child = spawn(
      process.execPath,
      ["--experimental-transform-types", "--no-warnings", PLANNING_CLI, "mcp", file],
      { stdio: ["pipe", "pipe", "inherit"] },
    );
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`);
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "spec_revise",
        arguments: { specMd: "## Goal\nx [request]", acceptanceCriteria: ["x"] },
      },
    });
    for (let i = 0; i < 100 && out.split("\n").filter(Boolean).length < 3; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    child.stdin.end();
    const replies = out
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { id: number; result: Record<string, unknown> });
    const list = replies.find((r) => r.id === 2)?.result.tools as { name: string }[];
    expect(list.map((t) => t.name).sort()).toEqual([
      "chat_reply",
      "planning_news",
      "planning_ready",
      "planning_yield",
      "question_answerFromEdit",
      "question_ask",
      "question_delete",
      "question_focus",
      "question_reorder",
      "question_update",
      "spec_revise",
    ]);
    expect(JSON.stringify(replies.find((r) => r.id === 3)?.result)).toContain("spec_1");
    expect(cloud.planningCalls).toEqual([
      expect.objectContaining({ op: "spec.revise", jobId: j.jobId }),
    ]);
  }, 30_000);

  it("reports both pools in its heartbeat (ADR 0301)", async () => {
    const repo = await scratchRepo();
    cleanups.push(repo.cleanup);
    const cloud = fakeCloud();
    const cp = await controlPlane(cloud);
    const adapter = fakeAdapter(
      (x) => repo.host.clonePath(x),
      async () => [],
    );
    const host = new RunnerHost({
      adapter,
      cp,
      git: repo.host,
      maxConcurrent: 2,
      maxLight: 6,
      heartbeatMs: 60_000,
      log: () => {},
    });
    await host.start();
    await host.stop();
    expect(cloud.heartbeats[0]?.capacity).toEqual({
      max: 2,
      inUse: 0,
      accepting: true,
      light: { max: 6, inUse: 0 },
    });
    // The relay file never reached the workspace.
    expect(await readFile(join(repo.root, "planning.json"), "utf8").catch(() => null)).toBeNull();
  });
});
