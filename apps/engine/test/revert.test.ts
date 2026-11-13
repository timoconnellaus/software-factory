// The engine-made revert of a red main's culprit and its reland (spec 53 §5, decisions 2 and 5,
// ADR 0622): only of a proven or person-named culprit, made by GitHub, landed as an attached
// repair through its own gate; once merged, "Reland: <title>" joins the backlog.
import { env } from "cloudflare:workers";
import { sign } from "@software-factory/connector-webhook";
import { BABYSITTER } from "@software-factory/core";
import { describe, expect, it } from "vitest";
import worker, { repairRedMain } from "../src/index.ts";
import {
  build,
  call,
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

const CI = (conclusion: string) => [
  {
    name: "ci",
    status: "completed" as const,
    conclusion,
    appSlug: "github-actions",
    url: null,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  },
];

async function webhook(event: string, payload: unknown) {
  const body = JSON.stringify(payload);
  const res = await worker.fetch(
    new Request("https://software-factory.example/webhooks/github", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-github-event": event,
        "x-github-delivery": uid("delivery-"),
        "x-hub-signature-256": await sign("test-webhook-secret", body),
      },
    }),
    env,
  );
  expect(res.status).toBe(200);
}

/** Main's CI settles on `sha` with `conclusion`, and GitHub says so. */
async function mainCi(w: World, sha: string, conclusion: string) {
  await github.setChecks(w.repo, sha, CI(conclusion));
  await webhook("check_suite", {
    action: "completed",
    repository: { name: w.repo.repo, owner: { login: w.repo.owner }, default_branch: "main" },
    check_suite: {
      head_sha: sha,
      head_branch: "main",
      status: "completed",
      app: { slug: "github-actions" },
    },
  });
}

async function toMergeGate(w: World, title: string, file: string) {
  const item = await ok<{ workItemId: string }>(
    "workItem.create",
    { state: "queued", projectId: w.projectId, title },
    w.human,
  );
  await runStage(w, item.workItemId, "triage", () => triage("small"));
  await runStage(w, item.workItemId, "build", () => build([file]));
  await runStage(w, item.workItemId, "verify", () => verifyPass);
  await gateOpen(item.workItemId, "merge");
  return item.workItemId;
}

const approve = async (w: World, workItemId: string) =>
  ok(
    "review.merge",
    { workItemId, openedFullDiff: true, headSha: await gateHead(workItemId) },
    w.human,
  );

const mainHead = async (w: World) => String(await github.getBranchSha(w.repo, "main"));

const health = async (w: World) =>
  (
    await ok<{
      repositories: {
        main: {
          state: string;
          suspects: { workItemId: string; mergeSha: string }[];
          culpritWorkItemId: string | null;
          attribution: string | null;
          attributedBy: string | null;
          candidateWorkItemId: string | null;
        } | null;
      }[];
    }>("delivery.status", { projectId: w.projectId }, w.human)
  ).repositories[0]?.main;

/** Lands an item through the babysitter; returns its merge commit (main's new head). */
async function land(w: World, title: string, file: string) {
  const id = await toMergeGate(w, title, file);
  await approve(w, id);
  await itemStatus(id, "done");
  const row = await first<{ merge_sha: string | null; pr_number: number }>(
    "SELECT merge_sha, pr_number FROM core_work_items WHERE id = ?",
    id,
  );
  expect(row?.merge_sha).toBe(await mainHead(w));
  return { id, mergeSha: String(row?.merge_sha), pr: Number(row?.pr_number) };
}

/** A landing whose merge turned main red, proven by a rerun that failed again. */
async function provenCulprit(w: World, title: string) {
  await mainCi(w, await mainHead(w), "success");
  const a = await land(w, title, "src/a.ts");
  await mainCi(w, a.mergeSha, "failure");
  await mainCi(w, a.mergeSha, "failure");
  expect(await health(w)).toMatchObject({ culpritWorkItemId: a.id, attributedBy: "proven" });
  return a;
}

const backdate = (w: World, minutes: number) =>
  env.DB.prepare("UPDATE core_main_health SET red_since = ? WHERE project_id = ?")
    .bind(new Date(Date.now() - minutes * 60_000).toISOString(), w.projectId)
    .run();

const revertOf = (id: string) =>
  first<{
    status: string;
    revert_work_item_id: string;
    reland_work_item_id: string | null;
    exact_inverse: number | null;
    reason: string | null;
  }>(
    "SELECT status, revert_work_item_id, reland_work_item_id, exact_inverse, reason FROM core_reverts WHERE original_work_item_id = ?",
    id,
  );

describe("the engine's revert (spec 53 §5)", () => {
  it("reverts a proven culprit after 30 minutes as an attached repair; once it lands, Reland joins the backlog", async () => {
    const w = await world();
    const a = await provenCulprit(w, "Breaks main");
    // Not before 30 minutes.
    await repairRedMain(env);
    expect(await revertOf(a.id)).toBeNull();
    await backdate(w, 31);
    await repairRedMain(env);
    const made = await revertOf(a.id);
    // Claimed, then opened in the same pass; whether GitHub's revert is the exact inverse is
    // checked in code and recorded (the check itself: packages/core/test/revert-verdict.test.ts).
    expect(made).toMatchObject({ status: "opened" });
    expect(made?.exact_inverse).not.toBeNull();
    const revertId = String(made?.revert_work_item_id);
    const revert = await first<{
      kind: string;
      repairs_main: number;
      title: string;
      pr_number: number;
    }>("SELECT kind, repairs_main, title, pr_number FROM core_work_items WHERE id = ?", revertId);
    expect(revert).toMatchObject({
      kind: "attached",
      repairs_main: 1,
      title: "Revert “Breaks main”",
    });
    // GitHub made it: the inverse of the culprit's PR, no code from the factory.
    const state = await github.state(w.repo);
    expect(state.reverts?.[Number(revert?.pr_number)]).toBe(a.pr);
    // One revert per culprit.
    await expect(call("mainRed.revert", { workItemId: a.id }, w.human)).rejects.toMatchObject({
      code: "conflict",
    });

    // The revert lands through its own gate (a person's, the switch being off).
    await runStage(w, revertId, "triage", () => triage("small"));
    await runStage(w, revertId, "verify", () => verifyPass);
    await gateOpen(revertId, "merge");
    await ok(
      "review.merge",
      { workItemId: revertId, openedFullDiff: true, headSha: await gateHead(revertId) },
      w.human,
    );
    await itemStatus(revertId, "done");
    await repairRedMain(env);
    const relanded = await revertOf(a.id);
    const reland = await first<{ title: string; status: string; parent_work_item_id: string }>(
      "SELECT title, status, parent_work_item_id FROM core_work_items WHERE id = ?",
      relanded?.reland_work_item_id,
    );
    expect(reland).toEqual({
      title: "Reland: Breaks main",
      status: "backlog",
      parent_work_item_id: a.id,
    });
    // The reverted item stays Done; its PR is told what happened.
    expect(await first("SELECT status FROM core_work_items WHERE id = ?", a.id)).toEqual({
      status: "done",
    });
    // Posted once, after the reland committed (an outbox message), in inert text.
    const comments = await waitFor("the comment", async () => {
      const c = (await github.state(w.repo)).comments ?? [];
      return c.length ? c : null;
    });
    expect(comments.map((c) => c.number)).toEqual([a.pr]);
    expect(comments[0]?.body).toMatch(/`Reland: Breaks main`/);
    // Attaching the revert PR again finds its item: no second one.
    const again = await ok<{ workItemId: string; outcome: string }>(
      "workItem.attachPr",
      { projectId: w.projectId, prNumber: Number(revert?.pr_number) },
      w.human,
    ).catch((e: { code?: string }) => ({ workItemId: "", outcome: e.code ?? "" }));
    expect(again.workItemId === revertId || again.outcome === "denied").toBe(true);
  });

  it("a claim asked of GitHub but not recorded finds GitHub's revert PR instead of opening another; a fork's look-alike is never adopted", async () => {
    const w = await world();
    const a = await provenCulprit(w, "Asked twice");
    await backdate(w, 31);
    const revert = (input: Record<string, unknown>) =>
      ok<{ status: string; attempt: number | null }>(
        "mainRed.revert",
        { workItemId: a.id, ...input },
        w.human,
      );
    expect(await revert({})).toMatchObject({ status: "claimed" });
    const lease = await revert({});
    expect(lease).toMatchObject({ status: "calling", attempt: 1 });
    // Another caller while the lease holds is refused: one caller asks GitHub at a time.
    await expect(call("mainRed.revert", { workItemId: a.id }, w.human)).rejects.toMatchObject({
      code: "conflict",
    });
    // A fork's PR named like GitHub's revert branch, and GitHub's own revert, made by a call that
    // lost track of it.
    await github.openOutsidePull(w.repo, {
      branch: `revert-${a.pr}-evil`,
      title: "Revert",
      body: "",
      fork: "someone/software-factory",
    });
    const real = await github.revertPullRequest(w.repo, {
      number: a.pr,
      title: "Revert",
      body: "",
    });
    const pulls = (await github.state(w.repo)).pulls.length;
    const opened = await ok<{ status: string; prNumber: number }>(
      "mainRed.revert",
      { workItemId: a.id, attempt: lease.attempt },
      w.human,
    );
    expect(opened).toMatchObject({ status: "opened", prNumber: real.number });
    expect((await github.state(w.repo)).pulls.length).toBe(pulls);
    // Done: a further call is refused.
    await expect(call("mainRed.revert", { workItemId: a.id }, w.human)).rejects.toMatchObject({
      code: "conflict",
    });
  });

  it("GitHub refusing the revert is recorded once, with an incident, and not tried again", async () => {
    const w = await world();
    const a = await provenCulprit(w, "Can't be reverted");
    await backdate(w, 31);
    await github.failNextPosts(w.repo, 1);
    await repairRedMain(env);
    expect(await revertOf(a.id)).toMatchObject({ status: "failed" });
    expect((await revertOf(a.id))?.reason).toMatch(/GitHub couldn't revert/);
    expect(
      await first("SELECT id FROM core_incidents WHERE source_work_item_id = ?", a.id),
    ).not.toBeNull();
    const pulls = (await github.state(w.repo)).pulls.length;
    await repairRedMain(env);
    expect((await github.state(w.repo)).pulls.length).toBe(pulls);
  });

  it("a revert whose item ends without merging is closed, and nothing relands", async () => {
    const w = await world();
    const a = await provenCulprit(w, "Revert abandoned");
    await backdate(w, 31);
    await repairRedMain(env);
    const made = await revertOf(a.id);
    await ok(
      "workItem.cancel",
      { workItemId: String(made?.revert_work_item_id), reason: "not this way" },
      w.human,
    );
    await repairRedMain(env);
    expect(await revertOf(a.id)).toMatchObject({ status: "abandoned", reland_work_item_id: null });
    // Its PR is closed on GitHub too.
    const row = await first<{ pr_number: number }>(
      "SELECT pr_number FROM core_work_items WHERE id = ?",
      made?.revert_work_item_id,
    );
    const pull = (await github.state(w.repo)).pulls.find((p) => p.number === row?.pr_number);
    expect(pull?.state).toBe("closed");
  });

  it("relands once per chain: a reland reverted again isn't relanded again, and a revert is never relanded", async () => {
    const w = await world();
    const mk = async (title: string) => {
      const c = await ok<{ workItemId: string }>(
        "workItem.create",
        { projectId: w.projectId, title },
        w.human,
      );
      await env.DB.prepare("UPDATE core_work_items SET status = 'done' WHERE id = ?")
        .bind(c.workItemId)
        .run();
      return c.workItemId;
    };
    const item = await first<{ repository_id: string }>(
      "SELECT repository_id FROM core_work_items WHERE project_id = ? AND repository_id IS NOT NULL",
      w.projectId,
    );
    const repo = item?.repository_id ?? (await mk("seed"));
    const revertRow = (original: string, root: string, revert: string, reland: string | null) =>
      env.DB.prepare(
        `INSERT INTO core_reverts (id, original_work_item_id, repository_id, project_id, red_since,
           status, root_work_item_id, revert_work_item_id, reland_work_item_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          `rvt_${uid("")}`,
          original,
          repo,
          w.projectId,
          new Date().toISOString(),
          reland ? "relanded" : "opened",
          root,
          revert,
          reland,
          new Date().toISOString(),
          new Date().toISOString(),
        )
        .run();
    // X was reverted (R1) and relanded as X2; X2 was reverted too (R2): its root is X.
    const x = await mk("Breaks main");
    const r1 = await mk("Revert X");
    const x2 = await mk("Reland: Breaks main");
    const r2 = await mk("Revert X2");
    await revertRow(x, x, r1, x2);
    await revertRow(x2, x, r2, null);
    const again = await ok<{ relandWorkItemId: string | null; reason: string | null }>(
      "mainRed.reland",
      { workItemId: r2 },
      BABYSITTER,
    );
    expect(again).toMatchObject({ relandWorkItemId: null });
    expect(again.reason).toMatch(/already relanded once/);
    // A revert's own revert: no "Reland: Revert …".
    const r3 = await mk("Revert of a revert");
    await revertRow(r1, r1, r3, null);
    const ofRevert = await ok<{ relandWorkItemId: string | null; reason: string | null }>(
      "mainRed.reland",
      { workItemId: r3 },
      BABYSITTER,
    );
    expect(ofRevert).toMatchObject({ relandWorkItemId: null });
    expect(ofRevert.reason).toMatch(/itself a revert/);
  });

  it("never reverts a guess: a candidate not yet proven, or a culprit an agent named", async () => {
    const w = await world();
    await mainCi(w, await mainHead(w), "success");
    const a = await land(w, "Maybe broke main", "src/a.ts");
    await mainCi(w, a.mergeSha, "failure");
    expect(await health(w)).toMatchObject({ candidateWorkItemId: a.id, culpritWorkItemId: null });
    await backdate(w, 31);
    await repairRedMain(env);
    expect(await revertOf(a.id)).toBeNull();
    await env.DB.prepare(
      "UPDATE core_main_health SET culprit_work_item_id = ?, attributed_by = 'agent' WHERE project_id = ?",
    )
      .bind(a.id, w.projectId)
      .run();
    await repairRedMain(env);
    expect(await revertOf(a.id)).toBeNull();
    await expect(call("mainRed.revert", { workItemId: a.id }, w.human)).rejects.toMatchObject({
      code: "conflict",
    });
  });
});
