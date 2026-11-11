import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { RESULT_FILE } from "@software-factory/runner-contract";
import { afterEach, describe, expect, it } from "vitest";
import { assertPushable } from "../src/git.ts";
import { RunnerHost } from "../src/host.ts";
import { runJob } from "../src/job.ts";
import { controlPlane, fakeAdapter, fakeCloud, git, job, scratchRepo } from "./helpers.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function world() {
  const repo = await scratchRepo();
  cleanups.push(repo.cleanup);
  const cloud = fakeCloud();
  const cp = await controlPlane(cloud);
  const revoked: string[] = [];
  const fetchSpy: typeof fetch = async (_url, init) => {
    revoked.push(String((init?.headers as Record<string, string>)?.authorization));
    return new Response(null, { status: 204 });
  };
  return { repo, cloud, cp, revoked, fetchSpy };
}

const edit = (line: string) => async (wt: string) => {
  await writeFile(join(wt, "README.md"), `# scratch\n${line}\n`);
  git(wt, "-c", "user.name=a", "-c", "user.email=a@x.invalid", "commit", "-qam", "add a line");
  await writeFile(join(wt, RESULT_FILE), JSON.stringify({ notes: "added" }));
  return [
    { type: "agent.status" as const, status: "working" as const },
    { type: "session.ended" as const, outcome: "completed" as const, summary: "added it" },
  ];
};

describe("runJob", () => {
  it("builds: pushes only the run branch with the job token and hands back its head", async () => {
    const { repo, cloud, cp, fetchSpy } = await world();
    const j = job();
    cloud.claims.set("c", j);
    const adapter = fakeAdapter((x) => repo.host.clonePath(x), edit("hello"));
    const report = await runJob({
      adapter,
      cp,
      git: repo.host,
      job: j,
      fetch: fetchSpy,
      flushMs: 5,
    });

    expect(report.outcome).toBe("completed");
    expect(report.handedBack).toBe(true);
    const pushed = git(repo.bare, "rev-parse", j.branch);
    expect(report.headSha).toBe(pushed);
    // nothing else moved on "GitHub"
    expect(git(repo.bare, "for-each-ref", "--format=%(refname)").split("\n").sort()).toEqual([
      "refs/heads/factory/7-add-a-line",
      "refs/heads/factory/7-add-a-line-run-1",
      "refs/heads/main",
    ]);
    const handback = cloud.handbacks.get(j.jobId);
    expect(handback).toMatchObject({
      branch: j.branch,
      headSha: pushed,
      outcome: "completed",
      fencingToken: 3,
      result: { notes: "added" },
    });
    // the result file is passed through, never committed
    expect(git(repo.bare, "ls-tree", "-r", "--name-only", j.branch)).not.toContain(RESULT_FILE);
    const kinds = [...cloud.artifacts.values()].map((a) => a.kind).sort();
    expect(kinds).toEqual(["diff", "log", "summary"]);
    const diff = [...cloud.artifacts.values()].find((a) => a.kind === "diff");
    expect(diff?.kind === "diff" && diff.patch).toContain("+hello");
    expect(cloud.released.get(j.jobId)?.finalState).toBe("handed_back");
    expect(adapter.calls).toEqual(["prepare", "start", "events", "collect", "release"]);
    const events = cloud.events.get(j.jobId) ?? [];
    expect(events.every((e, i) => e.seq === i + 1)).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "job.state", state: "released" });
  });

  it("revokes every job token it fetched", async () => {
    const { repo, cloud, cp, revoked } = await world();
    const j = job();
    cloud.claims.set("c", j);
    const adapter = fakeAdapter((x) => repo.host.clonePath(x), edit("x"));
    const calls: string[] = [];
    await runJob({
      adapter,
      cp,
      git: repo.host,
      job: j,
      fetch: async (url, init) => {
        calls.push(`${init?.method} ${url}`);
        revoked.push("");
        return new Response(null, { status: 204 });
      },
    });
    // fake tokens (ghs_fake_) are skipped; a real-looking one is revoked
    expect(cloud.tokens).toBe(2); // one for the fetch, a fresh one for the push
    expect(calls).toEqual([]);
  });

  it("fetches the work item's attachments for an adapter that declares the capability", async () => {
    const { repo, cloud, cp } = await world();
    const j = job({ stage: "triage", harness: { id: "claude-code", role: "triage", prompt: "t" } });
    cloud.claims.set("c", j);
    const meta = {
      id: "att_1",
      filename: "notes.txt",
      contentType: "text/plain",
      sizeBytes: 5,
      sha256: "0".repeat(64),
      createdAt: new Date().toISOString(),
    };
    cloud.attachments.set(j.jobId, [{ meta, base64: btoa("hello") }]);
    const triage = async (wt: string) => {
      await writeFile(join(wt, RESULT_FILE), JSON.stringify({ size: "small", reason: "r" }));
      return [{ type: "session.ended" as const, outcome: "completed" as const }];
    };
    const base = fakeAdapter((x) => repo.host.clonePath(x), triage);
    const got: string[] = [];
    const adapter = {
      ...base,
      async manifest() {
        const m = await base.manifest();
        return { ...m, capabilities: [...m.capabilities, "work-item-attachments" as const] };
      },
      async attachFiles(
        _j: unknown,
        _w: unknown,
        files: { meta: { id: string }; bytes: Uint8Array }[],
      ) {
        for (const f of files) got.push(`${f.meta.id}:${new TextDecoder().decode(f.bytes)}`);
        return '\n## Attachments\n<untrusted-data label="attachment 1">…</untrusted-data>';
      },
    };
    const report = await runJob({ adapter, cp, git: repo.host, job: j });
    expect(report.outcome).toBe("completed");
    expect(got).toEqual(["att_1:hello"]);
    expect(base.prompts[0]).toContain("## Attachments");

    // A runner that doesn't declare the capability runs the same job and never asks.
    const k = job({ stage: "triage", harness: { id: "claude-code", role: "triage", prompt: "t" } });
    cloud.claims.set("d", k);
    cloud.attachments.set(k.jobId, [{ meta, base64: btoa("hello") }]);
    const calls = cloud.attachmentCalls;
    const plain = fakeAdapter((x) => repo.host.clonePath(x), triage);
    const plainReport = await runJob({ adapter: plain, cp, git: repo.host, job: k });
    expect(plainReport.outcome).toBe("completed");
    expect(plainReport.handedBack).toBe(true);
    expect(cloud.attachmentCalls).toBe(calls);
    expect(plain.prompts[0]).toBe("t");
  });

  it("triage: pushes nothing and passes the result through", async () => {
    const { repo, cloud, cp } = await world();
    const j = job({ stage: "triage", harness: { id: "claude-code", role: "triage", prompt: "t" } });
    cloud.claims.set("c", j);
    const adapter = fakeAdapter(
      (x) => repo.host.clonePath(x),
      async (wt) => {
        await writeFile(
          join(wt, RESULT_FILE),
          JSON.stringify({ size: "small", reason: "one line" }),
        );
        return [{ type: "session.ended", outcome: "completed" }];
      },
    );
    const report = await runJob({ adapter, cp, git: repo.host, job: j });
    expect(report.outcome).toBe("completed");
    expect(report.headSha).toBeUndefined();
    expect(() => git(repo.bare, "rev-parse", "--verify", j.branch)).toThrow();
    expect(cloud.handbacks.get(j.jobId)).toMatchObject({
      branch: j.branch,
      result: { size: "small", reason: "one line" },
    });
  });

  it("fails a build that made no commits", async () => {
    const { repo, cloud, cp } = await world();
    const j = job();
    cloud.claims.set("c", j);
    const adapter = fakeAdapter(
      (x) => repo.host.clonePath(x),
      async () => [{ type: "session.ended", outcome: "completed" }],
    );
    const report = await runJob({ adapter, cp, git: repo.host, job: j });
    expect(report.outcome).toBe("failed");
    expect(cloud.handbacks.get(j.jobId)?.summary).toContain("no commits");
  });

  it("commits what the session left uncommitted", async () => {
    const { repo, cloud, cp } = await world();
    const j = job();
    cloud.claims.set("c", j);
    const adapter = fakeAdapter(
      (x) => repo.host.clonePath(x),
      async (wt) => {
        await writeFile(join(wt, "new.txt"), "new\n");
        return [{ type: "session.ended", outcome: "completed" }];
      },
    );
    const report = await runJob({ adapter, cp, git: repo.host, job: j });
    expect(report.outcome).toBe("completed");
    expect(git(repo.bare, "show", `${j.branch}:new.txt`)).toBe("new");
    expect(git(repo.bare, "log", "-1", "--format=%an", j.branch)).toBe("Software Factory");
  });

  it("refuses to push when the session rewired git (a URL rewrite)", async () => {
    const { repo, cloud, cp } = await world();
    const j = job();
    cloud.claims.set("c", j);
    const adapter = fakeAdapter(
      (x) => repo.host.clonePath(x),
      async (wt, jj) => {
        await edit("x")(wt);
        git(wt, "config", `url.https://evil.invalid/.insteadOf`, "https://github.com/");
        return [{ type: "session.ended", outcome: jj ? "completed" : "failed" }];
      },
    );
    const report = await runJob({ adapter, cp, git: repo.host, job: j });
    expect(report.outcome).toBe("failed");
    expect(report.error).toContain("changed the repo's git config");
    expect(() => git(repo.bare, "rev-parse", "--verify", j.branch)).toThrow();
  });

  it("stops at once when fenced: no push, no hand-back, workspace released", async () => {
    const { repo, cloud, cp } = await world();
    const j = job();
    cloud.claims.set("c", j);
    const adapter = fakeAdapter(
      (x) => repo.host.clonePath(x),
      async (wt, _j, signal) => {
        await edit("x")(wt);
        cloud.fenced.add(j.jobId); // a takeover bumps the token mid-session
        await sleep(100, undefined, { signal }).catch(() => {});
        return [{ type: "log", stream: "terminal", text: "still going" }];
      },
    );
    const report = await runJob({ adapter, cp, git: repo.host, job: j, flushMs: 5 });
    expect(report.fenced).toBe(true);
    expect(report.handedBack).toBe(false);
    expect(cloud.handbacks.has(j.jobId)).toBe(false);
    expect(() => git(repo.bare, "rev-parse", "--verify", j.branch)).toThrow();
    expect(adapter.calls).toContain("release");
  });

  it("refuses any branch but the job's own run branch", () => {
    expect(() => assertPushable(job({ branch: "main" }))).toThrow();
    expect(() => assertPushable(job({ branch: "factory/7-add-a-line-run-2" }))).toThrow();
    expect(() => assertPushable(job(), "factory/8-other-run-1")).toThrow();
    expect(() => assertPushable(job(), "factory/7-add-a-line-run-1")).not.toThrow();
  });
});

describe("RunnerHost", () => {
  it("heartbeats, claims, runs, and frees its slot", async () => {
    const { repo, cloud, cp } = await world();
    const j = job();
    cloud.queue.push(j);
    const adapter = fakeAdapter((x) => repo.host.clonePath(x), edit("y"));
    const host = new RunnerHost({
      adapter,
      cp,
      git: repo.host,
      maxConcurrent: 1,
      heartbeatMs: 50,
      log: () => {},
    });
    await host.start();
    expect(host.activeJobs).toEqual([j.jobId]);
    await host.idle();
    await host.stop();
    expect(cloud.handbacks.get(j.jobId)?.outcome).toBe("completed");
    expect(cloud.heartbeats[0]?.capacity).toMatchObject({ max: 1, accepting: true });
    expect(existsSync(join(repo.host.clonePath(j), "..", `wt-${j.jobId}`))).toBe(false);
  });

  it("cancels a job when the heartbeat says so, and reports the job as held until then", async () => {
    const { repo, cloud, cp } = await world();
    const j = job();
    cloud.queue.push(j);
    const adapter = fakeAdapter(
      (x) => repo.host.clonePath(x),
      async (_wt, _j, signal) => {
        await sleep(5_000, undefined, { signal }).catch(() => {});
        return [];
      },
    );
    const host = new RunnerHost({
      adapter,
      cp,
      git: repo.host,
      maxConcurrent: 1,
      heartbeatMs: 30,
      log: () => {},
    });
    await host.start();
    await sleep(60);
    cloud.commands.push({ kind: "cancel", jobId: j.jobId, reason: "kill switch (project)" });
    const [report] = await host.idle();
    await host.stop();
    expect(report?.outcome).toBe("cancelled");
    expect(cloud.handbacks.has(j.jobId)).toBe(false);
    expect(cloud.released.get(j.jobId)?.finalState).toBe("failed");
    expect(
      cloud.heartbeats.some((h) =>
        h.activeJobs.some((a) => a.jobId === j.jobId && a.fencingToken === 3),
      ),
    ).toBe(true);
  });

  it("stops reporting a job once it is handed back (no late cancel)", async () => {
    const { repo, cloud, cp } = await world();
    const j = job();
    cloud.queue.push(j);
    const adapter = fakeAdapter((x) => repo.host.clonePath(x), edit("w"));
    const release = adapter.release.bind(adapter);
    let heartbeatsDuringRelease = 0;
    adapter.release = async (jj, ws, ss) => {
      const before = cloud.heartbeats.length;
      await sleep(120); // a slow cleanup spans a few heartbeats
      heartbeatsDuringRelease = cloud.heartbeats.length - before;
      // the cloud would answer "run is handed_back" with a cancel; the host must ignore it
      cloud.commands.push({ kind: "cancel", jobId: j.jobId, reason: "run is handed_back" });
      await sleep(60);
      return release(jj, ws, ss);
    };
    const host = new RunnerHost({
      adapter,
      cp,
      git: repo.host,
      maxConcurrent: 1,
      heartbeatMs: 25,
      log: () => {},
    });
    await host.start();
    const [report] = await host.idle();
    await host.stop();
    expect(report?.outcome).toBe("completed");
    expect(heartbeatsDuringRelease).toBeGreaterThan(0);
    const late = cloud.heartbeats.slice(-2);
    expect(late.every((h) => h.activeJobs.length === 0)).toBe(true);
  });

  it("takes no job when at capacity", async () => {
    const { repo, cloud, cp } = await world();
    cloud.queue.push(job());
    const adapter = fakeAdapter((x) => repo.host.clonePath(x), edit("z"));
    adapter.capacity = async () => ({ max: 2, inUse: 2, accepting: true });
    const host = new RunnerHost({
      adapter,
      cp,
      git: repo.host,
      maxConcurrent: 2,
      heartbeatMs: 1_000,
      log: () => {},
    });
    await host.start();
    await host.stop();
    expect(cloud.queue).toHaveLength(1);
  });
});

describe("revokeToken", () => {
  it("deletes a real job token and skips the fake ones", async () => {
    const { revokeToken } = await import("../src/git.ts");
    const seen: string[] = [];
    const spy: typeof fetch = async (url, init) => {
      seen.push(
        `${init?.method} ${url} ${(init?.headers as Record<string, string> | undefined)?.authorization}`,
      );
      return new Response(null, { status: 204 });
    };
    expect(await revokeToken("ghs_real", spy)).toBe(true);
    expect(await revokeToken("ghs_fake_1", spy)).toBe(true);
    expect(seen).toEqual(["DELETE https://api.github.com/installation/token Bearer ghs_real"]);
  });
});
