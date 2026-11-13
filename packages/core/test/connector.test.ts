import { env } from "cloudflare:workers";
import type { CapabilityManifest, Job } from "@software-factory/runner-contract";
import { CONTRACT_VERSION } from "@software-factory/runner-contract";
import { describe, expect, it } from "vitest";
import { FOREMAN } from "../src/index.ts";
import {
  first,
  newItem,
  ok,
  RUNNER_ACTOR,
  refusal,
  rows,
  services,
  sha40,
  uid,
  world,
} from "./helpers.ts";

const github = services.github;
const INTAKE = { type: "intake" as const, id: "github" };
const manifest: CapabilityManifest = {
  contractVersion: CONTRACT_VERSION,
  runnerKind: "local",
  harnesses: ["claude-code"],
  capabilities: ["hooks"],
};

/** A work item with an active build run on `factory/<n>-<slug>-run-1`. */
async function withActiveRun() {
  const w = await world();
  const runner = await ok<{ runnerId: string }>("runner.register", { name: "M5" }, w.human);
  const item = await newItem(w);
  await ok("branch.ensure", { workItemId: item.workItemId }, FOREMAN);
  await ok(
    "job.enqueue",
    { workItemId: item.workItemId, stage: "build", role: "implement", prompt: "Do it" },
    FOREMAN,
  );
  const { job } = await ok<{ job: Job }>(
    "job.claim",
    { claimId: uid("c"), manifest, capacity: { max: 1, inUse: 0, accepting: true } },
    RUNNER_ACTOR(runner.runnerId),
  );
  return {
    w,
    item,
    job,
    runnerId: runner.runnerId,
    repo: { owner: w.repo.owner, name: w.repo.repo },
  };
}

const push = (
  repo: { owner: string; name: string },
  branch: string,
  after: string,
  pusherIsApp = true,
) =>
  ok<{ outcome: string; detail: string; failedRuns: string[] }>(
    "push.observe",
    {
      repo,
      ref: `refs/heads/${branch}`,
      before: sha40("b"),
      after,
      pusher: pusherIsApp ? "software-factory-test[bot]" : "timoconnellaus",
      pusherIsApp,
    },
    INTAKE,
  );

describe("the delivery log", () => {
  it("records a delivery once; a redelivery is a duplicate", async () => {
    const id = uid("delivery-");
    const input = { provider: "github", deliveryId: id, event: "push", repo: "o/r" };
    expect(await ok("connector.receive", input, INTAKE)).toEqual({ duplicate: false });
    expect(await ok("connector.receive", input, INTAKE)).toEqual({ duplicate: true });
    expect(
      await rows("SELECT * FROM core_connector_events WHERE delivery_id = ?", id),
    ).toHaveLength(1);
  });
});

describe("push validation (ADR 0052 item 4)", () => {
  it("accepts the App's push to the run branch of an active run with the current token", async () => {
    const { job, repo } = await withActiveRun();
    const out = await push(repo, job.branch, sha40("c1"));
    expect(out.outcome).toBe("ok");
  });

  it("fails the active run and fences it out when the App pushes another branch of the item", async () => {
    const { item, job, repo, runnerId } = await withActiveRun();
    const before = await first<{ fencing_token: number }>(
      "SELECT fencing_token FROM core_leases WHERE work_item_id = ?",
      item.workItemId,
    );
    const out = await push(repo, `${item.branch}-run-7`, sha40("c2"));
    expect(out.outcome).toBe("violation");
    expect(out.failedRuns).toEqual([job.runId]);
    const run = await first<{ status: string }>(
      "SELECT status FROM core_runs WHERE id = ?",
      job.runId,
    );
    expect(run.status).toBe("failed");
    const lease = await first<{ fencing_token: number }>(
      "SELECT fencing_token FROM core_leases WHERE work_item_id = ?",
      item.workItemId,
    );
    expect(lease.fencing_token).toBe(before.fencing_token + 1);
    // The runner's next fenced write is refused, and the Workflow is told the run failed.
    const e = await refusal(
      ok(
        "run.reportEvents",
        { jobId: job.jobId, fencingToken: job.lease.fencingToken, events: [] },
        RUNNER_ACTOR(runnerId),
      ),
    );
    expect(e.code).toBe("fenced");
    const audit = await first<{ result: string }>(
      "SELECT result FROM core_audit WHERE operation = 'push.observe' AND work_item_id = ? ORDER BY at DESC",
      item.workItemId,
    );
    expect(JSON.parse(audit.result).detail).toMatch(/no run's branch/);
    const notes = await rows(
      "SELECT id FROM core_outbox WHERE kind = 'notify' AND instr(payload, 'run.confinement') > 0 AND instr(payload, ?) > 0",
      item.workItemId,
    );
    expect(notes).toHaveLength(1);
  });

  it("fails the run when the App moves the work item's branch to a head no run handed back", async () => {
    const { item, job, repo } = await withActiveRun();
    const out = await push(repo, item.branch, sha40("d1"));
    expect(out).toMatchObject({ outcome: "violation", failedRuns: [job.runId] });
  });

  // #190 review: with no run of the item active, an App push the engine didn't make is never "a
  // control-plane move". The engine records its SHAs once GitHub answers, so it is judged again
  // after PUSH_RECHECK_MS (the outbox holds it), then is a violation unless the engine made it.
  it("judges an App push to an item's branch with no run active again later, then as a violation", async () => {
    const w = await world();
    const item = await newItem(w);
    await ok("branch.ensure", { workItemId: item.workItemId }, FOREMAN);
    const repo = { owner: w.repo.owner, name: w.repo.repo };
    // Another token of the same App moves the branch.
    const foreign = await github.push(w.repo, item.branch, undefined, ["src/hidden.ts"]);
    const first = await push(repo, item.branch, foreign);
    expect(first).toMatchObject({ outcome: "ok", failedRuns: [] });
    expect(first.detail).toMatch(/hasn't recorded making yet/);
    const held = await rows<{ next_at: string; payload: string }>(
      "SELECT next_at, payload FROM core_outbox WHERE kind = 'push.recheck' AND instr(payload, ?) > 0",
      foreign,
    );
    expect(held).toHaveLength(1);
    expect(Date.parse(String(held[0]?.next_at))).toBeGreaterThan(Date.now() + 100_000);
    // Judged again: still not the engine's, still the branch's head.
    const second = await ok<{ outcome: string; detail: string }>(
      "push.observe",
      { ...JSON.parse(String(held[0]?.payload)).input },
      INTAKE,
    );
    expect(second.outcome).toBe("violation");
    expect(second.detail).toMatch(/neither the engine nor a run of #\d+ made/);
    const notes = await rows(
      "SELECT id FROM core_outbox WHERE kind = 'notify' AND instr(payload, 'run.confinement') > 0 AND instr(payload, ?) > 0",
      item.workItemId,
    );
    expect(notes).toHaveLength(1);
  });

  it("accepts on the second look a head the engine made meanwhile (the merge queue's own merge)", async () => {
    const w = await world();
    const item = await newItem(w);
    await ok("branch.ensure", { workItemId: item.workItemId }, FOREMAN);
    const repo = { owner: w.repo.owner, name: w.repo.repo };
    const merged = await github.push(w.repo, item.branch, undefined, ["README.md"]);
    // The queue recorded the merge GitHub returned, after the push's delivery arrived.
    await env.DB.prepare(
      "INSERT INTO core_merge_queue (id, project_id, work_item_id, approved_sha, head_sha, status, enqueued_at, updated_at, update_merge_sha, driver) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, 'babysitter')",
    )
      .bind(
        uid("mq"),
        w.projectId,
        item.workItemId,
        sha40("a"),
        sha40("a"),
        new Date().toISOString(),
        new Date().toISOString(),
        merged,
      )
      .run();
    const again = await ok<{ outcome: string; detail: string }>(
      "push.observe",
      {
        repo,
        ref: `refs/heads/${item.branch}`,
        before: sha40("b"),
        after: merged,
        pusher: "software-factory-test[bot]",
        pusherIsApp: true,
        recheck: true,
      },
      INTAKE,
    );
    expect(again).toMatchObject({ outcome: "ok", detail: "a control-plane move" });
  });

  it("ignores people's pushes to their own branches", async () => {
    const { repo, job } = await withActiveRun();
    expect((await push(repo, "tim/feature", sha40("e1"), false)).outcome).toBe("ignored");
    expect((await push(repo, job.branch, sha40("e2"), false)).outcome).toBe("ignored");
  });

  it("never changes the config from a default-branch push: config lives in the app (ADR 0370)", async () => {
    const w = await world();
    const repo = { owner: w.repo.owner, name: w.repo.repo };
    const at = sha40(uid("f"));
    await github.setFile(
      w.repo,
      at,
      ".factory/policy.json",
      JSON.stringify({ version: 1, autonomyPolicy: "autonomous" }),
    );
    const out = await push(repo, "main", at, false);
    expect(out.outcome).toBe("ok");
    const project = await first<{ policy_sha: string }>(
      "SELECT policy_sha FROM core_projects WHERE id = ?",
      w.projectId,
    );
    expect(project.policy_sha).toBe(w.policySha);
    // A malformed file pushed to main doesn't halt the project either.
    const bad = sha40(uid("g"));
    await github.setFile(w.repo, bad, ".factory/policy.json", "{ nope");
    await push(repo, "main", bad, false);
    await newItem(w);
  });

  it("refuses a push for a repo that is no project", async () => {
    const e = await refusal(push({ owner: "someone", name: uid("nope-") }, "main", sha40("h")));
    expect(e.code).toBe("not_found");
  });
});

describe("App installations", () => {
  it("points matching projects at the installation, and clears it on removal", async () => {
    const w = await world();
    await env.DB.prepare(
      "UPDATE core_repositories SET github_installation_id = NULL, installation_record_id = NULL WHERE project_id = ?",
    )
      .bind(w.projectId)
      .run();
    const added = await ok<{ projects: number }>(
      "github.installation",
      {
        action: "added",
        installationId: "777",
        account: "TimOConnellAus",
        repositories: [w.repo.repo],
      },
      INTAKE,
    );
    expect(added.projects).toBe(1);
    const row = await first<{ github_installation_id: string }>(
      "SELECT github_installation_id FROM core_repositories WHERE project_id = ?",
      w.projectId,
    );
    expect(row.github_installation_id).toBe("777");
    // Removing a different installation leaves it alone.
    await ok(
      "github.installation",
      { action: "removed", installationId: "778", account: "timoconnellaus", repositories: null },
      INTAKE,
    );
    expect(
      (
        await first<{ id: string | null }>(
          "SELECT github_installation_id AS id FROM core_repositories WHERE project_id = ?",
          w.projectId,
        )
      ).id,
    ).toBe("777");
    await ok(
      "github.installation",
      { action: "removed", installationId: "777", account: "timoconnellaus", repositories: null },
      INTAKE,
    );
    expect(
      (
        await first<{ id: string | null }>(
          "SELECT github_installation_id AS id FROM core_repositories WHERE project_id = ?",
          w.projectId,
        )
      ).id,
    ).toBeNull();
  });
});
