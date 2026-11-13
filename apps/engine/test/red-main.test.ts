// Red main (spec 53 part e, ADR 0584, decision 7): while the line is stopped, `factory/verify` on a
// waiting factory head reads "held: main is red", so GitHub refuses a person's merge too; and an
// episode knows its suspects (the factory's landings since green), naming a culprit in code only
// when it is proven.
import { env } from "cloudflare:workers";
import { sign } from "@software-factory/connector-webhook";
import { ATTACHED_HELD_TITLE, BABYSITTER, FOREMAN, HELD_TITLE } from "@software-factory/core";
import { describe, expect, it } from "vitest";
import worker, { releaseHeldChecks } from "../src/index.ts";
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

const verifyCheck = (headSha: string) =>
  first<{ status: string; conclusion: string | null; title: string }>(
    "SELECT status, conclusion, title FROM core_verify_checks WHERE head_sha = ?",
    headSha,
  );

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
  const row = await first<{ merge_sha: string | null }>(
    "SELECT merge_sha FROM core_work_items WHERE id = ?",
    id,
  );
  expect(row?.merge_sha).toBe(await mainHead(w));
  return { id, mergeSha: String(row?.merge_sha) };
}

describe("held: main is red (decision 7)", () => {
  it("a waiting factory head reads held while main is red, and passes again at green; the babysitter then lands it", async () => {
    const w = await world();
    await mainCi(w, await mainHead(w), "success");
    const a = await toMergeGate(w, "Waits out the red", "src/a.ts");
    const head = await gateHead(a);
    expect(await verifyCheck(head)).toMatchObject({ conclusion: "success" });

    await mainCi(w, await mainHead(w), "failure");
    await waitFor("factory/verify held", async () => {
      const c = await verifyCheck(head);
      return c?.title === HELD_TITLE ? c : null;
    });
    expect(await verifyCheck(head)).toMatchObject({ status: "in_progress", conclusion: null });
    // A CI webhook meanwhile doesn't lift it either.
    await call(
      "verify.refresh",
      { repo: { owner: w.repo.owner, name: w.repo.repo }, headSha: head, trigger: "rerequested" },
      { type: "intake", id: "github" },
    );
    expect((await verifyCheck(head))?.title).toBe(HELD_TITLE);

    await approve(w, a);
    await mainCi(w, await mainHead(w), "success");
    await itemStatus(a, "done");
    expect(await verifyCheck(head)).toMatchObject({ status: "completed", conclusion: "success" });
  });

  it("a repair's head is never held", async () => {
    const w = await world();
    await mainCi(w, await mainHead(w), "success");
    const fix = await toMergeGate(w, "The fix", "src/fix.ts");
    await mainCi(w, await mainHead(w), "failure");
    await ok("workItem.markRepair", { workItemId: fix, repair: true }, w.human);
    await call(
      "verify.refresh",
      {
        repo: { owner: w.repo.owner, name: w.repo.repo },
        headSha: await gateHead(fix),
        trigger: "rerequested",
      },
      { type: "intake", id: "github" },
    );
    expect(await verifyCheck(await gateHead(fix))).toMatchObject({ conclusion: "success" });
  });
});

describe("an episode's suspects and culprit (spec 53 §5)", () => {
  it("one landing whose merge commit turned main red is a candidate until its failing checks fail again on a rerun", async () => {
    const w = await world();
    await mainCi(w, await mainHead(w), "success");
    const a = await land(w, "Breaks main", "src/a.ts");
    await mainCi(w, a.mergeSha, "failure");
    const opened = await health(w);
    expect(opened?.suspects.map((s) => s.workItemId)).toEqual([a.id]);
    // Not yet proven: the failing check is rerun once on the red head.
    expect(opened).toMatchObject({ culpritWorkItemId: null, candidateWorkItemId: a.id });
    expect(opened?.attribution).toMatch(/^candidate, not proven: /);
    expect((await github.state(w.repo)).reruns ?? []).toHaveLength(1);
    // The rerun fails again: proven.
    await mainCi(w, a.mergeSha, "failure");
    const proven = await health(w);
    expect(proven).toMatchObject({
      culpritWorkItemId: a.id,
      attributedBy: "proven",
      candidateWorkItemId: null,
    });
    expect(proven?.attribution).toMatch(/reproduced on a rerun/);
    // A person can't overwrite a proven culprit.
    await expect(
      call("mainRed.attribute", { workItemId: a.id, why: "mine" }, w.human),
    ).rejects.toMatchObject({ code: "conflict" });
    // Green again: the episode, its suspects and its culprit are over.
    await mainCi(w, a.mergeSha, "success");
    expect(await health(w)).toMatchObject({ suspects: [], culpritWorkItemId: null });
  });

  it("a red that passes on its rerun proves nothing: main is green, the flake recorded, nothing held", async () => {
    const w = await world();
    await mainCi(w, await mainHead(w), "success");
    const a = await land(w, "Flaky landing", "src/a.ts");
    const waiting = await toMergeGate(w, "Waits behind it", "src/b.ts");
    await mainCi(w, a.mergeSha, "failure");
    const head = await gateHead(waiting);
    await waitFor("held", async () =>
      (await verifyCheck(head))?.title === HELD_TITLE ? true : null,
    );
    await mainCi(w, a.mergeSha, "success");
    expect(await health(w)).toMatchObject({
      state: "green",
      culpritWorkItemId: null,
      candidateWorkItemId: null,
    });
    const flakes = await first<{ check_name: string }>(
      "SELECT check_name FROM core_flakes WHERE head_sha = ?",
      a.mergeSha,
    );
    expect(flakes).toEqual({ check_name: "ci" });
    await waitFor("released", async () =>
      (await verifyCheck(head))?.conclusion === "success" ? true : null,
    );
  });

  it("a repair closes the episode with the rerun unreported: no flake is recorded", async () => {
    const w = await world();
    await mainCi(w, await mainHead(w), "success");
    const a = await land(w, "Breaks main for real", "src/a.ts");
    await mainCi(w, a.mergeSha, "failure");
    expect(await health(w)).toMatchObject({ candidateWorkItemId: a.id });
    // A fix lands on main before the rerun on the red head reports; main is green on the fix.
    const fixed = await github.push(w.repo, "main", undefined, ["src/a-fix.ts"]);
    await mainCi(w, fixed, "success");
    expect(await health(w)).toMatchObject({ state: "green", candidateWorkItemId: null });
    expect(await first("SELECT id FROM core_flakes WHERE head_sha = ?", a.mergeSha)).toBeNull();
  });

  it("two landings: no culprit is guessed; a person names one of the suspects, and only a suspect", async () => {
    const w = await world();
    await mainCi(w, await mainHead(w), "success");
    const a = await land(w, "First landing", "src/a.ts");
    const b = await land(w, "Second landing", "src/b.ts");
    await mainCi(w, b.mergeSha, "failure");
    const main = await health(w);
    expect(main?.suspects.map((s) => s.workItemId).sort()).toEqual([a.id, b.id].sort());
    expect(main?.culpritWorkItemId).toBeNull();

    const outsider = await ok<{ workItemId: string }>(
      "workItem.create",
      { projectId: w.projectId, title: "Never landed" },
      w.human,
    );
    await expect(
      call("mainRed.attribute", { workItemId: outsider.workItemId, why: "a guess" }, w.human),
    ).rejects.toMatchObject({ code: "conflict" });
    await ok(
      "mainRed.attribute",
      { workItemId: a.id, why: "the failing test is in src/a.ts" },
      w.human,
    );
    expect(await health(w)).toMatchObject({
      culpritWorkItemId: a.id,
      attribution: "the failing test is in src/a.ts",
      attributedBy: "person",
    });
    // An agent is only ever the repository's babysit job, through the babysitter with its fence.
    await expect(
      call("mainRed.attribute", { workItemId: b.id, why: "guess" }, FOREMAN),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      call("mainRed.attribute", { workItemId: b.id, why: "guess", deliveryFence: 1 }, BABYSITTER),
    ).rejects.toMatchObject({ code: "fenced" });
    // The repository's babysit job, through the babysitter with its fence: refused over a person's.
    const item = await first<{ project_id: string; repository_id: string }>(
      "SELECT project_id, repository_id FROM core_work_items WHERE id = ?",
      b.id,
    );
    const key = `${item?.project_id}:${item?.repository_id}`;
    const jobId = `job_${"b".repeat(32)}${uid("").slice(0, 0)}`;
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO core_jobs (id, work_item_id, project_id, org_id, stage, role, prompt, session_timeout_ms, created_at, pool) SELECT ?, id, project_id, org_id, 'babysit', 'implement', 'p', 1, ?, 'light' FROM core_work_items WHERE id = ?",
      ).bind(jobId, new Date().toISOString(), b.id),
      env.DB.prepare(
        "INSERT INTO core_delivery_state (key, project_id, repository_id, updated_at, babysit_job_id, babysit_fence) VALUES (?, ?, ?, ?, ?, 7) ON CONFLICT (key) DO UPDATE SET babysit_job_id = excluded.babysit_job_id, babysit_fence = 7",
      ).bind(key, item?.project_id, item?.repository_id, new Date().toISOString(), jobId),
    ]);
    await expect(
      call(
        "mainRed.attribute",
        { workItemId: b.id, why: "the job thinks b", deliveryFence: 7 },
        BABYSITTER,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    // With no person's attribution standing, the job's goes through.
    await env.DB.prepare(
      "UPDATE core_main_health SET culprit_work_item_id = NULL, attribution = NULL, attributed_by = NULL WHERE project_id = ?",
    )
      .bind(w.projectId)
      .run();
    await ok(
      "mainRed.attribute",
      { workItemId: b.id, why: "the job thinks b", deliveryFence: 7 },
      BABYSITTER,
    );
    expect(await health(w)).toMatchObject({ culpritWorkItemId: b.id, attributedBy: "agent" });
  });

  it("an attached PR is held too, saying the owner decides (decision 7)", async () => {
    const w = await world();
    await mainCi(w, await mainHead(w), "success");
    const branch = `tim/${uid("b")}`;
    const pr = await github.openOutsidePull(w.repo, { branch, title: "Docs", body: "Docs." });
    const attached = await ok<{ workItemId: string }>(
      "workItem.attachPr",
      { projectId: w.projectId, prNumber: pr.number },
      w.human,
    );
    await runStage(w, attached.workItemId, "triage", () => triage("small"));
    await runStage(w, attached.workItemId, "verify", () => verifyPass);
    await gateOpen(attached.workItemId, "merge");
    await mainCi(w, await mainHead(w), "failure");
    await waitFor("attached held", async () =>
      (await verifyCheck(pr.headSha))?.title === ATTACHED_HELD_TITLE ? true : null,
    );
    await mainCi(w, await mainHead(w), "success");
    await waitFor("released", async () =>
      (await verifyCheck(pr.headSha))?.conclusion === "success" ? true : null,
    );
  });

  it("the cron releases a held check whose repository is green again, or whose item ended; idempotently", async () => {
    const w = await world();
    await mainCi(w, await mainHead(w), "success");
    const a = await toMergeGate(w, "Held, then the event is lost", "src/a.ts");
    const b = await toMergeGate(w, "Held, then cancelled", "src/b.ts");
    await mainCi(w, await mainHead(w), "failure");
    const [ha, hb] = [await gateHead(a), await gateHead(b)];
    await waitFor("both held", async () =>
      (await verifyCheck(ha))?.title === HELD_TITLE && (await verifyCheck(hb))?.title === HELD_TITLE
        ? true
        : null,
    );
    await ok("workItem.cancel", { workItemId: b, reason: "not needed" }, w.human);
    // Main goes green, and the webhook that would release A is lost.
    await env.DB.prepare(
      "UPDATE core_main_health SET red_since = NULL, state = 'green' WHERE project_id = ?",
    )
      .bind(w.projectId)
      .run();
    // One not yet due again (it failed before) waits its turn.
    await env.DB.prepare("UPDATE core_verify_checks SET release_after = ? WHERE head_sha = ?")
      .bind(new Date(Date.now() + 3_600_000).toISOString(), ha)
      .run();
    await releaseHeldChecks(env);
    expect((await verifyCheck(ha))?.title).toBe(HELD_TITLE);
    await env.DB.prepare("UPDATE core_verify_checks SET release_after = NULL WHERE head_sha = ?")
      .bind(ha)
      .run();
    await releaseHeldChecks(env);
    await releaseHeldChecks(env);
    expect(await verifyCheck(ha)).toMatchObject({ conclusion: "success" });
    expect(await verifyCheck(hb)).toMatchObject({ conclusion: "failure" });
    expect((await verifyCheck(hb))?.title).toMatch(/ended \(cancelled\)/);
    expect(
      await first(
        "SELECT head_sha FROM core_verify_checks WHERE held_at IS NOT NULL AND head_sha IN (?, ?)",
        ha,
        hb,
      ),
    ).toBeNull();
  });
});
