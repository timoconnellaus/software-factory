import { describe, expect, it } from "vitest";
import { approvalEvent, FOREMAN, questionsEvent } from "../src/index.ts";
import { call, first, newItem, ok, POLICY, refusal, rows, uid, world } from "./helpers.ts";

describe("intake", () => {
  it("creates once per event, ignores a redelivery, and attaches a new event with the same dedupe key", async () => {
    // An intake may create and release only where the config lets agents release (ADR 0441).
    const w = await world({ ...POLICY, release: { agents: true } });
    const event = {
      projectId: w.projectId,
      title: "Fix login",
      source: "github",
      dedupeKey: `github:o/r#${uid("")}`,
    };
    const one = await ok<{ workItemId: string; outcome: string }>(
      "workItem.create",
      { state: "queued", ...event, eventId: "d1" },
      {
        type: "intake",
        id: "github",
      },
    ).catch(() => null);
    // Intake must name a requester.
    expect(one).toBeNull();
    const intake = { type: "intake" as const, id: "github" };
    const created = await ok<{ workItemId: string; outcome: string }>(
      "workItem.create",
      { state: "queued", ...event, eventId: "d1", requesterUserId: w.userId },
      intake,
    );
    expect(created.outcome).toBe("created");
    const again = await ok<{ workItemId: string; outcome: string }>(
      "workItem.create",
      { state: "queued", ...event, eventId: "d1", requesterUserId: w.userId },
      intake,
    );
    expect(again).toMatchObject({ workItemId: created.workItemId, outcome: "duplicate" });
    const attached = await ok<{ workItemId: string; outcome: string }>(
      "workItem.create",
      { state: "queued", ...event, eventId: "d2", body: "a comment", requesterUserId: w.userId },
      intake,
    );
    expect(attached).toMatchObject({ workItemId: created.workItemId, outcome: "attached" });
    expect(
      await rows("SELECT id FROM core_work_items WHERE project_id = ?", w.projectId),
    ).toHaveLength(1);
    const starts = await rows(
      "SELECT id FROM core_outbox WHERE kind = 'workflow.create' AND payload LIKE ?",
      `%${created.workItemId}%`,
    );
    expect(starts).toHaveLength(1);
    // The Workflow id is the work item id, not derived from the dedupe key.
    const item = await first<{ workflow_id: string; branch: string; number: number }>(
      "SELECT workflow_id, branch, number FROM core_work_items WHERE id = ?",
      created.workItemId,
    );
    expect(item.workflow_id).toBe(created.workItemId);
    expect(item.branch).toBe(`factory/${item.number}-fix-login`);
  });

  it("numbers work items per project", async () => {
    const w = await world();
    const a = await newItem(w, "First thing");
    const b = await newItem(w, "Second thing");
    expect([a.number, b.number]).toEqual([1, 2]);
    expect(b.branch).toBe("factory/2-second-thing");
  });
});

describe("triage", () => {
  it("skips the spec for small work and journals the decision with its reason", async () => {
    const w = await world();
    const item = await newItem(w);
    const out = await ok<{ specRequired: boolean; reason: string }>(
      "workItem.triage",
      {
        workItemId: item.workItemId,
        result: { size: "small", reason: "a one-line change", acceptanceCriteria: ["It works"] },
      },
      FOREMAN,
    );
    expect(out.specRequired).toBe(false);
    const row = await first<{ spec_required: number; spec_decision_reason: string }>(
      "SELECT spec_required, spec_decision_reason FROM core_work_items WHERE id = ?",
      item.workItemId,
    );
    expect(row.spec_required).toBe(0);
    expect(row.spec_decision_reason).toMatch(/below the spec threshold.*one-line change/);
    const audit = await first<{ result: string }>(
      "SELECT result FROM core_audit WHERE operation = 'workItem.triage' AND work_item_id = ?",
      item.workItemId,
    );
    expect(JSON.parse(audit.result)).toMatchObject({ specRequired: false });
  });

  it("keeps the spec gate when the foreman asks to skip it but policy requires one", async () => {
    const w = await world();
    const item = await newItem(w);
    const out = await ok<{ specRequired: boolean }>(
      "workItem.triage",
      {
        workItemId: item.workItemId,
        result: { size: "medium", reason: "two screens", specRequested: "skip" },
      },
      FOREMAN,
    );
    expect(out.specRequired).toBe(true);
  });
});

describe("the spec gate and questions", () => {
  async function specItem() {
    const w = await world();
    const item = await newItem(w);
    await ok(
      "workItem.triage",
      { workItemId: item.workItemId, result: { size: "medium", reason: "x" } },
      FOREMAN,
    );
    const spec = await ok<{ specId: string }>(
      "spec.propose",
      {
        workItemId: item.workItemId,
        spec: { specMd: "# Spec", acceptanceCriteria: ["A", "B"], assumptions: [] },
      },
      FOREMAN,
    );
    return { w, item, spec };
  }

  it("opens a spec gate an approver decides once; a second tap reports it was already decided", async () => {
    const { w, item, spec } = await specItem();
    const pending = await call(
      "spec.accept",
      { workItemId: item.workItemId, specId: spec.specId },
      FOREMAN,
    );
    expect(pending.status).toBe("pending");
    const id = pending.status === "pending" ? pending.pendingActionId : "";
    const first_ = await ok<{ alreadyDecided: boolean }>(
      "spec.approve",
      { workItemId: item.workItemId },
      w.human,
    );
    expect(first_.alreadyDecided).toBe(false);
    const second = await ok<{ alreadyDecided: boolean }>(
      "spec.approve",
      { workItemId: item.workItemId },
      w.human,
    );
    expect(second.alreadyDecided).toBe(true);
    expect(
      (
        await refusal(
          call("spec.requestChanges", { workItemId: item.workItemId, note: "no" }, w.human),
        )
      ).code,
    ).toBe("conflict");
    const event = await rows<{ payload: string }>(
      "SELECT payload FROM core_outbox WHERE kind = 'workflow.event' AND payload LIKE ?",
      `%${approvalEvent(id)}%`,
    );
    expect(event).toHaveLength(1);
    const gate = await first<{ gate_open_ms: number; decided_by: string }>(
      "SELECT gate_open_ms, decided_by FROM core_pending_actions WHERE id = ?",
      id,
    );
    expect(gate.decided_by).toBe(w.userId);
    expect(gate.gate_open_ms).toBeGreaterThanOrEqual(0);

    // The approved re-run applies it, once.
    const applied = await call(
      "spec.accept",
      { workItemId: item.workItemId, specId: spec.specId },
      FOREMAN,
      { approvalId: id },
    );
    expect(applied.status).toBe("ok");
    const reused = await refusal(
      call("spec.accept", { workItemId: item.workItemId, specId: spec.specId }, FOREMAN, {
        approvalId: id,
      }),
    );
    expect(reused.code).toBe("bad_approval");
  });

  it("refuses spec approval from someone who isn't an approver", async () => {
    const { item } = await specItem();
    const error = await refusal(
      call("spec.approve", { workItemId: item.workItemId }, { type: "human", id: uid("usr_") }),
    );
    expect(error.code).toBe("forbidden");
  });

  it("closes a planning round when the last blocking question is answered; accept-defaults skips security and irreversible ones", async () => {
    const { w, item } = await specItem();
    const asked = await ok<{ questionIds: string[] }>(
      "question.ask",
      {
        workItemId: item.workItemId,
        questions: [
          { prompt: "Dark by default?", defaultAnswer: "No", recommendation: "No" },
          { prompt: "Store the theme in a cookie?", domain: "security", defaultAnswer: "Yes" },
          { prompt: "Drop the old theme table?", irreversible: true, defaultAnswer: "Yes" },
        ],
      },
      FOREMAN,
    );
    const round = await ok<{ round: number; open: number; event: string }>(
      "workItem.awaitQuestions",
      { workItemId: item.workItemId },
      FOREMAN,
    );
    expect(round.open).toBe(3);
    expect(round.event).toBe(questionsEvent(item.workItemId, round.round));
    const bulk = await ok<{
      accepted: string[];
      skipped: { id: string }[];
      roundComplete: boolean;
    }>("question.acceptDefaults", { workItemId: item.workItemId }, w.human);
    expect(bulk.accepted).toEqual([asked.questionIds[0]]);
    expect(bulk.skipped.map((s) => s.id)).toEqual(asked.questionIds.slice(1));
    expect(bulk.roundComplete).toBe(false);
    await ok(
      "question.answer",
      { questionId: asked.questionIds[1], answer: "No, use localStorage" },
      w.human,
    );
    const last = await ok<{ roundComplete: boolean }>(
      "question.answer",
      { questionId: asked.questionIds[2], answer: "No" },
      w.human,
    );
    expect(last.roundComplete).toBe(true);
    const events = await rows(
      "SELECT id FROM core_outbox WHERE payload LIKE ?",
      `%${round.event}%`,
    );
    expect(events).toHaveLength(1);
    expect(
      (
        await refusal(
          call("question.answer", { questionId: asked.questionIds[2], answer: "x" }, w.human),
        )
      ).code,
    ).toBe("conflict");
  });

  it("escalates timed-out gates to the backup owner without deciding them", async () => {
    const { item, spec } = await specItem();
    const pending = await call(
      "spec.accept",
      { workItemId: item.workItemId, specId: spec.specId },
      FOREMAN,
    );
    const id = pending.status === "pending" ? pending.pendingActionId : "";
    const out = await ok<{ escalated: boolean }>("gate.escalate", { pendingActionId: id }, FOREMAN);
    expect(out.escalated).toBe(true);
    const gate = await first<{ status: string; escalations: number }>(
      "SELECT status, escalations FROM core_pending_actions WHERE id = ?",
      id,
    );
    expect(gate).toEqual({ status: "pending", escalations: 1 });
  });

  it("sending back from review opens a factory incident as a new work item, but not for an incident", async () => {
    const w = await world();
    const item = await newItem(w);
    await call(
      "pr.merge",
      { workItemId: item.workItemId, headSha: "abcdef1", touchesFactoryConfig: false },
      FOREMAN,
    );
    const out = await ok<{ incidentId: string | null }>(
      "review.sendBack",
      { workItemId: item.workItemId, note: "Missing tests", openedFullDiff: true },
      w.human,
    );
    expect(out.incidentId).toMatch(/^inc_/);
    const fix = await first<{ kind: string; parent_work_item_id: string; title: string }>(
      "SELECT w.kind, w.parent_work_item_id, w.title FROM core_incidents i JOIN core_work_items w ON w.id = i.fix_work_item_id WHERE i.id = ?",
      out.incidentId,
    );
    expect(fix).toMatchObject({ kind: "incident", parent_work_item_id: item.workItemId });
    const gate = await first<{ decision: string; opened_full_diff: number; note: string }>(
      "SELECT decision, opened_full_diff, note FROM core_pending_actions WHERE work_item_id = ?",
      item.workItemId,
    );
    expect(gate).toEqual({ decision: "sent_back", opened_full_diff: 1, note: "Missing tests" });
  });

  it("lists the gates and questions waiting on a person in their inbox", async () => {
    const { w, item, spec } = await specItem();
    await call("spec.accept", { workItemId: item.workItemId, specId: spec.specId }, FOREMAN);
    await ok(
      "question.ask",
      { workItemId: item.workItemId, questions: [{ prompt: "Colour?" }] },
      FOREMAN,
    );
    const inbox = await ok<{ gates: { kind: string }[]; questions: unknown[]; running: unknown[] }>(
      "inbox.list",
      {},
      w.human,
    );
    expect(inbox.gates.map((g) => g.kind)).toEqual(["spec"]);
    expect(inbox.questions).toHaveLength(1);
    expect(inbox.running).toHaveLength(1);
  });
});

describe("workItem.get for the app", () => {
  it("returns the policy the page needs, the approvers with their rule, and what the viewer may do", async () => {
    const w = await world({
      ...POLICY,
      reviewPacket: { sections: ["verdict", "criteria", "reviewer"] },
    });
    const item = await newItem(w);
    const got = await ok<{
      policy: { autonomyPolicy: string; specRequiredFrom: string; reviewPacketSections: string[] };
      approvers: { rule: string; users: { id: string; githubLogin: string | null }[] };
      viewer: { isApprover: boolean; isRequester: boolean };
    }>("workItem.get", { workItemId: item.workItemId }, w.human);
    expect(got.policy).toEqual({
      autonomyPolicy: "balanced",
      specRequiredFrom: "medium",
      reviewPacketSections: ["verdict", "criteria", "reviewer"],
    });
    expect(got.approvers.rule).toMatch(/owners and admins/);
    expect(got.approvers.users.map((u) => u.id)).toEqual([w.userId]);
    expect(got.viewer).toEqual({ isApprover: true, isRequester: true });
  });
});
