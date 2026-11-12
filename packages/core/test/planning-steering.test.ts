// Spec 26, the planning loop to kim's standard (ADR 0470): no gate on stale news, a person's word
// takes the spec back from the gate, skip, `about`, read receipts, notifications, steers in the record.
import type { CapabilityManifest, Job, PlanningNews } from "@software-factory/runner-contract";
import { CONTRACT_VERSION } from "@software-factory/runner-contract";
import { describe, expect, it } from "vitest";
import { approvalEvent, FOREMAN, invoke, type OperationError } from "../src/index.ts";
import {
  call,
  deps,
  first,
  newItem,
  ok,
  RUNNER_ACTOR,
  refusal,
  rows,
  uid,
  world,
} from "./helpers.ts";

const manifest: CapabilityManifest = {
  contractVersion: CONTRACT_VERSION,
  runnerKind: "orca",
  harnesses: ["claude-code"],
  capabilities: ["hooks", "steer", "interrupt"],
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

/**
 * Runs an operation and holds it after its reads, before its batch commits, until released: the
 * other side of a race runs in between (deterministic, review of #67).
 */
function held(op: string, input: unknown, actor: { type: string; id: string }) {
  let release!: () => void;
  let reached!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const reachedP = new Promise<void>((r) => {
    reached = r;
  });
  const result = invoke(
    {
      ...deps,
      beforeCommit: async (name) => {
        if (name !== op) return;
        reached();
        await gate;
      },
    },
    op,
    input,
    { actor: actor as never, origin: { surface: "test" } },
  );
  // A call refused before it reaches the commit releases the waiter too.
  result.catch(() => reached());
  return { result, reached: reachedP, release };
}

const refusalOf = (p: Promise<unknown>) => refusal(p);

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

  it("tells the owner about later questions and replies once per burst, only when nobody is watching (criterion 8)", async () => {
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
    // One notice for the burst: the question's; the reply right after it adds none.
    expect(questionNotes).toBe(1);
    expect(replyNotes).toBe(0);
    // Two minutes on, a reply notifies again.
    await rows(
      "UPDATE core_planning_sessions SET notified_at = ? WHERE work_item_id = ?",
      new Date(Date.now() - 3 * 60_000).toISOString(),
      id,
    );
    await agent("chat.reply", { text: "Revised." });
    expect(await outboxCount("notify", `"planning.reply"`, id)).toBe(1);

    await ok("planning.presence", { workItemId: id, open: true }, w.human);
    await agent("question.ask", { questions: [{ prompt: "Third?" }] });
    await agent("chat.reply", { text: "Asked one more." });
    expect(await outboxCount("notify", `"planning.question"`, id)).toBe(questionNotes);
    expect(await outboxCount("notify", `"planning.reply"`, id)).toBe(1);
  });

  it("puts a steer on a planning run in the chat, read once the host takes it, and not again as news (criterion 9)", async () => {
    const w = await world();
    const { item, agent, job, m5 } = await planning(w);
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
    type View = { messages: { text: string; deliveredAt: string | null }[] };
    const view = await ok<View>("planning.get", { workItemId: item.workItemId }, w.human);
    expect(view.messages).toEqual([
      expect.objectContaining({ text: "Skip the export button.", deliveredAt: null }),
    ]);
    await ok("run.takeSteers", { jobId: job.jobId, fencingToken: job.lease.fencingToken }, m5);
    const taken = await ok<View>("planning.get", { workItemId: item.workItemId }, w.human);
    expect(taken.messages[0]?.deliveredAt).toEqual(expect.any(String));
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

  it("interrupts a working planner with the factory's own line, never the person's words (criterion 10)", async () => {
    const w = await world();
    const { item, job, m5, agent } = await planning(w);
    await agent("planning.news", { activity: "reading the repo" }); // working
    const sent = await ok<{ interrupted: boolean }>(
      "chat.send",
      { workItemId: item.workItemId, text: "Stop, use tabs.", interrupt: true },
      w.human,
    );
    expect(sent.interrupted).toBe(true);
    const taken = await ok<{ steers: { text: string; interrupt?: boolean }[] }>(
      "run.takeSteers",
      { jobId: job.jobId, fencingToken: job.lease.fencingToken },
      m5,
    );
    expect(taken.steers).toEqual([
      expect.objectContaining({ interrupt: true, text: expect.stringContaining("interrupted") }),
    ]);
    expect(taken.steers[0]?.text).not.toContain("tabs");
    // The message itself arrives as news.
    const news = await agent<PlanningNews>("planning.news");
    expect(news.events).toEqual([
      expect.objectContaining({ type: "chat.message", text: "Stop, use tabs." }),
    ]);

    // An idle planner isn't interrupted: its Stop hook wakes it.
    await agent("planning.wait", { timeoutMs: 0 });
    const idle = await ok<{ interrupted: boolean; note: string | null }>(
      "chat.send",
      { workItemId: item.workItemId, text: "And a header.", interrupt: true },
      w.human,
    );
    expect(idle).toMatchObject({
      interrupted: false,
      note: expect.stringContaining("isn't mid-step"),
    });
  });

  it("delivers an interrupt after the current step when the runner can't interrupt (criterion 10)", async () => {
    const w = await world();
    const { item, agent } = await planning(w);
    await agent("planning.news", { activity: "reading the repo" });
    await rows(
      "UPDATE core_runners SET manifest = ? WHERE id IN (SELECT runner_id FROM core_runs WHERE work_item_id = ?)",
      JSON.stringify({ ...manifest, capabilities: ["hooks", "steer"] }),
      item.workItemId,
    );
    const sent = await ok<{ interrupted: boolean; note: string | null }>(
      "chat.send",
      { workItemId: item.workItemId, text: "Use tabs.", interrupt: true },
      w.human,
    );
    expect(sent).toMatchObject({
      interrupted: false,
      note: expect.stringContaining("can't interrupt"),
    });
    const view = await ok<{ session: { canInterrupt: boolean } }>(
      "planning.get",
      { workItemId: item.workItemId },
      w.human,
    );
    expect(view.session.canInterrupt).toBe(false);
  });

  it("stops the current step without ending the session, and a paused planner isn't woken until resumed (criterion 11)", async () => {
    const w = await world();
    const { item, job, m5, agent } = await planning(w);
    await agent("planning.news", { activity: "revising the spec" });
    expect(await ok("planning.stop", { workItemId: item.workItemId }, w.human)).toMatchObject({
      stopped: true,
    });
    await agent("planning.wait", { timeoutMs: 0 });

    await ok("planning.pause", { workItemId: item.workItemId }, w.human);
    await ok("chat.send", { workItemId: item.workItemId, text: "While you're paused…" }, w.human);
    await new Promise((r) => setTimeout(r, 900));
    const paused = await agent<PlanningNews & { due: boolean }>("planning.wait", { timeoutMs: 0 });
    expect(paused.due).toBe(false);
    expect(
      (
        await ok<{ session: { paused: boolean } }>(
          "planning.get",
          { workItemId: item.workItemId },
          w.human,
        )
      ).session.paused,
    ).toBe(true);

    await ok("planning.resume", { workItemId: item.workItemId }, w.human);
    await new Promise((r) => setTimeout(r, 900));
    const resumed = await agent<PlanningNews & { due: boolean }>("planning.wait", { timeoutMs: 0 });
    expect(resumed.due).toBe(true);
    expect(resumed.events.map((e) => e.type)).toEqual(["chat.message", "planning.resumed"]);
    const session = await first<{ status: string }>(
      "SELECT status FROM core_planning_sessions WHERE work_item_id = ?",
      item.workItemId,
    );
    expect(session.status).not.toBe("ended");
    expect(job.jobId).toBeTruthy();
    expect(m5.type).toBe("runner");
  });

  it("lets a person answer planning questions from the desktop without a presence proof, and nothing else (owner decision 2026-11-12)", async () => {
    const w = await world();
    const { item, agent } = await planning(w);
    const { questionIds } = await agent<{ questionIds: string[] }>("question.ask", {
      questions: [
        { prompt: "Filename?", default: "deals.csv" },
        { prompt: "Header?", kind: "yes-no", default: "Yes" },
      ],
    });
    const as = (surface: "desktop" | "cli", op: string, input: unknown) =>
      invoke(deps, op, input, { actor: w.human, origin: { surface } });
    expect(
      await as("desktop", "planning.answer", { questionId: questionIds[0], answer: "export.csv" }),
    ).toMatchObject({ status: "ok" });
    expect(
      await as("desktop", "planning.acceptDefaults", { workItemId: item.workItemId }),
    ).toMatchObject({ status: "ok", output: { accepted: [questionIds[1]] } });
    // Not from a CLI token, and the generic question.answer still wants a presence proof.
    const cli = await as("cli", "planning.answer", {
      questionId: questionIds[0],
      answer: "x",
    }).catch((e: OperationError) => e);
    expect((cli as OperationError).code).toBe("forbidden");
    const generic = await as("desktop", "question.answer", {
      questionId: questionIds[0],
      answer: "y",
    }).catch((e: OperationError) => e);
    expect((generic as OperationError).code).toBe("forbidden");
    // Only a planning session's questions.
    const v1 = await ok<{ questionIds: string[] }>(
      "question.ask",
      { workItemId: item.workItemId, questions: [{ prompt: "Old-style?" }] },
      FOREMAN,
    );
    const outside = await as("desktop", "planning.answer", {
      questionId: v1.questionIds[0],
      answer: "z",
    }).catch((e: OperationError) => e);
    expect((outside as OperationError).code).toBe("invalid_input");
  });

  it("finishes alone on a person's standing instruction: bulk-acceptable defaults now and as asked, the rest waits (criterion 12)", async () => {
    const w = await world();
    const { item, m5, job, agent } = await planning(w);
    const { questionIds } = await agent<{ questionIds: string[] }>("question.ask", {
      questions: [
        { prompt: "Filename?", default: "deals.csv" },
        { prompt: "Who may export?", domain: "security", default: "Admins" },
        { prompt: "Drop the old table?", irreversible: true, default: "No" },
        { prompt: "Anything else?" },
      ],
    });
    const [filename, security, irreversible, noDefault] = questionIds as [
      string,
      string,
      string,
      string,
    ];
    // Only a person, and not from a CLI token or the planner.
    const cli = await invoke(
      deps,
      "planning.finishAlone",
      { workItemId: item.workItemId, on: true },
      { actor: w.human, origin: { surface: "cli" } },
    ).catch((e: OperationError) => e);
    expect((cli as OperationError).code).toBe("forbidden");
    expect(
      (
        await refusal(
          ok(
            "planning.finishAlone",
            { workItemId: item.workItemId, on: true, jobId: job.jobId },
            m5,
          ),
        )
      ).code,
    ).toBe("forbidden");

    const on = await ok<{ accepted: string[] }>(
      "planning.finishAlone",
      { workItemId: item.workItemId, on: true },
      w.human,
    );
    expect(on.accepted).toEqual([filename]);
    type View = {
      session: { finishAlone: { by: string; at: string } | null };
      questions: {
        id: string;
        status: string;
        acceptedAlone: boolean;
        answeredBy: string | null;
      }[];
    };
    let view = await ok<View>("planning.get", { workItemId: item.workItemId }, w.human);
    expect(view.session.finishAlone).toMatchObject({ by: w.userId });
    const byId = (id: string) => view.questions.find((q) => q.id === id);
    expect(byId(filename)).toMatchObject({
      status: "answered",
      acceptedAlone: true,
      answeredBy: w.userId,
    });
    for (const id of [security, irreversible, noDefault]) expect(byId(id)?.status).toBe("open");

    // The planner hears it, and a question it asks later is accepted as it's asked.
    const news = await agent<PlanningNews>("planning.news");
    expect(news.events).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "finish.alone", on: true })]),
    );
    const later = await agent<{ questionIds: string[] }>("question.ask", {
      questions: [
        { prompt: "Separator?", kind: "single-choice", options: [",", ";"], default: "," },
        { prompt: "Share with partners?", domain: "privacy", default: "No" },
      ],
    });
    view = await ok<View>("planning.get", { workItemId: item.workItemId }, w.human);
    expect(byId(later.questionIds[0] as string)).toMatchObject({
      status: "answered",
      acceptedAlone: true,
    });
    expect(byId(later.questionIds[1] as string)?.status).toBe("open");
    const later_news = await agent<PlanningNews>("planning.news");
    expect(later_news.events).toEqual([
      expect.objectContaining({
        type: "answer.submitted",
        questionId: later.questionIds[0],
        acceptedDefault: true,
      }),
    ]);

    // Changes requested at the gate turn it off.
    await ok(
      "planning.note",
      { workItemId: item.workItemId, note: "Say more.", by: w.userId },
      FOREMAN,
    );
    view = await ok<View>("planning.get", { workItemId: item.workItemId }, w.human);
    expect(view.session.finishAlone).toBeNull();
    const after = await agent<{ questionIds: string[] }>("question.ask", {
      questions: [{ prompt: "Encoding?", default: "UTF-8" }],
    });
    view = await ok<View>("planning.get", { workItemId: item.workItemId }, w.human);
    expect(byId(after.questionIds[0] as string)?.status).toBe("open");
  });

  it("never opens the gate with a person's word unread, whichever of the two commits first (review of #67, items 1 and A)", async () => {
    // The planner reads, then a person's message commits before the planner's batch: refused.
    {
      const w = await world();
      const { item, job, m5, agent } = await planning(w);
      await agent("spec.revise", SPEC);
      const ready = held(
        "planning.ready",
        { jobId: job.jobId, fencingToken: job.lease.fencingToken },
        m5,
      );
      await ready.reached;
      await ok("chat.send", { workItemId: item.workItemId, text: "Wait" }, w.human);
      ready.release();
      expect((await refusalOf(ready.result)).code).toBe("conflict");
      expect(await session(item.workItemId)).toMatchObject({ at_gate: 0 });
      await agent("planning.news");
      expect(await agent("planning.ready")).toMatchObject({ round: 1 });
    }
    // The person reads "not at the gate", then the planner's ask commits first: the message is
    // refused, and sent again it takes the spec back.
    {
      const w = await world();
      const { item, agent } = await planning(w);
      await agent("spec.revise", SPEC);
      const chat = held("chat.send", { workItemId: item.workItemId, text: "Wait" }, w.human);
      await chat.reached;
      await agent("planning.ready");
      chat.release();
      expect((await refusalOf(chat.result)).code).toBe("conflict");
      await ok("chat.send", { workItemId: item.workItemId, text: "Wait" }, w.human);
      expect(await session(item.workItemId)).toMatchObject({ round: 2, at_gate: 0 });
    }
  });

  it("lets an approval and a person's word at the gate race without losing either, in both orders (review of #67, item 2)", async () => {
    // The approver reads, then a person's message withdraws the gate: the approval is refused.
    {
      const w = await world();
      const { item, agent } = await planning(w);
      const { specId } = await agent<{ specId: string }>("spec.revise", SPEC);
      await agent("planning.ready");
      const gate = await openGate(item.workItemId, specId);
      const approve = held("spec.approve", { workItemId: item.workItemId }, w.human);
      await approve.reached;
      await ok("chat.send", { workItemId: item.workItemId, text: "Wait" }, w.human);
      approve.release();
      expect((await refusalOf(approve.result)).code).toBe("conflict");
      expect(await pendingAction(gate)).toEqual({ status: "rejected", decision: "withdrawn" });
    }
    // The person reads "pending", then the approval commits first: the message is refused, and sent
    // again it says the planner won't read it; nothing is withdrawn.
    {
      const w = await world();
      const { item, agent } = await planning(w);
      const { specId } = await agent<{ specId: string }>("spec.revise", SPEC);
      await agent("planning.ready");
      const gate = await openGate(item.workItemId, specId);
      const chat = held("chat.send", { workItemId: item.workItemId, text: "Wait" }, w.human);
      await chat.reached;
      await ok("spec.approve", { workItemId: item.workItemId }, w.human);
      chat.release();
      expect((await refusalOf(chat.result)).code).toBe("conflict");
      const again = await ok<{ note: string | null }>(
        "chat.send",
        { workItemId: item.workItemId, text: "Wait" },
        w.human,
      );
      expect(again.note).toContain("approved a moment ago");
      expect((await pendingAction(gate)).decision).toBe("approved");
      expect(await outboxCount("workflow.event", `"withdrawn"`, approvalEvent(gate))).toBe(0);
    }
  });

  it("keeps a paused planner paused when news arrives, even if it had yielded (review of #71, item 8)", async () => {
    const w = await world();
    const { item, agent } = await planning(w);
    await ok("planning.pause", { workItemId: item.workItemId }, w.human);
    await agent("planning.yield");
    await rows(
      "UPDATE core_planning_sessions SET status = 'yielded', current_job_id = NULL WHERE work_item_id = ?",
      item.workItemId,
    );
    const queued = () =>
      rows<{ id: string }>(
        "SELECT id FROM core_jobs WHERE work_item_id = ? AND stage = 'planning' AND status = 'queued'",
        item.workItemId,
      );
    await ok("chat.send", { workItemId: item.workItemId, text: "While paused" }, w.human);
    expect(await queued()).toHaveLength(0);
    await ok("planning.resume", { workItemId: item.workItemId }, w.human);
    expect(await queued()).toHaveLength(1);
  });

  it("takes interrupts, Stop, Pause and Resume only from a person in the app or on the desktop (review of #71, item 9)", async () => {
    const w = await world();
    const { item, agent } = await planning(w);
    await agent("planning.news", { activity: "reading the repo" });
    const cli = (op: string, input: Record<string, unknown>) =>
      invoke(deps, op, input, { actor: w.human, origin: { surface: "cli" } }).catch(
        (e: OperationError) => e,
      );
    const id = item.workItemId;
    for (const [op, input] of [
      ["chat.send", { workItemId: id, text: "now", interrupt: true }],
      ["planning.stop", { workItemId: id }],
      ["planning.pause", { workItemId: id }],
      ["planning.resume", { workItemId: id }],
    ] as const) {
      expect(((await cli(op, input)) as OperationError).code).toBe("forbidden");
    }
    // A plain message is still fine from a CLI.
    expect(await cli("chat.send", { workItemId: id, text: "fyi" })).toMatchObject({ status: "ok" });
  });

  it("merges queued interrupts and spaces them out (review of #71, item 9)", async () => {
    const w = await world();
    const { item, job, m5, agent } = await planning(w);
    await agent("planning.news", { activity: "reading the repo" });
    const send = (text: string) =>
      ok<{ interrupted: boolean; note: string | null }>(
        "chat.send",
        { workItemId: item.workItemId, text, interrupt: true },
        w.human,
      );
    expect((await send("one")).interrupted).toBe(true);
    expect((await send("two")).interrupted).toBe(true);
    const take = () =>
      ok<{ steers: { interrupt?: boolean }[] }>(
        "run.takeSteers",
        { jobId: job.jobId, fencingToken: job.lease.fencingToken },
        m5,
      );
    expect((await take()).steers.filter((s) => s.interrupt)).toHaveLength(1);
    const third = await send("three");
    expect(third).toMatchObject({
      interrupted: false,
      note: expect.stringContaining("a moment ago"),
    });
  });

  it("still asks for Touch ID on the desktop for security, privacy and irreversible planning answers (review of #71, item 10)", async () => {
    const w = await world();
    const { agent } = await planning(w);
    const { questionIds } = await agent<{ questionIds: string[] }>("question.ask", {
      questions: [
        { prompt: "Who may export?", domain: "security", default: "Admins" },
        { prompt: "Drop the table?", irreversible: true, default: "No" },
        { prompt: "Filename?", default: "deals.csv" },
      ],
    });
    const desktop = (questionId: string, answer: string) =>
      invoke(
        deps,
        "planning.answer",
        { questionId, answer },
        {
          actor: w.human,
          origin: { surface: "desktop" },
        },
      ).catch((e: OperationError) => e);
    expect(((await desktop(questionIds[0] as string, "Admins")) as OperationError).code).toBe(
      "forbidden",
    );
    expect(((await desktop(questionIds[1] as string, "No")) as OperationError).code).toBe(
      "forbidden",
    );
    expect(await desktop(questionIds[2] as string, "deals.csv")).toMatchObject({ status: "ok" });
  });

  it("can't be made deaf or blind by a forged cursor: an ack is clamped to what was handed out (review of #67, A)", async () => {
    const w = await world();
    const { item, job, m5, agent } = await planning(w);
    await agent("spec.revise", SPEC);
    await ok("chat.send", { workItemId: item.workItemId, text: "Read me" }, w.human);
    // Straight to the operation (as if the agent had the relay): a huge ack marks nothing read.
    const forged = await refusal(
      ok(
        "planning.ready",
        { ack: 999_999_999, jobId: job.jobId, fencingToken: job.lease.fencingToken },
        m5,
      ),
    );
    expect(forged.code).toBe("conflict");
    // A huge cursor doesn't move the session past the news either.
    const skipped = await agent<PlanningNews>("planning.news", { cursor: 999_999_999 });
    expect(skipped.events).toEqual([
      expect.objectContaining({ type: "chat.message", text: "Read me" }),
    ]);
    await ok("chat.send", { workItemId: item.workItemId, text: "And me" }, w.human);
    const next = await agent<PlanningNews>("planning.news");
    expect(next.events).toEqual([
      expect.objectContaining({ type: "chat.message", text: "And me" }),
    ]);
  });

  it("stamps a read receipt only on the answer revision that was handed out (review of #67, B)", async () => {
    const w = await world();
    const { item, agent } = await planning(w);
    const { questionIds } = await agent<{ questionIds: string[] }>("question.ask", {
      questions: [{ prompt: "Filename?" }],
    });
    const q = questionIds[0] as string;
    await ok("question.answer", { questionId: q, answer: "deals.csv" }, w.human);
    // A hook fetches v1 (hold) …
    const shown = await agent<PlanningNews>("planning.news", { hold: true });
    // … the person revises to v2 before the hook acknowledges v1.
    await ok("question.answer", { questionId: q, answer: "export.csv" }, w.human);
    await agent("planning.news", { hold: true, ack: shown.cursor });
    type View = { questions: { id: string; answerDeliveredAt: string | null }[] };
    const view = await ok<View>("planning.get", { workItemId: item.workItemId }, w.human);
    expect(view.questions.find((x) => x.id === q)?.answerDeliveredAt).toBeNull();
    // v2 is handed out and acknowledged: now it reads Read.
    const again = await agent<PlanningNews>("planning.news", { hold: true });
    await agent("planning.news", { hold: true, ack: again.cursor });
    const read = await ok<View>("planning.get", { workItemId: item.workItemId }, w.human);
    expect(read.questions.find((x) => x.id === q)?.answerDeliveredAt).not.toBeNull();
  });

  it("treats a domain however it is spelled: Security is security, everywhere (review of #71, C)", async () => {
    const w = await world();
    const { item, agent } = await planning(w);
    const { questionIds } = await agent<{ questionIds: string[] }>("question.ask", {
      questions: [
        { prompt: "Who sees exports?", domain: "Security", default: "Admins" },
        { prompt: "Keep emails?", domain: "Security & Privacy", default: "No" },
      ],
    });
    const domains = await rows<{ domain: string }>(
      "SELECT domain FROM core_questions WHERE work_item_id = ? ORDER BY number",
      item.workItemId,
    );
    expect(domains.map((d) => d.domain)).toEqual(["security", "security"]);
    const bulk = await ok<{ accepted: string[] }>(
      "planning.acceptDefaults",
      { workItemId: item.workItemId },
      w.human,
    );
    expect(bulk.accepted).toEqual([]);
    const desktop = await invoke(
      deps,
      "planning.answer",
      { questionId: questionIds[0], answer: "Admins" },
      { actor: w.human, origin: { surface: "desktop" } },
    ).catch((e: OperationError) => e);
    expect((desktop as OperationError).code).toBe("forbidden");
    // A domain off the list is refused, so a new spelling can't dodge the check.
    const odd = await refusal(
      agent("question.ask", { questions: [{ prompt: "?", domain: "sekurity" }] }),
    );
    expect(odd.code).toBe("invalid_input");
  });

  it("lets only someone who may answer the questions hand them to the planner (review of #71, E)", async () => {
    const w = await world();
    const { item, agent } = await planning(w);
    await agent("question.ask", { questions: [{ prompt: "Filename?", default: "deals.csv" }] });
    // A plain member, neither the assignee nor an approver.
    const memberId = uid("usr_");
    const now = new Date().toISOString();
    await rows(
      "INSERT INTO core_user (id, name, email, created_at, updated_at) VALUES (?, 'Sam', ?, ?, ?)",
      memberId,
      `${memberId}@example.com`,
      now,
      now,
    );
    await rows(
      "INSERT INTO core_member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'member', ?)",
      uid("mem_"),
      w.orgId,
      memberId,
      now,
    );
    const sam = { type: "human" as const, id: memberId };
    const refused = await refusal(
      ok("planning.finishAlone", { workItemId: item.workItemId, on: true }, sam),
    );
    expect(refused.code).toBe("forbidden");
  });

  it("doesn't answer in someone's name after they turned finish alone off, even racing (review of #71, F)", async () => {
    const w = await world();
    const { item, job, m5 } = await planning(w);
    await ok("planning.finishAlone", { workItemId: item.workItemId, on: true }, w.human);
    const ask = held(
      "question.ask",
      {
        jobId: job.jobId,
        fencingToken: job.lease.fencingToken,
        questions: [{ prompt: "Separator?", default: "," }],
      },
      m5,
    );
    await ask.reached;
    await ok("planning.finishAlone", { workItemId: item.workItemId, on: false }, w.human);
    ask.release();
    expect((await refusalOf(ask.result)).code).toBe("conflict");
  });

  it("answers the question the person saw, and reopens an answer when the question changes in kind (review of #71, G)", async () => {
    const w = await world();
    const { item, agent } = await planning(w);
    const { questionIds } = await agent<{ questionIds: string[] }>("question.ask", {
      questions: [{ prompt: "Keep logs?", kind: "yes-no", default: "Yes" }],
    });
    const q = questionIds[0] as string;
    const revisionOf = async () =>
      (await first<{ revision: number }>("SELECT revision FROM core_questions WHERE id = ?", q))
        .revision;
    const seen = await revisionOf();
    // The planner rewords it after the person read it.
    await agent("question.update", { questionId: q, patch: { prompt: "Keep logs for a year?" } });
    const stale = await refusal(
      ok("planning.answer", { questionId: q, answer: "Yes", questionRevision: seen }, w.human),
    );
    expect(stale.code).toBe("conflict");
    await ok(
      "planning.answer",
      { questionId: q, answer: "Yes", questionRevision: await revisionOf() },
      w.human,
    );
    // Now it becomes irreversible: the answer is reopened, for a person to give again.
    await agent("question.update", { questionId: q, patch: { irreversible: true } });
    const state = await first<{ status: string; answer: string | null }>(
      "SELECT status, answer FROM core_questions WHERE id = ?",
      q,
    );
    expect(state).toEqual({ status: "open", answer: null });
    void item;
  });

  it("commits one of two interrupts that race (review of #71, H)", async () => {
    const w = await world();
    const { item, agent } = await planning(w);
    await agent("planning.news", { activity: "reading the repo" });
    const first_ = held(
      "chat.send",
      { workItemId: item.workItemId, text: "one", interrupt: true },
      w.human,
    );
    await first_.reached;
    await ok("chat.send", { workItemId: item.workItemId, text: "two", interrupt: true }, w.human);
    first_.release();
    expect((await refusalOf(first_.result)).code).toBe("conflict");
    const steers = await rows<{ id: string }>(
      "SELECT id FROM core_run_steers WHERE work_item_id = ? AND interrupt = 1",
      item.workItemId,
    );
    expect(steers).toHaveLength(1);
  });
});
