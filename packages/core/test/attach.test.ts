// Spec 05: attaching an outside pull request to a work item, and what verify.refresh does for one.
// The Workflow's attached path is tested end to end in apps/engine/test/attach-flow.test.ts.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { type Actor, FOREMAN, invoke } from "../src/index.ts";
import {
  call,
  delivered,
  deps,
  first,
  ok,
  refusal,
  rows,
  services,
  uid,
  world,
} from "./helpers.ts";

const github = services.github;
const INTAKE = { type: "intake" as const, id: "github" };
type World = Awaited<ReturnType<typeof world>>;
type Attached = { workItemId: string; number: number; branch: string; outcome: string };

const attach = (w: World, prNumber: number, actor: Actor = w.human) =>
  ok<Attached>("workItem.attachPr", { projectId: w.projectId, prNumber }, actor);

const refresh = (w: World, input: Record<string, unknown>) =>
  ok<{ outcome: string; workItemId: string | null; status: string | null }>(
    "verify.refresh",
    { repo: { owner: w.repo.owner, name: w.repo.repo }, ...input },
    INTAKE,
  );

const verifyChecks = async (w: World, sha: string) =>
  ((await github.state(w.repo)).checks?.[sha] ?? []).filter((c) => c.name === "factory/verify");

const item = (id: string) =>
  first<{
    kind: string;
    source: string;
    branch: string;
    pr_number: number;
    pr_url: string;
    head_sha: string;
    title: string;
    body: string;
    requester_user_id: string;
    status: string;
    status_reason: string | null;
    workflow_id: string;
  }>("SELECT * FROM core_work_items WHERE id = ?", id);

/** The outbox rows an operation queued for a Workflow, by event type. */
const workflowEvents = async (instanceId: string) =>
  (
    await rows<{ payload: string }>(
      "SELECT payload FROM core_outbox WHERE kind = 'workflow.event' AND instr(payload, ?) > 0",
      instanceId,
    )
  ).map((r) => JSON.parse(r.payload) as { type: string; payload: Record<string, unknown> });

describe("workItem.attachPr (spec 05, criterion 1)", () => {
  it("creates one attached work item on the PR's own branch and head, and starts its Workflow", async () => {
    const w = await world();
    const pr = await github.openOutsidePull(w.repo, {
      branch: "timoconnellaus/planning-design",
      title: "Planning design",
      body: "Moves the planning ADRs to block M.",
    });
    const created = await attach(w, pr.number);
    expect(created).toMatchObject({ outcome: "created", branch: "timoconnellaus/planning-design" });

    const row = await item(created.workItemId);
    expect(row).toMatchObject({
      kind: "attached",
      source: "pr",
      branch: "timoconnellaus/planning-design",
      pr_number: pr.number,
      head_sha: pr.headSha,
      title: "Planning design",
      body: "Moves the planning ADRs to block M.",
      requester_user_id: w.userId,
      status: "running",
    });
    expect(row.pr_url).toMatch(new RegExp(`/pull/${pr.number}$`));
    const key = await first<{ work_item_id: string }>(
      "SELECT work_item_id FROM core_intake_keys WHERE dedupe_key = ?",
      `github:${w.repo.owner}/${w.repo.repo}#${pr.number}`.toLowerCase(),
    );
    expect(key.work_item_id).toBe(created.workItemId);
    const started = await rows(
      "SELECT id FROM core_outbox WHERE kind = 'workflow.create' AND instr(payload, ?) > 0",
      created.workItemId,
    );
    expect(started).toHaveLength(1);
    // The head's check no longer says "Not attached".
    expect(await verifyChecks(w, pr.headSha)).toEqual([
      expect.objectContaining({ status: "in_progress", conclusion: null }),
    ]);

    // Attaching again returns the same item.
    const again = await attach(w, pr.number);
    expect(again).toEqual({ ...created, outcome: "attached" });
    expect(
      await rows("SELECT id FROM core_work_items WHERE project_id = ?", w.projectId),
    ).toHaveLength(1);
  });

  it("refuses a fork, a closed or merged PR and a factory branch, with a reason", async () => {
    const w = await world();
    const fork = await github.openOutsidePull(w.repo, {
      branch: "feature",
      title: "From a fork",
      fork: "someone/fork",
    });
    expect((await refusal(attach(w, fork.number))).message).toMatch(/from a fork/);

    const closed = await github.openOutsidePull(w.repo, { branch: "tim/closed", title: "Closed" });
    await github.closePull(w.repo, closed.number);
    expect((await refusal(attach(w, closed.number))).message).toMatch(/is closed/);

    const merged = await github.openOutsidePull(w.repo, { branch: "tim/merged", title: "Merged" });
    await github.mergePullRequest(w.repo, {
      number: merged.number,
      sha: merged.headSha,
      method: "merge",
    });
    expect((await refusal(attach(w, merged.number))).message).toMatch(/already merged/);

    const factory = await github.openOutsidePull(w.repo, {
      branch: "factory/9-something",
      title: "Factory",
    });
    const e = await refusal(attach(w, factory.number));
    expect(e).toMatchObject({ code: "denied" });
    expect(e.message).toMatch(/factory branch/);

    expect((await refusal(attach(w, 999))).code).toBe("not_found");
    expect(
      await rows("SELECT id FROM core_work_items WHERE project_id = ?", w.projectId),
    ).toHaveLength(0);
  });

  it("fails closed for a project with no valid policy", async () => {
    const w = await world(null);
    const pr = await github.openOutsidePull(w.repo, { branch: "tim/x", title: "X" });
    expect((await refusal(attach(w, pr.number))).code).toBe("unavailable");
  });

  it("refuses a non-member (criterion 6)", async () => {
    const w = await world();
    const pr = await github.openOutsidePull(w.repo, { branch: "tim/y", title: "Y" });
    const outsider = await world();
    expect((await refusal(attach(w, pr.number, outsider.human))).code).toBe("forbidden");
    expect(
      (
        await refusal(
          ok(
            "workItem.previewAttach",
            { repo: { owner: w.repo.owner, name: w.repo.repo }, prNumber: pr.number },
            outsider.human,
          ),
        )
      ).code,
    ).toBe("forbidden");
  });

  it("previews the PR for /attach and lists New work's open unattached PRs", async () => {
    const w = await world();
    const pr = await github.openOutsidePull(w.repo, {
      branch: "tim/preview",
      title: "Preview me",
      author: "someone",
    });
    const fork = await github.openOutsidePull(w.repo, {
      branch: "f",
      title: "Fork",
      fork: "x/y",
    });
    await github.openPullRequest(w.repo, {
      head: "factory/3-own",
      base: "main",
      title: "Factory's own",
      body: "",
    });
    const preview = await ok<{
      project: { id: string; repo: string };
      pr: { title: string; author: string; branch: string; headSha: string; refusal: null };
      attachedWorkItemId: string | null;
    }>(
      "workItem.previewAttach",
      { repo: { owner: w.repo.owner, name: w.repo.repo }, prNumber: pr.number },
      w.human,
    );
    expect(preview).toMatchObject({
      project: { id: w.projectId, repo: `${w.repo.owner}/${w.repo.repo}` },
      pr: {
        title: "Preview me",
        author: "someone",
        branch: "tim/preview",
        headSha: pr.headSha,
        refusal: null,
      },
      attachedWorkItemId: null,
    });

    const listed = async () =>
      (
        await ok<{ pulls: { number: number; refusal: string | null }[] }>(
          "github.openPullRequests",
          { projectId: w.projectId },
          w.human,
        )
      ).pulls;
    const before = await listed();
    expect(before.map((p) => p.number).sort()).toEqual([pr.number, fork.number].sort());
    expect(before.find((p) => p.number === fork.number)?.refusal).toMatch(/fork/);

    const created = await attach(w, pr.number);
    expect((await listed()).map((p) => p.number)).toEqual([fork.number]);
    const after = await ok<{ attachedWorkItemId: string }>(
      "workItem.previewAttach",
      { repo: { owner: w.repo.owner, name: w.repo.repo }, prNumber: pr.number },
      w.human,
    );
    expect(after.attachedWorkItemId).toBe(created.workItemId);
  });
});

describe("verify.refresh for outside PRs (spec 05)", () => {
  it("links the unattached check to /attach (criterion 6)", async () => {
    const w = await world();
    const pr = await github.openOutsidePull(w.repo, { branch: "tim/link", title: "Link" });
    const withBase = {
      ...deps,
      services: { ...services, publicBaseUrl: "https://sf.example/" },
    };
    const r = await invoke<{ outcome: string }>(
      withBase,
      "verify.refresh",
      {
        repo: { owner: w.repo.owner, name: w.repo.repo },
        headSha: pr.headSha,
        prNumber: pr.number,
        trigger: "pull_request",
      },
      { actor: INTAKE, origin: { surface: "test" } },
    );
    expect(r.status === "ok" && r.output.outcome).toBe("unattached");
    const [check] = await verifyChecks(w, pr.headSha);
    expect(check).toMatchObject({ conclusion: "failure" });
    expect(check?.url).toBe(
      `https://sf.example/attach?repo=${encodeURIComponent(`${w.repo.owner}/${w.repo.repo}`)}&pr=${pr.number}`,
    );
  });

  it("records a push to an attached PR, withdraws its merge gate and wakes the Workflow (criteria 4, 5)", async () => {
    const w = await world();
    const pr = await github.openOutsidePull(w.repo, { branch: "tim/push", title: "Push" });
    const created = await attach(w, pr.number);
    // A merge gate open on the old head, as the Workflow leaves it.
    await env.DB.prepare("UPDATE core_work_items SET stage = 'verify' WHERE id = ?")
      .bind(created.workItemId)
      .run();
    const gated = await call(
      "pr.merge",
      { workItemId: created.workItemId, headSha: pr.headSha, touchesFactoryConfig: false },
      FOREMAN,
    );
    expect(gated.status).toBe("pending");
    const pendingId = gated.status === "pending" ? gated.pendingActionId : "";

    const newHead = await github.push(w.repo, "tim/push");
    const r = await refresh(w, { headSha: newHead, prNumber: pr.number, trigger: "pull_request" });
    expect(r).toMatchObject({ outcome: "posted", workItemId: created.workItemId });
    expect((await item(created.workItemId)).head_sha).toBe(newHead);
    expect(
      await first("SELECT status, decision FROM core_pending_actions WHERE id = ?", pendingId),
    ).toEqual({ status: "rejected", decision: "withdrawn" });
    const events = await workflowEvents(created.workItemId);
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining([`approval-${pendingId}`, `pr-head-${created.workItemId}`]),
    );
    expect(events.find((e) => e.type === `approval-${pendingId}`)?.payload).toMatchObject({
      decision: "withdrawn",
    });
    // The new head is being verified; approving the withdrawn gate can't merge anything.
    expect((await verifyChecks(w, newHead))[0]).toMatchObject({ status: "in_progress" });
    expect(
      (
        await refusal(
          ok(
            "review.merge",
            { workItemId: created.workItemId, openedFullDiff: true, headSha: pr.headSha },
            w.human,
          ),
        )
      ).code,
    ).toBe("conflict");
    expect((await github.state(w.repo)).pulls.find((p) => p.number === pr.number)?.state).toBe(
      "open",
    );

    // A late delivery for an older head doesn't move the item back.
    await refresh(w, { headSha: pr.headSha, prNumber: pr.number, trigger: "pull_request" });
    expect((await item(created.workItemId)).head_sha).toBe(newHead);
  });

  it("closes an approved merge when GitHub refuses it because the branch moved after the engine's check", async () => {
    const w = await world();
    const pr = await github.openOutsidePull(w.repo, { branch: "tim/race", title: "Race" });
    const created = await attach(w, pr.number);
    await env.DB.prepare("UPDATE core_work_items SET stage = 'verify' WHERE id = ?")
      .bind(created.workItemId)
      .run();
    // The factory verified this head (pr.merge requires it, #190 review): a pass packet and
    // factory/verify a success for that SHA.
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO core_review_packets (id, work_item_id, head_sha, verdict, created_at) VALUES ('rp_race', ?, ?, 'pass', ?)",
      ).bind(created.workItemId, pr.headSha, now),
      env.DB.prepare(
        "INSERT OR REPLACE INTO core_verify_checks (project_id, head_sha, work_item_id, pr_number, status, conclusion, title, review_packet_id, updated_at) SELECT project_id, ?, id, ?, 'completed', 'success', 'Verified by the factory', 'rp_race', ? FROM core_work_items WHERE id = ?",
      ).bind(pr.headSha, pr.number, now, created.workItemId),
    ]);
    const input = {
      workItemId: created.workItemId,
      headSha: pr.headSha,
      touchesFactoryConfig: false,
    };
    const gated = await call("pr.merge", input, FOREMAN);
    const pendingId = gated.status === "pending" ? gated.pendingActionId : "";
    await ok(
      "review.merge",
      { workItemId: created.workItemId, openedFullDiff: true, headSha: pr.headSha },
      w.human,
    );
    // A push lands on GitHub before its webhook reaches the engine: the engine's head check passes,
    // GitHub refuses the merge.
    await github.push(w.repo, "tim/race");
    const refused = await refusal(call("pr.merge", input, FOREMAN, { approvalId: pendingId }));
    expect([refused.code, refused.message]).toEqual([
      "conflict",
      "the branch moved after you approved: review the new commit",
    ]);
    // Said in details too, so no caller has to match the message text.
    expect(refused.details).toMatchObject({ closeApproval: true, mergeRefused: "headMoved" });
    // The approval is closed with why, not left `approved` for a commit that won't merge.
    expect(
      await first(
        "SELECT status, decision, note FROM core_pending_actions WHERE id = ?",
        pendingId,
      ),
    ).toEqual({
      status: "rejected",
      decision: "withdrawn",
      note: "the branch moved after you approved: review the new commit",
    });
    expect((await github.state(w.repo)).pulls.find((p) => p.number === pr.number)?.state).toBe(
      "open",
    );
  });

  it("puts a waiting attached item back to running on a push", async () => {
    const w = await world();
    const pr = await github.openOutsidePull(w.repo, { branch: "tim/wait", title: "Wait" });
    const created = await attach(w, pr.number);
    const awaited = await ok<{ moved: boolean; event: string }>(
      "workItem.awaitHead",
      {
        workItemId: created.workItemId,
        headSha: pr.headSha,
        reason: "verify found problems: push a fix to the PR",
      },
      FOREMAN,
    );
    expect(awaited).toMatchObject({ moved: false, event: `pr-head-${created.workItemId}` });
    expect(await item(created.workItemId)).toMatchObject({
      status: "waiting",
      status_reason: "verify found problems: push a fix to the PR",
    });
    const newHead = await github.push(w.repo, "tim/wait");
    await refresh(w, { headSha: newHead, prNumber: pr.number, trigger: "pull_request" });
    expect(await item(created.workItemId)).toMatchObject({
      status: "running",
      status_reason: null,
      head_sha: newHead,
    });
    const moved = await ok<{ moved: boolean }>(
      "workItem.awaitHead",
      { workItemId: created.workItemId, headSha: pr.headSha, reason: "x" },
      FOREMAN,
    );
    expect(moved.moved).toBe(true);
  });

  it("ends an attached item Done when its PR is merged on GitHub outside the factory", async () => {
    const w = await world();
    const pr = await github.openOutsidePull(w.repo, { branch: "tim/merged", title: "Merged" });
    const created = await attach(w, pr.number);
    const r = await refresh(w, {
      headSha: pr.headSha,
      prNumber: pr.number,
      trigger: "closed",
      merged: true,
      mergedBy: "octo",
    });
    expect(r).toMatchObject({ outcome: "merged", workItemId: created.workItemId });
    expect(await item(created.workItemId)).toMatchObject({
      status: "done",
      stage: "done",
      status_reason: "merged outside the factory by octo",
    });
  });

  it("cancels an attached item when its PR closes without merging (criterion 7)", async () => {
    const w = await world();
    const pr = await github.openOutsidePull(w.repo, { branch: "tim/close", title: "Close" });
    const created = await attach(w, pr.number);
    const before = delivered.length;
    const r = await refresh(w, {
      headSha: pr.headSha,
      prNumber: pr.number,
      trigger: "closed",
      merged: false,
    });
    expect(r).toMatchObject({ outcome: "cancelled", workItemId: created.workItemId });
    expect(await item(created.workItemId)).toMatchObject({
      status: "cancelled",
      status_reason: "the pull request was closed without merging",
    });
    expect(delivered.length).toBeGreaterThan(before);
    expect(
      await rows(
        "SELECT id FROM core_outbox WHERE kind = 'workflow.terminate' AND instr(payload, ?) > 0",
        created.workItemId,
      ),
    ).toHaveLength(1);

    // Reopened, it reads as unattached again, and attaching it makes a new item.
    const reopened = await refresh(w, {
      headSha: pr.headSha,
      prNumber: pr.number,
      trigger: "pull_request",
    });
    expect(reopened.outcome).toBe("unattached");
    const again = await attach(w, pr.number);
    expect(again.outcome).toBe("created");
    expect(again.workItemId).not.toBe(created.workItemId);

    // A factory PR closed on GitHub ends its item too (it used to be left running and verified).
    const own = await ok<{ workItemId: string }>(
      "workItem.create",
      { state: "queued", projectId: w.projectId, title: "Own work", eventId: uid("e") },
      w.human,
    );
    await env.DB.prepare("UPDATE core_work_items SET pr_number = 77 WHERE id = ?")
      .bind(own.workItemId)
      .run();
    const closed = await refresh(w, {
      headSha: pr.headSha,
      prNumber: 77,
      trigger: "closed",
      merged: false,
    });
    expect(closed.outcome).toBe("cancelled");
    expect((await item(own.workItemId)).status).toBe("cancelled");
  });

  it("skips spec and build in triage for an attached item, whatever its size (criterion 2)", async () => {
    const w = await world();
    const pr = await github.openOutsidePull(w.repo, { branch: "tim/big", title: "Big" });
    const created = await attach(w, pr.number);
    const triaged = await ok<{ specRequired: boolean; reason: string; size: string }>(
      "workItem.triage",
      {
        workItemId: created.workItemId,
        result: {
          size: "large",
          reason: "touches everything",
          acceptanceCriteria: ["It works"],
          specRequested: "require",
        },
      },
      FOREMAN,
    );
    expect(triaged).toMatchObject({ size: "large", specRequired: false });
    expect(triaged.reason).toMatch(/^attached PR: built outside the factory\. Triage: /);
  });
});
