import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHECK_FAILURE_MAX,
  checkFailureMessage,
  type ExecutedCheck,
  RESULT_FILE,
} from "@software-factory/runner-contract";
import { afterEach, describe, expect, it } from "vitest";
import { checkEnv, checkLoop, type Exec, localExec, runChecks } from "../src/checks.ts";
import { runJob } from "../src/job.ts";
import { controlPlane, fakeAdapter, fakeCloud, git, job, scratchRepo } from "./helpers.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});
const SHA = "b".repeat(40);
const never = new AbortController().signal;

describe("the host's checks (ADR 0501)", () => {
  it("runs a command locally in the worktree, with its exit code and output, and a timeout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sf-checks-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    await writeFile(join(dir, "marker"), "x");
    const exec = localExec(dir);
    expect(await exec({ run: "ls marker && echo done", timeoutMs: 5_000 }, never)).toMatchObject({
      exitCode: 0,
      timedOut: false,
      output: expect.stringContaining("done"),
    });
    expect(await exec({ run: "echo boom >&2; exit 3", timeoutMs: 5_000 }, never)).toMatchObject({
      exitCode: 3,
      output: expect.stringContaining("boom"),
    });
    expect(await exec({ run: "sleep 5", timeoutMs: 200 }, never)).toMatchObject({
      exitCode: null,
      timedOut: true,
    });
  });

  it("gives a local check the toolchain but none of the owner's tokens", () => {
    const env = checkEnv({
      PATH: "/usr/bin",
      HOME: "/Users/o",
      GITHUB_TOKEN: "ghp_x",
      CLOUDFLARE_API_TOKEN: "cf",
      AWS_SECRET_ACCESS_KEY: "aws",
      ANTHROPIC_API_KEY: "sk",
    });
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/Users/o" });
  });

  it("records each check on the SHA it ran on, and an exec that throws as a failure", async () => {
    const exec: Exec = async (c) => {
      if (c.run === "boom") throw new Error("no container");
      return { exitCode: c.run === "ok" ? 0 : 1, timedOut: false, output: `ran ${c.run}` };
    };
    const ran = await runChecks(
      [
        { name: "lint", run: "ok", timeoutMs: 1_000 },
        { name: "tests", run: "boom", timeoutMs: 1_000 },
      ],
      exec,
      SHA,
      0,
      never,
    );
    expect(ran).toMatchObject([
      { name: "lint", exitCode: 0, headSha: SHA, logTail: "ran ok" },
      { name: "tests", exitCode: null, logTail: expect.stringContaining("no container") },
    ]);
  });

  it("sends a failure back into the session and checks its fix, up to the rounds allowed", async () => {
    let fixed = false;
    let head = 0;
    const sent: string[] = [];
    const out = await checkLoop({
      checks: { commands: [{ name: "tests", run: "pnpm test", timeoutMs: 1_000 }], fixRounds: 2 },
      exec: async () => ({ exitCode: fixed ? 0 : 1, timedOut: false, output: "1 failing" }),
      commit: async () => String(++head).padStart(40, "0"),
      continueSession: async (text) => {
        sent.push(text);
        fixed = true;
        return "completed";
      },
      signal: never,
    });
    expect(out.rounds).toBe(1);
    expect(out.final).toMatchObject([{ exitCode: 0, round: 1 }]);
    expect(out.results.map((r) => [r.round, r.exitCode, r.headSha.slice(-1)])).toEqual([
      [0, 1, "1"],
      [1, 0, "2"],
    ]);
    expect(sent[0]).toMatch(/Check "tests" failed: `pnpm test` exited with 1 .* «1 failing»/);
  });

  it("stops after the last round, or at once when the session can't be continued", async () => {
    const failing = async () => ({ exitCode: 2, timedOut: false, output: "no" });
    const commit = async () => SHA;
    const checks = { commands: [{ name: "tests", run: "t", timeoutMs: 1_000 }], fixRounds: 1 };
    let turns = 0;
    const limited = await checkLoop({
      checks,
      exec: failing,
      commit,
      continueSession: async () => {
        turns++;
        return "completed";
      },
      signal: never,
    });
    expect([limited.rounds, turns]).toEqual([1, 1]);
    expect(limited.notes.at(-1)).toMatch(/a person decides/);
    const noSteer = await checkLoop({ checks, exec: failing, commit, signal: never });
    expect(noSteer.rounds).toBe(0);
    expect(noSteer.notes.at(-1)).toMatch(/can't be continued/);
  });

  it("keeps the failure message within one steer", () => {
    const long: ExecutedCheck = {
      name: "tests",
      command: "pnpm test",
      exitCode: 1,
      timedOut: false,
      durationMs: 3_000,
      logTail: "x".repeat(8_000),
      headSha: SHA,
      round: 0,
    };
    const text = checkFailureMessage([long, { ...long, name: "lint" }], 1);
    expect(text.length).toBeLessThanOrEqual(CHECK_FAILURE_MAX);
    expect(text).toContain('Check "lint" failed');
  });
});

describe("runJob with checks (ADR 0501)", () => {
  it("runs the checks on the build's commit, types a failure into the same session, and hands back the results", async () => {
    const repo = await scratchRepo();
    cleanups.push(repo.cleanup);
    const cloud = fakeCloud();
    const cp = await controlPlane(cloud);
    const j = job({
      checks: {
        commands: [{ name: "fixed", run: "test -f fixed.txt", timeoutMs: 5_000 }],
        fixRounds: 2,
      },
    });
    cloud.claims.set("c", j);
    let turn = 0;
    const adapter = fakeAdapter(
      (x) => repo.host.clonePath(x),
      async (wt) => {
        turn++;
        if (turn === 1) {
          await writeFile(join(wt, "README.md"), "# scratch\nfirst\n");
          await writeFile(join(wt, RESULT_FILE), JSON.stringify({ notes: "first" }));
        } else {
          await writeFile(join(wt, "fixed.txt"), "fixed\n"); // left uncommitted: the host commits it
        }
        return [{ type: "session.ended" as const, outcome: "completed" as const }];
      },
      { steer: true },
    );
    const report = await runJob({
      adapter,
      cp,
      git: repo.host,
      job: j,
      fetch: async () => new Response(null, { status: 204 }),
      flushMs: 5,
    });
    expect(report.outcome, `${report.error} ${report.summary}`).toBe("completed");
    expect(adapter.steered).toHaveLength(1);
    expect(adapter.steered[0]).toMatch(/`test -f fixed.txt` exited with 1/);
    const handback = cloud.handbacks.get(j.jobId) as { headSha: string; checks: ExecutedCheck[] };
    expect(handback.checks.map((c) => [c.round, c.exitCode])).toEqual([
      [0, 1],
      [1, 0],
    ]);
    expect(handback.checks[1]?.headSha).toBe(handback.headSha);
    expect(git(repo.bare, "ls-tree", "-r", "--name-only", j.branch)).toContain("fixed.txt");
  });
});
