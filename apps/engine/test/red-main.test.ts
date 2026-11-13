// Red main (spec 53 part e, ADR 0584, decision 7): while the line is stopped, `factory/verify` on a
// waiting factory head reads "held: main is red", so GitHub refuses a person's merge too; and an
// episode knows its suspects (the factory's landings since green), naming a culprit in code only
// when it is proven.
import { env } from "cloudflare:workers";
import { sign } from "@software-factory/connector-webhook";
import { HELD_TITLE } from "@software-factory/core";
import { describe, expect, it } from "vitest";
import worker from "../src/index.ts";
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
  it("one landing whose merge commit turned main red is the proven culprit", async () => {
    const w = await world();
    await mainCi(w, await mainHead(w), "success");
    const a = await land(w, "Breaks main", "src/a.ts");
    await mainCi(w, a.mergeSha, "failure");
    const main = await health(w);
    expect(main?.suspects.map((s) => s.workItemId)).toEqual([a.id]);
    expect(main?.culpritWorkItemId).toBe(a.id);
    expect(main?.attribution).toMatch(/the only landing since .* was green/);
    // Green again: the episode, its suspects and its culprit are over.
    await mainCi(w, a.mergeSha, "success");
    expect(await health(w)).toMatchObject({ suspects: [], culpritWorkItemId: null });
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
    });
  });
});
