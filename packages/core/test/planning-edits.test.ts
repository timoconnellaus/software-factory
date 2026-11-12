// Spec 27 (ADR 0471): people edit the plan and comment on its parts. The planner keeps a person's
// wording word for word, records the answers an edit settles, and hears comments with their quote.
import type { CapabilityManifest, Job, PlanningNews } from "@software-factory/runner-contract";
import { CONTRACT_VERSION } from "@software-factory/runner-contract";
import { describe, expect, it } from "vitest";
import { FOREMAN } from "../src/index.ts";
import { call, first, newItem, ok, RUNNER_ACTOR, refusal, uid, world } from "./helpers.ts";

const manifest: CapabilityManifest = {
  contractVersion: CONTRACT_VERSION,
  runnerKind: "orca",
  harnesses: ["claude-code"],
  capabilities: ["hooks", "steer", "interrupt"],
};
type W = Awaited<ReturnType<typeof world>>;

async function planning(w: W, title = "Take work from GitHub issues") {
  const r = await ok<{ runnerId: string }>("runner.register", { name: "M5" }, w.human);
  const m5 = RUNNER_ACTOR(r.runnerId);
  const item = await newItem(w, title);
  await ok("branch.ensure", { workItemId: item.workItemId }, FOREMAN);
  const started = await ok<{ jobId: string }>(
    "planning.start",
    { workItemId: item.workItemId },
    FOREMAN,
  );
  const { job } = await ok<{ job: Job | null }>(
    "job.claim",
    {
      claimId: uid("claim-"),
      manifest,
      capacity: { max: 2, inUse: 0, accepting: true, light: { max: 6, inUse: 0 } },
    },
    m5,
  );
  if (!job || job.jobId !== started.jobId) throw new Error("expected the planning job");
  const agent = <O = Record<string, unknown>>(op: string, input: Record<string, unknown> = {}) =>
    ok<O>(op, { ...input, jobId: job.jobId, fencingToken: job.lease.fencingToken }, m5);
  return { item, job, m5, agent };
}

const BODY = [
  "# Take work from GitHub issues",
  "",
  "## Scope",
  "- Only issues with the factory label come in [Q1]",
  "- New items land in the inbox of the project that owns the repository [Q2]",
].join("\n");
const SPEC = { specMd: BODY, acceptanceCriteria: ["A labelled issue becomes an item"] };

const current = (workItemId: string) =>
  first<{ id: string; version: number; body_md: string; created_by: string }>(
    "SELECT s.id, s.version, s.body_md, s.created_by FROM core_specs s JOIN core_work_items w ON w.current_spec_id = s.id WHERE w.id = ?",
    workItemId,
  );

describe("people edit the plan and comment on its parts (spec 27)", () => {
  it("records a person's edit as a plan version by them, and the planner hears it (criterion 1)", async () => {
    const w = await world();
    const { item, agent } = await planning(w);
    const { specId } = await agent<{ specId: string }>("spec.revise", SPEC);
    const before = "- New items land in the inbox of the project that owns the repository [Q2]";
    const after = "- New items land in the Backlog of the project that owns the repository [Q2]";
    const edit = await ok<{ specId: string; version: number; editId: string }>(
      "spec.edit",
      { workItemId: item.workItemId, specId, lineStart: 4, lineEnd: 4, before, after },
      w.human,
    );
    const now = await current(item.workItemId);
    expect(now).toMatchObject({ id: edit.specId, created_by: w.userId });
    expect(now.body_md).toContain("Backlog");
    const news = await agent<PlanningNews>("planning.news");
    expect(news.events).toEqual([
      expect.objectContaining({ type: "spec.edited", editId: edit.editId, before, after }),
    ]);
    const view = await ok<{ edits: { id: string; after: string }[] }>(
      "planning.get",
      { workItemId: item.workItemId },
      w.human,
    );
    expect(view.edits).toEqual([expect.objectContaining({ id: edit.editId, after })]);
  });

  it("refuses an edit made on an older plan, or lines that changed (criterion 2)", async () => {
    const w = await world();
    const { item, agent } = await planning(w);
    const first_ = await agent<{ specId: string }>("spec.revise", SPEC);
    await agent("spec.revise", { ...SPEC, specMd: `${BODY}\n- One item per issue [Q3]` });
    const stale = await refusal(
      ok(
        "spec.edit",
        {
          workItemId: item.workItemId,
          specId: first_.specId,
          lineStart: 3,
          lineEnd: 3,
          before: "- Only issues with the factory label come in [Q1]",
          after: "- Only issues with the sf label come in [Q1]",
        },
        w.human,
      ),
    );
    expect(stale.code).toBe("conflict");
    const now = await current(item.workItemId);
    const moved = await refusal(
      ok(
        "spec.edit",
        {
          workItemId: item.workItemId,
          specId: now.id,
          lineStart: 3,
          lineEnd: 3,
          before: "- something else",
          after: "- anything",
        },
        w.human,
      ),
    );
    expect(moved.code).toBe("conflict");
    expect((await current(item.workItemId)).id).toBe(now.id);
  });

  it("keeps a person's wording: a revision that drops it is refused, one that keeps it goes in (criterion 3)", async () => {
    const w = await world();
    const { item, agent } = await planning(w);
    const { specId } = await agent<{ specId: string }>("spec.revise", SPEC);
    const after = "- New items land in the Backlog of the project that owns the repository [Q2]";
    await ok(
      "spec.edit",
      {
        workItemId: item.workItemId,
        specId,
        lineStart: 4,
        lineEnd: 4,
        before: "- New items land in the inbox of the project that owns the repository [Q2]",
        after,
      },
      w.human,
    );
    await agent("planning.news");
    const dropped = await refusal(agent("spec.revise", SPEC));
    expect(dropped.code).toBe("conflict");
    expect(dropped.message).toContain("Backlog");
    const kept = await agent<{ version: number }>("spec.revise", {
      ...SPEC,
      specMd: `${BODY.replace(/^- New items.*$/m, after)}\n- One item per issue [Q3]`,
    });
    expect(kept.version).toBeGreaterThan(0);
  });

  it("records the answer an edit settles as the editor's, never for a sensitive question (criterion 4)", async () => {
    const w = await world();
    const { item, agent } = await planning(w);
    const { questionIds } = await agent<{ questionIds: string[] }>("question.ask", {
      questions: [
        {
          kind: "single-choice",
          prompt: "Where do they land?",
          options: ["The project's inbox", "Backlog"],
          default: "The project's inbox",
        },
        { prompt: "Who may file them?", domain: "security", default: "Members" },
      ],
    });
    const [where, who] = questionIds as [string, string];
    const { specId } = await agent<{ specId: string }>("spec.revise", SPEC);
    const { editId } = await ok<{ editId: string }>(
      "spec.edit",
      {
        workItemId: item.workItemId,
        specId,
        lineStart: 4,
        lineEnd: 4,
        before: "- New items land in the inbox of the project that owns the repository [Q2]",
        after: "- New items land in the Backlog of the project that owns the repository [Q2]",
      },
      w.human,
    );
    await agent("question.answerFromEdit", { questionId: where, answer: "Backlog", editId });
    const q = await first<{ answer: string; answered_by: string; answered_via_edit: string }>(
      "SELECT answer, answered_by, answered_via_edit FROM core_questions WHERE id = ?",
      where,
    );
    expect(q).toEqual({ answer: "Backlog", answered_by: w.userId, answered_via_edit: editId });
    const sensitive = await refusal(
      agent("question.answerFromEdit", { questionId: who, answer: "Admins", editId }),
    );
    expect(sensitive.code).toBe("forbidden");
    // An edit of another work item can't answer this one's questions.
    const other = await planning(w, "Something else");
    const otherSpec = await other.agent<{ specId: string }>("spec.revise", SPEC);
    const foreign = await ok<{ editId: string }>(
      "spec.edit",
      {
        workItemId: other.item.workItemId,
        specId: otherSpec.specId,
        lineStart: 3,
        lineEnd: 3,
        before: "- Only issues with the factory label come in [Q1]",
        after: "- Only issues with the sf label come in [Q1]",
      },
      w.human,
    );
    const crossed = await refusal(
      agent("question.answerFromEdit", {
        questionId: where,
        answer: "Backlog",
        editId: foreign.editId,
      }),
    );
    expect(crossed.code).toBe("forbidden");
  });

  it("takes the spec back from the gate on an edit, and the planner must read it first (criterion 5)", async () => {
    const w = await world();
    const { item, agent } = await planning(w);
    const { specId } = await agent<{ specId: string }>("spec.revise", SPEC);
    await agent("planning.ready");
    const gate = await call("spec.accept", { workItemId: item.workItemId, specId }, FOREMAN);
    if (gate.status !== "pending") throw new Error("expected the spec gate");
    await ok(
      "spec.edit",
      {
        workItemId: item.workItemId,
        specId,
        lineStart: 3,
        lineEnd: 3,
        before: "- Only issues with the factory label come in [Q1]",
        after: "- Only issues with the sf label come in [Q1]",
      },
      w.human,
    );
    const pa = await first<{ decision: string }>(
      "SELECT decision FROM core_pending_actions WHERE id = ?",
      gate.pendingActionId,
    );
    expect(pa.decision).toBe("withdrawn");
    expect((await refusal(agent("planning.ready"))).code).toBe("conflict");
    await agent("planning.news");
    expect(await agent("planning.ready")).toMatchObject({ round: 2 });
  });

  it("brings a comment on plan lines to the planner with its quote (criterion 6)", async () => {
    const w = await world();
    const { item, agent } = await planning(w);
    const { specId } = await agent<{ specId: string }>("spec.revise", SPEC);
    const quote = "- Only issues with the factory label come in [Q1]";
    await ok(
      "chat.send",
      {
        workItemId: item.workItemId,
        text: "Which label exactly?",
        anchor: { specId, lineStart: 3, lineEnd: 3, quote },
      },
      w.human,
    );
    const news = await agent<PlanningNews>("planning.news");
    expect(news.events).toEqual([
      expect.objectContaining({
        type: "chat.message",
        anchor: { lineStart: 3, lineEnd: 3, quote },
      }),
    ]);
    const view = await ok<{ messages: { anchor: { quote: string } | null }[] }>(
      "planning.get",
      { workItemId: item.workItemId },
      w.human,
    );
    expect(view.messages[0]?.anchor?.quote).toBe(quote);
  });
});
