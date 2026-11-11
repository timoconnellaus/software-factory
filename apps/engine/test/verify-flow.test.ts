// V1 step 4 end to end in the engine: the GitHub App webhook (signature, dedupe, routing), and the
// v2 Workflow's verify: the PR opens before verify, CI on the head SHA decides the verdict, a
// check-suite webhook wakes a Workflow waiting on CI, and an opted-in incident's check-only fix
// auto-merges.
import { env } from "cloudflare:workers";
import { sign } from "@software-factory/connector-webhook";
import { describe, expect, it } from "vitest";
import worker from "../src/index.ts";
import {
  all,
  BALANCED,
  build,
  first,
  gateOpen,
  github,
  itemStatus,
  ok,
  runStage,
  sha40,
  triage,
  uid,
  verifyPass,
  waitFor,
  world,
} from "./helpers.ts";

const SECRET = "test-webhook-secret";

async function deliver(
  event: string,
  payload: unknown,
  opts: { id?: string; secret?: string } = {},
) {
  const body = JSON.stringify(payload);
  return worker.fetch(
    new Request("https://software-factory.example/webhooks/github", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-github-event": event,
        "x-github-delivery": opts.id ?? uid("delivery-"),
        "x-hub-signature-256": await sign(opts.secret ?? SECRET, body),
      },
    }),
    env,
  );
}

const repository = (w: Awaited<ReturnType<typeof world>>) => ({
  name: w.repo.repo,
  owner: { login: w.repo.owner },
});

const verifyChecks = async (w: Awaited<ReturnType<typeof world>>, sha: string) =>
  ((await github.state(w.repo)).checks?.[sha] ?? []).filter((c) => c.name === "factory/verify");

describe("the GitHub App webhook", () => {
  it("refuses a bad signature and handles a delivery once", async () => {
    const w = await world();
    const sha = await github.push(w.repo, "tim/local");
    const payload = {
      action: "opened",
      repository: repository(w),
      pull_request: { number: 41, head: { sha, ref: "tim/local" }, base: { ref: "main" } },
    };
    const bad = await deliver("pull_request", payload, { secret: "wrong" });
    expect(bad.status).toBe(401);
    expect(await verifyChecks(w, sha)).toEqual([]);

    const id = uid("delivery-");
    const first_ = await deliver("pull_request", payload, { id });
    expect(first_.status).toBe(200);
    const body = (await first_.json()) as { results: { op: string; outcome: string }[] };
    expect(body.results).toEqual([
      expect.objectContaining({ op: "verify.refresh", outcome: "ok" }),
    ]);
    // A PR the factory didn't open fails factory/verify (spec 04, criterion 3).
    expect((await verifyChecks(w, sha))[0]).toMatchObject({ conclusion: "failure" });

    const again = await deliver("pull_request", payload, { id });
    expect(await again.json()).toEqual({ ok: true, duplicate: true });
    const audits = await all(
      "SELECT id FROM core_audit WHERE operation = 'verify.refresh' AND instr(origin, ?) > 0",
      id,
    );
    expect(audits).toHaveLength(1);
    expect(
      await all("SELECT delivery_id FROM core_connector_events WHERE delivery_id = ?", id),
    ).toHaveLength(1);
  });

  it("mirrors the policy from a default-branch push", async () => {
    const w = await world();
    const sha = sha40(uid("p"));
    await github.setFile(w.repo, sha, ".factory/policy.json", JSON.stringify(BALANCED));
    const res = await deliver("push", {
      ref: "refs/heads/main",
      before: sha40("0"),
      after: sha,
      repository: repository(w),
      sender: { login: "timoconnellaus" },
    });
    expect(res.status).toBe(200);
    const project = await first<{ policy_sha: string }>(
      "SELECT policy_sha FROM core_projects WHERE id = ?",
      w.projectId,
    );
    expect(project?.policy_sha).toBe(sha);
  });
});

describe("verify in the v2 Workflow", () => {
  it("opens the PR before verify, and fails the verdict when CI is red though the runner says green (criterion 9)", async () => {
    const w = await world({ ...BALANCED, retryLimit: 2 });
    const item = await ok<{ workItemId: string }>(
      "workItem.create",
      { projectId: w.projectId, title: "Red CI" },
      w.human,
    );
    await runStage(w, item.workItemId, "triage", () => triage("small"));
    await runStage(w, item.workItemId, "build", () => build());
    let head = "";
    await runStage(w, item.workItemId, "verify", async (job) => {
      head = String(job.context.headSha);
      // The PR is already open, so CI runs on this head while the reviewer works.
      expect((await github.state(w.repo)).pulls.map((p) => p.state)).toEqual(["open"]);
      await github.setChecks(w.repo, head, [
        {
          name: "ci",
          status: "completed",
          conclusion: "failure",
          appSlug: "github-actions",
          url: null,
        },
      ]);
      return verifyPass;
    });
    await runStage(w, item.workItemId, "build", (job) => {
      expect(job.harness.prompt).toMatch(/CI failing/);
      return build();
    });
    const packet = await first<{ verdict: string }>(
      "SELECT verdict FROM core_review_packets WHERE work_item_id = ? AND head_sha = ?",
      item.workItemId,
      head,
    );
    expect(packet?.verdict).toBe("fail");
    expect((await verifyChecks(w, head))[0]).toMatchObject({ conclusion: "failure" });
  });

  it("waits for CI, is woken by the check-suite webhook, and passes factory/verify for the head", async () => {
    const w = await world();
    const item = await ok<{ workItemId: string }>(
      "workItem.create",
      { projectId: w.projectId, title: "Slow CI" },
      w.human,
    );
    await runStage(w, item.workItemId, "triage", () => triage("small"));
    await runStage(w, item.workItemId, "build", () => build());
    let head = "";
    await runStage(w, item.workItemId, "verify", async (job) => {
      head = String(job.context.headSha);
      await github.setChecks(w.repo, head, [
        {
          name: "ci",
          status: "in_progress",
          conclusion: null,
          appSlug: "github-actions",
          url: null,
        },
      ]);
      return verifyPass;
    });
    // The Workflow reads CI as pending and waits; no packet yet.
    await waitFor("a CI read", () =>
      first(
        "SELECT id FROM core_stages WHERE work_item_id = ? AND stage = 'verify' AND status = 'active'",
        item.workItemId,
      ),
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(
      await all("SELECT id FROM core_review_packets WHERE work_item_id = ?", item.workItemId),
    ).toHaveLength(0);

    await github.setChecks(w.repo, head, [
      {
        name: "ci",
        status: "completed",
        conclusion: "success",
        appSlug: "github-actions",
        url: null,
      },
    ]);
    const res = await deliver("check_suite", {
      action: "completed",
      repository: repository(w),
      check_suite: { head_sha: head, status: "completed", app: { slug: "github-actions" } },
    });
    expect(res.status).toBe(200);
    await gateOpen(item.workItemId, "merge");
    const packet = await first<{ verdict: string }>(
      "SELECT verdict FROM core_review_packets WHERE work_item_id = ?",
      item.workItemId,
    );
    expect(packet?.verdict).toBe("pass");
    expect((await verifyChecks(w, head))[0]).toMatchObject({
      status: "completed",
      conclusion: "success",
    });
  });

  it("auto-merges an opted-in incident's check-only fix, and sends anything else to the merge gate", async () => {
    const w = await world({
      ...BALANCED,
      overrides: { agent: { outbound: "allow", "check-merge": "allow" } },
    });
    const make = async (title: string) => {
      const item = await ok<{ workItemId: string }>(
        "workItem.create",
        { projectId: w.projectId, title },
        w.human,
      );
      await env.DB.prepare("UPDATE core_work_items SET kind = 'incident' WHERE id = ?")
        .bind(item.workItemId)
        .run();
      return item;
    };
    const checkOnly = await make("Factory incident: add a check");
    await runStage(w, checkOnly.workItemId, "triage", () => triage("small"));
    await runStage(w, checkOnly.workItemId, "build", () =>
      build([
        { path: ".factory/checks/no-console.json", status: "added" },
        { path: "evals/regressions/inc_test.json", status: "added" },
      ]),
    );
    await runStage(w, checkOnly.workItemId, "verify", () => verifyPass);
    await itemStatus(checkOnly.workItemId, "done");
    const done = await first<{ status_reason: string }>(
      "SELECT status_reason FROM core_work_items WHERE id = ?",
      checkOnly.workItemId,
    );
    expect(done?.status_reason).toMatch(/auto-merged/);
    expect(
      await all("SELECT id FROM core_pending_actions WHERE work_item_id = ?", checkOnly.workItemId),
    ).toHaveLength(0);
    expect((await github.state(w.repo)).pulls[0]?.state).toBe("merged");

    const touchesPolicy = await make("Factory incident: loosen the policy");
    await runStage(w, touchesPolicy.workItemId, "triage", () => triage("small"));
    await runStage(w, touchesPolicy.workItemId, "build", () =>
      build([
        { path: "evals/regressions/inc_2.json", status: "added" },
        { path: ".factory/policy.json", status: "modified" },
      ]),
    );
    await runStage(w, touchesPolicy.workItemId, "verify", () => verifyPass);
    await gateOpen(touchesPolicy.workItemId, "merge");
    const gate = await first<{ risk: string; operation: string }>(
      "SELECT risk, operation FROM core_pending_actions WHERE work_item_id = ? AND kind = 'merge'",
      touchesPolicy.workItemId,
    );
    expect(gate).toMatchObject({ operation: "pr.merge", risk: "self-modify" });
  });
});
