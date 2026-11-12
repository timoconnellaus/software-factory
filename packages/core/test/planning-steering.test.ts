// Spec 26, the planning loop to kim's standard (ADR 0470): no gate on stale news, a person's word
// takes the spec back from the gate, skip, `about`, read receipts, notifications, steers in the record.
import type { CapabilityManifest, Job, PlanningNews } from "@software-factory/runner-contract";
import { CONTRACT_VERSION } from "@software-factory/runner-contract";
import { describe, expect, it } from "vitest";
import { approvalEvent, FOREMAN } from "../src/index.ts";
import { call, first, newItem, ok, RUNNER_ACTOR, refusal, rows, uid, world } from "./helpers.ts";

const manifest: CapabilityManifest = {
  contractVersion: CONTRACT_VERSION,
  runnerKind: "orca",
  harnesses: ["claude-code"],
  capabilities: ["hooks", "steer"],
};
type W = Awaited<ReturnType<typeof world>>;

async function planning(w: W) {
  const r = await ok<{ runnerId: string }>("runner.register", { name: "M5" }, w.human);
  const m5 = RUNNER_ACTOR(r.runnerId);
  const item = await newItem(w, "Add CSV export");
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
  const agentRefusal = (op: string, input: Record<string, unknown> = {}) =>
    refusal(agent(op, input));
  return { item, job, m5, agent, agentRefusal };
}

const SPEC = {
  specMd: "## Goal\nExport the deals list as CSV [request].",
  acceptanceCriteria: ["The CSV has a header row"],
  summary: "draft",
};

const session = (workItemId: string) =>
  first<{ round: number; at_gate: number; ready_spec_id: string | null }>(
    "SELECT round, at_gate, ready_spec_id FROM core_planning_sessions WHERE work_item_id = ? ORDER BY created_at DESC LIMIT 1",
    workItemId,
  );

/** The Workflow opens the spec gate: `spec.accept` from the foreman goes to review. */
async function openGate(workItemId: string, specId: string) {
  const result = await call("spec.accept", { workItemId, specId }, FOREMAN);
  if (result.status !== "pending") throw new Error("expected the spec gate to open");
  return result.pendingActionId;
}

const pendingAction = (id: string) =>
  first<{ status: string; decision: string | null }>(
    "SELECT status, decision FROM core_pending_actions WHERE id = ?",
    id,
  );

const outboxCount = async (kind: string, like: string, workItemId = "") =>
  Number(
    (
      await rows<{ n: number }>(
        "SELECT COUNT(*) AS n FROM core_outbox WHERE kind = ? AND payload LIKE ? AND payload LIKE ?",
        kind,
        `%${like}%`,
        `%${workItemId}%`,
      )
    )[0]?.n ?? 0,
  );

describe("the planning loop to kim's standard (spec 26)", () => {
  it("refuses the gate while a person's message is unread, then allows it once read (criterion 2)", async () => {
    const w = await world();
    const { item, agent, agentRefusal } = await planning(w);
    await agent("spec.revise", SPEC);
    await ok("chat.send", { workItemId: item.workItemId, text: "Use semicolons." }, w.human);
    const refused = await agentRefusal("planning.ready");
    expect(refused.code).toBe("conflict");
    expect(refused.message).toContain("planning_news");
    await agent("planning.news");
    expect(await agent("planning.ready")).toMatchObject({ round: 1 });
  });

  it("takes the spec back from an open gate when a person writes, and the planner asks again (criterion 3)", async () => {
    const w = await world();
    const { item, agent } = await planning(w);
    const { specId } = await agent<{ specId: string }>("spec.revise", SPEC);
    await agent("planning.ready");
    const gate = await openGate(item.workItemId, specId);

    await ok(
      "chat.send",
      { workItemId: item.workItemId, text: "Actually, tab-separated." },
      w.human,
    );
    expect(await pendingAction(gate)).toEqual({ status: "rejected", decision: "withdrawn" });
    expect(await session(item.workItemId)).toMatchObject({ round: 2, at_gate: 0 });
    expect(await outboxCount("workflow.event", approvalEvent(gate))).toBe(1);
    expect((await refusal(ok("spec.approve", { workItemId: item.workItemId }, w.human))).code).toBe(
      "conflict",
    );
    // The planner revises in the same session and asks again, for round 2.
    await agent("planning.news");
    await agent("spec.revise", { ...SPEC, summary: "tab-separated" });
    expect(await agent("planning.ready")).toMatchObject({ round: 2 });
  });

  it("covers the moment between the planner asking and the gate opening: the stale gate can't be approved, and the next ask withdraws it (criterion 3)", async () => {
    const w = await world();
    const { item, agent } = await planning(w);
    const { specId } = await agent<{ specId: string }>("spec.revise", SPEC);
    await agent("planning.ready");
    // A person writes before the Workflow opened the gate.
    await ok("chat.send", { workItemId: item.workItemId, text: "One more thing." }, w.human);
    expect(await session(item.workItemId)).toMatchObject({ round: 2, at_gate: 0 });
    const stale = await openGate(item.workItemId, specId);
    const approve = await refusal(ok("spec.approve", { workItemId: item.workItemId }, w.human));
    expect(approve.code).toBe("conflict");
    expect(approve.message).toContain("revising");
    await agent("planning.news");
    await agent("planning.ready");
    expect(await pendingAction(stale)).toEqual({ status: "rejected", decision: "withdrawn" });
    expect(await session(item.workItemId)).toMatchObject({ round: 2, at_gate: 1 });
  });

  it("takes the spec back when a person changes an answer at the gate (criterion 3)", async () => {
    const w = await world();
    const { item, agent } = await planning(w);
    const { questionIds } = await agent<{ questionIds: string[] }>("question.ask", {
      questions: [{ kind: "yes-no", prompt: "Header row?", default: "Yes" }],
    });
    const { specId } = await agent<{ specId: string }>("spec.revise", SPEC);
    await ok("question.answer", { questionId: questionIds[0], answer: "Yes" }, w.human);
    await agent("planning.news");
    await agent("planning.ready");
    const gate = await openGate(item.workItemId, specId);
    await ok("question.answer", { questionId: questionIds[0], answer: "No" }, w.human);
    expect(await pendingAction(gate)).toEqual({ status: "rejected", decision: "withdrawn" });
  });

  it("lets a person skip a planning question, and the agent decides it (criterion 5)", async () => {
    const w = await world();
    const { item, agent } = await planning(w);
    const { questionIds } = await agent<{ questionIds: string[] }>("question.ask", {
      questions: [{ kind: "single-choice", prompt: "Delimiter?", options: [",", ";"] }],
    });
    await agent("spec.revise", SPEC);
    await ok("question.answer", { questionId: questionIds[0], skipped: true }, w.human);
    const news = await agent<PlanningNews>("planning.news");
    expect(news.events).toEqual([
      expect.objectContaining({ type: "answer.submitted", answer: null, skipped: true }),
    ]);
    expect(news.openQuestions).toBe(0);
    expect(await agent("planning.ready")).toMatchObject({ round: 1 });
    // Only a planning session's questions can be skipped.
    const v1 = await ok<{ questionIds: string[] }>(
      "question.ask",
      { workItemId: item.workItemId, questions: [{ prompt: "Old-style?" }] },
      FOREMAN,
    );
    expect(
      (
        await refusal(
          ok("question.answer", { questionId: v1.questionIds[0], skipped: true }, w.human),
        )
      ).code,
    ).toBe("invalid_input");
  });

  it("says which question a message is about, and records when answers and messages reached the agent (criteria 6, 7)", async () => {
    const w = await world();
    const { item, agent } = await planning(w);
    const { questionIds } = await agent<{ questionIds: string[] }>("question.ask", {
      questions: [{ prompt: "Filename?" }],
    });
    const q = questionIds[0] as string;
    await ok("question.answer", { questionId: q, answer: "deals.csv" }, w.human);
    await ok(
      "chat.send",
      { workItemId: item.workItemId, text: "Why ask?", questionId: q },
      w.human,
    );
    type View = {
      questions: { id: string; answerDeliveredAt: string | null }[];
      messages: { deliveredAt: string | null }[];
    };
    const before = await ok<View>("planning.get", { workItemId: item.workItemId }, w.human);
    expect(before.questions.find((x) => x.id === q)?.answerDeliveredAt).toBeNull();
    expect(before.messages[0]?.deliveredAt).toBeNull();

    const news = await agent<PlanningNews>("planning.news");
    expect(news.events.find((e) => e.type === "chat.message")).toMatchObject({
      about: { questionId: q, number: 1, prompt: "Filename?" },
    });
    const after = await ok<View>("planning.get", { workItemId: item.workItemId }, w.human);
    expect(after.questions.find((x) => x.id === q)?.answerDeliveredAt).not.toBeNull();
    expect(after.messages[0]?.deliveredAt).not.toBeNull();

    // A revised answer is unread again until the agent takes it.
    await ok("question.answer", { questionId: q, answer: "export.csv" }, w.human);
    const revised = await ok<View>("planning.get", { workItemId: item.workItemId }, w.human);
    expect(revised.questions.find((x) => x.id === q)?.answerDeliveredAt).toBeNull();
  });

  it("tells the owner about later questions and replies only when nobody is watching (criterion 8)", async () => {
    const w = await world();
    const { item, agent } = await planning(w);
    await agent("spec.revise", SPEC);
    await agent("question.ask", { questions: [{ prompt: "First?" }] });
    await agent("planning.wait", { timeoutMs: 0 }); // announces planning
    const id = item.workItemId;
    expect(await outboxCount("notify", `"planning.question"`, id)).toBe(0);

    await agent("question.ask", { questions: [{ prompt: "Second?" }] });
    await agent("chat.reply", { text: "Drafted." });
    const questionNotes = await outboxCount("notify", `"planning.question"`, id);
    const replyNotes = await outboxCount("notify", `"planning.reply"`, id);
    expect(questionNotes).toBe(1);
    expect(replyNotes).toBe(1);

    await ok("planning.presence", { workItemId: id, open: true }, w.human);
    await agent("question.ask", { questions: [{ prompt: "Third?" }] });
    await agent("chat.reply", { text: "Asked one more." });
    expect(await outboxCount("notify", `"planning.question"`, id)).toBe(questionNotes);
    expect(await outboxCount("notify", `"planning.reply"`, id)).toBe(replyNotes);
  });

  it("puts a steer on a planning run in the chat, delivered, and not again as news (criterion 9)", async () => {
    const w = await world();
    const { item, agent } = await planning(w);
    const live = await ok<{ run: { id: string } }>(
      "run.live",
      { workItemId: item.workItemId },
      w.human,
    );
    await ok(
      "run.steer",
      { workItemId: item.workItemId, runId: live.run.id, text: "Skip the export button." },
      w.human,
    );
    const view = await ok<{ messages: { text: string; deliveredAt: string | null }[] }>(
      "planning.get",
      { workItemId: item.workItemId },
      w.human,
    );
    expect(view.messages).toEqual([
      expect.objectContaining({ text: "Skip the export button.", deliveredAt: expect.any(String) }),
    ]);
    const news = await agent<PlanningNews>("planning.news");
    expect(news.events.filter((e) => e.type === "chat.message")).toEqual([]);
  });

  it("asks nothing of a planning job's own writes when nothing changed", async () => {
    const w = await world();
    const { item, agent } = await planning(w);
    await agent("planning.news", { activity: "reading the repo" });
    const seen = await first<{ updated_at: string }>(
      "SELECT updated_at FROM core_planning_sessions WHERE work_item_id = ?",
      item.workItemId,
    );
    await agent("planning.news", { activity: "reading the repo" });
    const again = await first<{ updated_at: string }>(
      "SELECT updated_at FROM core_planning_sessions WHERE work_item_id = ?",
      item.workItemId,
    );
    expect(again.updated_at).toBe(seen.updated_at);
  });
});
