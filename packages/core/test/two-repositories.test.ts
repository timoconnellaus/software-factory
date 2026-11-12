// A project with two repositories (ADR 0490): webhooks, verify, the job's repo and token, the merge
// queue and the scheduler each act on the item's own repository, never on another of the project's.
import { env } from "cloudflare:workers";
import type { CapabilityManifest, Job } from "@software-factory/runner-contract";
import { CONTRACT_VERSION } from "@software-factory/runner-contract";
import { describe, expect, it } from "vitest";
import { FOREMAN } from "../src/index.ts";
import { first, numericId, ok, RUNNER_ACTOR, rows, services, uid, world } from "./helpers.ts";

const github = services.github;
const INTAKE = { type: "intake" as const, id: "github" };
const manifest: CapabilityManifest = {
  contractVersion: CONTRACT_VERSION,
  runnerKind: "local",
  harnesses: ["claude-code"],
  capabilities: ["hooks"],
};

/** A project with its first repository (from `world`) and a second one on the same installation. */
async function twoRepos() {
  const w = await world();
  const record = await first<{ id: string; installation_id: string }>(
    "SELECT id, installation_id FROM core_github_installations WHERE org_id = ?",
    w.orgId,
  );
  const repoId = Number(numericId());
  const name = uid("second-");
  const current = await github.getInstallation(record.installation_id);
  const repos = await github.listInstallationRepos(record.installation_id);
  await github.putInstallation({
    installationId: record.installation_id,
    account: current?.account ?? { login: "timoconnellaus", type: "Organization" },
    repos: [
      ...repos,
      { id: repoId, owner: "timoconnellaus", name, private: true, defaultBranch: "main" },
    ],
    members: [`gh-${w.userId}`],
  });
  const second = await ok<{ id: string; name: string }>(
    "repository.add",
    { projectId: w.projectId, installationRecordId: record.id, repoId },
    w.human,
  );
  const firstRepo = await first<{ id: string }>(
    "SELECT id FROM core_repositories WHERE project_id = ? AND id != ?",
    w.projectId,
    second.id,
  );
  const create = (title: string, repositoryId: string | null) =>
    ok<{ workItemId: string }>(
      "workItem.create",
      { projectId: w.projectId, title, ...(repositoryId ? { repositoryId } : {}) },
      w.human,
    );
  return { w, second, firstRepoId: firstRepo.id, create };
}

/** Pretends both items are attached PRs with the same number, one in each repository. */
async function samePrNumber(a: string, b: string) {
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE core_work_items SET kind = 'attached', status = 'waiting', pr_number = 5, head_sha = ? WHERE id = ?",
    ).bind("a".repeat(40), a),
    env.DB.prepare(
      "UPDATE core_work_items SET kind = 'attached', status = 'waiting', pr_number = 5, head_sha = ? WHERE id = ?",
    ).bind("b".repeat(40), b),
  ]);
}

const statusOf = async (id: string) =>
  (await first<{ status: string }>("SELECT status FROM core_work_items WHERE id = ?", id)).status;

describe("a project with two repositories (ADR 0490)", () => {
  it("closing B#5 cancels B's item, never A's with the same number", async () => {
    const { w, second, firstRepoId, create } = await twoRepos();
    const a = await create("In A", firstRepoId);
    const b = await create("In B", second.id);
    await samePrNumber(a.workItemId, b.workItemId);
    const out = await ok<{ outcome: string; workItemId: string | null }>(
      "verify.refresh",
      {
        repo: { owner: "timoconnellaus", name: second.name },
        headSha: "b".repeat(40),
        prNumber: 5,
        trigger: "closed",
      },
      INTAKE,
    );
    expect(out).toMatchObject({ outcome: "cancelled", workItemId: b.workItemId });
    expect(await statusOf(b.workItemId)).toBe("cancelled");
    expect(await statusOf(a.workItemId)).toBe("waiting");
    void w;
  });

  it("a push to B#5 moves B's head and posts factory/verify on B, not A", async () => {
    const { second, firstRepoId, create } = await twoRepos();
    const a = await create("In A", firstRepoId);
    const b = await create("In B", second.id);
    await samePrNumber(a.workItemId, b.workItemId);
    const pushed = "c".repeat(40);
    const out = await ok<{ workItemId: string | null }>(
      "verify.refresh",
      {
        repo: { owner: "timoconnellaus", name: second.name },
        headSha: pushed,
        prNumber: 5,
        trigger: "pull_request",
      },
      INTAKE,
    );
    expect(out.workItemId).toBe(b.workItemId);
    const heads = await rows<{ id: string; head_sha: string }>(
      "SELECT id, head_sha FROM core_work_items WHERE id IN (?, ?)",
      a.workItemId,
      b.workItemId,
    );
    expect(heads.find((h) => h.id === a.workItemId)?.head_sha).toBe("a".repeat(40));
    const check = await first<{ repository_id: string | null } | null>(
      "SELECT repository_id FROM core_verify_checks WHERE head_sha = ?",
      pushed,
    );
    expect(check?.repository_id).toBe(second.id);
  });

  it("gives a job its item's repository and a token for that repository only", async () => {
    const { w, second, create } = await twoRepos();
    const b = await create("In B", second.id);
    await ok("workItem.release", { workItemId: b.workItemId }, w.human).catch(() => null);
    await env.DB.prepare("UPDATE core_work_items SET status = 'running' WHERE id = ?")
      .bind(b.workItemId)
      .run();
    const runner = await ok<{ runnerId: string }>("runner.register", { name: "M5" }, w.human);
    const actor = RUNNER_ACTOR(runner.runnerId);
    await ok("branch.ensure", { workItemId: b.workItemId }, FOREMAN);
    await ok(
      "job.enqueue",
      { workItemId: b.workItemId, stage: "build", role: "implement", prompt: "Do it" },
      FOREMAN,
    );
    const job = (
      await ok<{ job: Job | null }>(
        "job.claim",
        {
          claimId: uid("claim-"),
          manifest,
          capacity: { max: 2, inUse: 0, accepting: true },
        },
        actor,
      )
    ).job as Job;
    expect(job.repo).toMatchObject({ owner: "timoconnellaus", name: second.name });
    const token = await ok<{ repo: { owner: string; name: string } }>(
      "run.issueToken",
      { jobId: job.jobId, fencingToken: job.lease.fencingToken },
      actor,
    );
    expect(token.repo).toEqual({ owner: "timoconnellaus", name: second.name });
  });

  it("holds the job of an item with no repository, with the reason, and claims the next", async () => {
    const { w, second, create } = await twoRepos();
    // As code deployed before 0260 would leave it: an item with no repository recorded, in a
    // project with two, so none can be inferred.
    const none = await create("No repository yet", second.id);
    const b = await create("In B", second.id);
    await env.DB.batch([
      env.DB.prepare("UPDATE core_work_items SET status = 'running' WHERE id IN (?, ?)").bind(
        none.workItemId,
        b.workItemId,
      ),
      env.DB.prepare("UPDATE core_work_items SET repository_id = NULL WHERE id = ?").bind(
        none.workItemId,
      ),
    ]);
    const runner = await ok<{ runnerId: string }>("runner.register", { name: "M5" }, w.human);
    const actor = RUNNER_ACTOR(runner.runnerId);
    const enqueue = (workItemId: string) =>
      ok<{ jobId: string }>(
        "job.enqueue",
        { workItemId, stage: "triage", role: "triage", prompt: "Look" },
        FOREMAN,
      );
    const held = await enqueue(none.workItemId);
    await enqueue(b.workItemId);
    const claimed = (
      await ok<{ job: Job | null }>(
        "job.claim",
        {
          claimId: uid("claim-"),
          manifest,
          capacity: { max: 2, inUse: 0, accepting: true },
        },
        actor,
      )
    ).job;
    expect(claimed?.workItem.id).toBe(b.workItemId);
    const waiting = await first<{ status: string; wait_reason: string | null }>(
      "SELECT status, wait_reason FROM core_jobs WHERE id = ?",
      held.jobId,
    );
    expect(waiting).toMatchObject({ status: "queued" });
    expect(waiting.wait_reason).toMatch(/no repository/);
  });

  it("keeps one merge queue per repository", async () => {
    const { w, second, firstRepoId, create } = await twoRepos();
    const a = await create("In A", firstRepoId);
    const b = await create("In B", second.id);
    await env.DB.prepare(
      "UPDATE core_work_items SET status = 'waiting', stage = 'merge' WHERE id IN (?, ?)",
    )
      .bind(a.workItemId, b.workItemId)
      .run();
    const enter = (id: string, at: string, n: number) =>
      env.DB.prepare(
        "INSERT INTO core_merge_queue (id, project_id, work_item_id, approved_sha, head_sha, enqueued_at, updated_at) VALUES (?, ?, ?, 'abc', 'abc', ?, ?)",
      ).bind(`mq_${uid("")}${n}`, w.projectId, id, at, at);
    await env.DB.batch([
      enter(a.workItemId, "2026-11-12T00:00:00.000Z", 1),
      enter(b.workItemId, "2026-11-12T00:01:00.000Z", 2),
    ]);
    for (const id of [a.workItemId, b.workItemId]) {
      const p = await ok<{ position: number; head: boolean }>(
        "mergeQueue.position",
        { workItemId: id },
        w.human,
      );
      expect(p).toMatchObject({ position: 1, head: true });
    }
  });
});
