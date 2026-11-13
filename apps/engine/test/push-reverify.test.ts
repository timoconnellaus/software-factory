// A person's push to the branch of a factory-built work item (ADR 0587, Workflow v13): from verify
// on, the item verifies the newest head again, without a build. The push arrives as GitHub sends
// it (the `push` webhook, then `pull_request` `synchronize`), through the real Workflow.
import { introspectWorkflow } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { sign } from "@software-factory/connector-webhook";
import { afterEach, describe, expect, it } from "vitest";
import worker from "../src/index.ts";
import {
  all,
  build,
  first,
  gateHead,
  gateOpen,
  github,
  itemStatus,
  ok,
  runStage,
  triage,
  uid,
  verifyPass,
  waitFor,
  world,
} from "./helpers.ts";

type World = Awaited<ReturnType<typeof world>>;

const SECRET = "test-webhook-secret";
const PERSON = "octocat";
const APP = `${env.GH_APP_SLUG}[bot]`;

async function deliver(event: string, payload: unknown) {
  const body = JSON.stringify(payload);
  const res = await worker.fetch(
    new Request("https://software-factory.example/webhooks/github", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-github-event": event,
        "x-github-delivery": uid("delivery-"),
        "x-hub-signature-256": await sign(SECRET, body),
      },
    }),
    env,
  );
  expect(res.status).toBe(200);
}

interface Item {
  id: string;
  branch: string;
  pr: number;
  head: string;
}

async function itemRow(id: string): Promise<Item> {
  const row = await first<{ branch: string; pr_number: number | null; head_sha: string }>(
    "SELECT branch, pr_number, head_sha FROM core_work_items WHERE id = ?",
    id,
  );
  return {
    id,
    branch: String(row?.branch),
    pr: Number(row?.pr_number),
    head: String(row?.head_sha),
  };
}

/** A commit pushed to the item's branch by `sender`, and GitHub's two deliveries for it. */
async function pushTo(w: World, item: Item, sender = PERSON, file = `docs/${uid("f")}.md`) {
  const before = (await github.getBranchSha(w.repo, item.branch)) ?? item.head;
  const after = await github.push(w.repo, item.branch, undefined, [file]);
  const repository = { name: w.repo.repo, owner: { login: w.repo.owner }, default_branch: "main" };
  await deliver("push", {
    ref: `refs/heads/${item.branch}`,
    before,
    after,
    repository,
    pusher: { name: sender },
    sender: { login: sender, type: sender === APP ? "Bot" : "User" },
  });
  await deliver("pull_request", {
    action: "synchronize",
    repository,
    pull_request: {
      number: item.pr,
      head: { sha: after, ref: item.branch },
      base: { ref: "main" },
    },
  });
  return after;
}

async function toMergeGate(w: World, title = "Pushed to") {
  const created = await ok<{ workItemId: string }>(
    "workItem.create",
    { state: "queued", projectId: w.projectId, title },
    w.human,
  );
  const id = created.workItemId;
  await runStage(w, id, "triage", () => triage("small"));
  await runStage(w, id, "build", () => build(["src/a.ts"]));
  await runStage(w, id, "verify", () => verifyPass);
  const gate = await gateOpen(id, "merge");
  return { item: await itemRow(id), gate };
}

const pending = (sql: string, id: string) =>
  first<{ status: string; decision: string | null; note: string | null }>(
    `SELECT status, decision, note FROM core_pending_actions WHERE ${sql}`,
    id,
  );

const jobs = (id: string, stage: string) =>
  all<{ context: string }>(
    "SELECT context FROM core_jobs WHERE work_item_id = ? AND stage = ? ORDER BY created_at, rowid",
    id,
    stage,
  );

/** push.observe's audit rows for the item: what each push was taken as. */
const pushAudit = async (id: string) =>
  (
    await all<{ result: string }>(
      "SELECT result FROM core_audit WHERE work_item_id = ? AND operation = 'push.observe' ORDER BY at, rowid",
      id,
    )
  ).map((a) => JSON.parse(a.result) as { outcome: string; detail: string });

/** A merge gate for `head`, opened after `notId` (the withdrawn one). */
const freshGate = (id: string, notId: string) =>
  waitFor("a new merge gate", () =>
    first<{ id: string; input: string }>(
      "SELECT id, input FROM core_pending_actions WHERE work_item_id = ? AND kind = 'merge' AND status = 'pending' AND id != ?",
      id,
      notId,
    ),
  );

const approve = async (w: World, id: string) =>
  ok(
    "review.merge",
    { workItemId: id, openedFullDiff: true, headSha: await gateHead(id) },
    w.human,
  );

describe("a person's push to a factory-built item's branch (ADR 0587, v13)", () => {
  it("#61: the gate is open, a person pushes, approving the old head is refused; the item verifies the new head and asks again", async () => {
    const w = await world();
    const { item, gate } = await toMergeGate(w, "Name the container runtime");
    const builds = (await jobs(item.id, "build")).length;

    const pushed = await pushTo(w, item);
    // The gate for the old head is withdrawn, saying who pushed; its Inbox card goes.
    expect(await pending("id = ?", gate.id)).toEqual({
      status: "rejected",
      decision: "withdrawn",
      note: `a new commit was pushed by ${PERSON}`,
    });
    const inbox = await ok("inbox.list", { orgId: w.orgId }, w.human);
    expect(JSON.stringify(inbox)).not.toContain(gate.id);
    expect((await itemRow(item.id)).head).toBe(pushed);
    // The person sees it: "<login> pushed <sha>: verifying again".
    const timeline = await ok<{ entries: { operation: string; result: unknown }[] }>(
      "workItem.timeline",
      { workItemId: item.id },
      w.human,
    );
    expect(
      timeline.entries.filter((e) => e.operation === "push.observe").map((e) => e.result),
    ).toEqual([
      expect.objectContaining({
        outcome: "reverify",
        detail: `${PERSON} pushed ${pushed.slice(0, 7)}: verifying again`,
      }),
    ]);
    // Approving the old head, as #61's owner would have: refused, nothing merges.
    await expect(
      ok(
        "review.merge",
        { workItemId: item.id, openedFullDiff: true, headSha: item.head },
        w.human,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect((await github.state(w.repo)).pulls.find((p) => p.number === item.pr)?.state).toBe(
      "open",
    );

    // Back to verify on the new head, with the checks run there; no build, no attempt burned.
    await runStage(w, item.id, "verify", (job) => {
      expect(job.context.headSha).toBe(pushed);
      expect(job.context.runChecks).toBe(true);
      return verifyPass;
    });
    const fresh = await freshGate(item.id, gate.id);
    expect(JSON.parse(fresh.input)).toMatchObject({ headSha: pushed });
    expect(await jobs(item.id, "build")).toHaveLength(builds);
    const row = await first<{ build_attempts: number; stage: string }>(
      "SELECT build_attempts, stage FROM core_work_items WHERE id = ?",
      item.id,
    );
    expect(row?.stage).toBe("merge");
    const packet = await first<{ verdict: string }>(
      "SELECT verdict FROM core_review_packets WHERE work_item_id = ? AND head_sha = ?",
      item.id,
      pushed,
    );
    expect(packet?.verdict).toBe("pass");

    await approve(w, item.id);
    await itemStatus(item.id, "done");
    expect((await github.state(w.repo)).pulls.find((p) => p.number === item.pr)?.state).toBe(
      "merged",
    );
  });

  it("a push while verify runs: the stale run opens no gate; the new head is verified, then gated", async () => {
    const w = await world();
    const created = await ok<{ workItemId: string }>(
      "workItem.create",
      { state: "queued", projectId: w.projectId, title: "Pushed during verify" },
      w.human,
    );
    const id = created.workItemId;
    await runStage(w, id, "triage", () => triage("small"));
    await runStage(w, id, "build", () => build(["src/a.ts"]));
    let pushed = "";
    await runStage(w, id, "verify", async () => {
      pushed = await pushTo(w, await itemRow(id));
      return verifyPass;
    });
    const second = await runStage(w, id, "verify", (job) => {
      expect(job.context.headSha).toBe(pushed);
      return verifyPass;
    });
    expect(second.context.runChecks).toBe(true);
    const gates = await waitFor("the merge gate", async () => {
      const rows = await all<{ input: string; status: string }>(
        "SELECT input, status FROM core_pending_actions WHERE work_item_id = ? AND kind = 'merge'",
        id,
      );
      return rows.length > 0 ? rows : null;
    });
    // Exactly one gate, for the pushed head: none was ever opened for the stale one.
    expect(gates.map((g) => JSON.parse(g.input).headSha)).toEqual([pushed]);
    expect(await jobs(id, "build")).toHaveLength(1);
    expect((await pushAudit(id)).map((a) => a.outcome)).toEqual(["reverify"]);
  });

  it("several pushes coalesce: one withdrawal at the gate, and one more verify for pushes during a run, on the newest head", async () => {
    const w = await world();
    const { item, gate } = await toMergeGate(w, "Pushed twice");
    const first1 = await pushTo(w, item);
    const second1 = await pushTo(w, item);
    expect(await pending("id = ?", gate.id)).toMatchObject({ decision: "withdrawn" });
    expect((await itemRow(item.id)).head).toBe(second1);

    // The next verify runs on whichever head the Workflow read; while it runs, two more pushes.
    let newest = "";
    const ran = await runStage(w, item.id, "verify", async (job) => {
      expect([first1, second1]).toContain(job.context.headSha);
      await pushTo(w, item);
      newest = await pushTo(w, item);
      return verifyPass;
    });
    expect(ran.context.headSha).not.toBe(newest);
    await runStage(w, item.id, "verify", (job) => {
      expect(job.context.headSha).toBe(newest);
      return verifyPass;
    });
    const fresh = await freshGate(item.id, gate.id);
    expect(JSON.parse(fresh.input)).toMatchObject({ headSha: newest });
    // The gate opened once after the run on the newest head; no verify is left queued.
    const verifies = await jobs(item.id, "verify");
    expect(verifies.map((j) => JSON.parse(j.context).headSha).at(-1)).toBe(newest);
    expect(verifies).toHaveLength(3);
    expect(
      await first("SELECT id FROM core_jobs WHERE work_item_id = ? AND status = 'queued'", item.id),
    ).toBeNull();
    expect(
      await all(
        "SELECT id FROM core_pending_actions WHERE work_item_id = ? AND kind = 'merge' AND status = 'pending'",
        item.id,
      ),
    ).toHaveLength(1);
  });

  it("the factory's own pushes (its App) don't withdraw the gate", async () => {
    const w = await world();
    const { item, gate } = await toMergeGate(w, "Pushed by the App");
    // The babysitter's update-branch, or any App push to the item's branch: push.observe's
    // confinement checks, not a person's push.
    await pushTo(w, item, APP);
    // A run branch pushed by the App: a run's push, never a person's.
    await deliver("push", {
      ref: `refs/heads/${item.branch}-run-9`,
      before: item.head,
      after: await github.push(w.repo, `${item.branch}-run-9`, item.head, ["src/b.ts"]),
      repository: { name: w.repo.repo, owner: { login: w.repo.owner }, default_branch: "main" },
      sender: { login: APP, type: "Bot" },
    });
    expect(await pending("id = ?", gate.id)).toMatchObject({ status: "pending" });
    expect((await itemRow(item.id)).head).toBe(item.head);
    expect((await pushAudit(item.id)).map((a) => a.outcome)).not.toContain("reverify");
    expect(await jobs(item.id, "verify")).toHaveLength(1);
  });

  it("an attached PR is unchanged: verify.refresh withdraws its gate, push.observe leaves it alone", async () => {
    const w = await world();
    const branch = `tim/${uid("b")}`;
    const pr = await github.openOutsidePull(w.repo, { branch, title: "Docs", body: "Docs." });
    const attached = await ok<{ workItemId: string }>(
      "workItem.attachPr",
      { projectId: w.projectId, prNumber: pr.number },
      w.human,
    );
    const id = attached.workItemId;
    await runStage(w, id, "triage", () => triage("small"));
    await runStage(w, id, "verify", () => verifyPass);
    const gate = await gateOpen(id, "merge");
    const pushed = await pushTo(w, { id, branch, pr: pr.number, head: pr.headSha });
    expect(await pending("id = ?", gate.id)).toMatchObject({
      decision: "withdrawn",
      note: expect.stringMatching(/the pull request's head moved/),
    });
    expect(await pushAudit(id)).toEqual([]);
    await runStage(w, id, "verify", (job) => {
      expect(job.context.headSha).toBe(pushed);
      return verifyPass;
    });
    await freshGate(id, gate.id);
    expect(await jobs(id, "verify")).toHaveLength(2);
  });
});

describe("a person's push to an item on an older Workflow (ADR 0587)", () => {
  let introspector: Awaited<ReturnType<typeof introspectWorkflow>> | null = null;
  afterEach(async () => {
    await introspector?.dispose();
    introspector = null;
  });
  async function onVersion(version: number) {
    introspector = await introspectWorkflow(env.WORK_ITEM_WORKFLOW);
    await introspector.modifyAll(async (m) => {
      await m.mockStepResult({ name: "meta: version" }, version);
    });
  }

  it("v12 at its merge gate: the stale gate is withdrawn and the new head verified, as v13", async () => {
    await onVersion(12);
    const w = await world();
    const { item, gate } = await toMergeGate(w, "v12 pushed at the gate");
    const pushed = await pushTo(w, item);
    expect(await pending("id = ?", gate.id)).toMatchObject({ decision: "withdrawn" });
    await runStage(w, item.id, "verify", (job) => {
      expect(job.context.headSha).toBe(pushed);
      return verifyPass;
    });
    const fresh = await freshGate(item.id, gate.id);
    expect(JSON.parse(fresh.input)).toMatchObject({ headSha: pushed });
    expect(await jobs(item.id, "build")).toHaveLength(1);
  });

  it("v12 in verify: the push is recorded and told, the item keeps the head it verifies", async () => {
    await onVersion(12);
    const w = await world();
    const created = await ok<{ workItemId: string }>(
      "workItem.create",
      { state: "queued", projectId: w.projectId, title: "v12 pushed during verify" },
      w.human,
    );
    const id = created.workItemId;
    await runStage(w, id, "triage", () => triage("small"));
    await runStage(w, id, "build", () => build(["src/a.ts"]));
    let before = await itemRow(id);
    let pushed = "";
    await runStage(w, id, "verify", async () => {
      before = await itemRow(id);
      pushed = await pushTo(w, before);
      return verifyPass;
    });
    await gateOpen(id, "merge");
    expect((await itemRow(id)).head).toBe(before.head);
    expect(await pushAudit(id)).toEqual([
      expect.objectContaining({
        outcome: "told",
        detail: `${PERSON} pushed ${pushed.slice(0, 7)} while the factory verifies ${before.head.slice(0, 7)}: send it back to verify ${pushed.slice(0, 7)}`,
      }),
    ]);
  });
});
