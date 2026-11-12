// Spec 23 part A (ADR 0304 as amended 2026-11-12): the readiness pre-check. An item no person
// released (intake, an agent) whose request states no outcome or nothing checkable is parked in the
// Backlog with a needs-info marker and a question to its requester, and runs nothing; answering or
// editing the request re-runs the check and sends it on to where it was heading. A person's release
// is their judgement: never parked, only an ignorable hint.
import { describe, expect, it } from "vitest";
import { FOREMAN } from "../src/index.ts";
import { precheck } from "../src/readiness.ts";
import { first, ok, POLICY, refusal, rows, world } from "./helpers.ts";

const INTAKE = { type: "intake" as const, id: "github" };
const CLEAR =
  "Issues labelled factory become work items in the backlog. When a labelled issue is opened, an item should appear within a minute.";

type W = Awaited<ReturnType<typeof world>>;
const open = () => world({ ...POLICY, release: { agents: true } });
const fromIntake = (w: W, body: string, state = "queued") =>
  ok<{ workItemId: string; status: string; needsInfo?: { reason: string } }>(
    "workItem.create",
    { projectId: w.projectId, title: "Issues", body, state, requesterUserId: w.userId },
    INTAKE,
  );
const item = (id: string) =>
  first<{ status: string; needs_info: string | null; body: string; workflow_id: string }>(
    "SELECT status, needs_info, body, workflow_id FROM core_work_items WHERE id = ?",
    id,
  );
const questionsOf = (id: string) =>
  rows<{ id: string; status: string; assignee_user_id: string; prompt: string }>(
    "SELECT id, status, assignee_user_id, prompt FROM core_questions WHERE work_item_id = ? ORDER BY created_at",
    id,
  );

describe("the readiness pre-check (spec 23)", () => {
  it("wants a stated outcome and a checkable statement, or a parent", () => {
    expect(precheck({ title: "Dark mode", body: "", parentId: null })).toEqual({
      ok: false,
      missing: ["outcome", "check"],
    });
    expect(precheck({ title: "Issues", body: CLEAR, parentId: null })).toEqual({ ok: true });
    expect(precheck({ title: "x", body: "", parentId: "wi_parent" })).toEqual({ ok: true });
  });

  it("parks a thin request from intake without any run, asking its requester (criterion 1)", async () => {
    const w = await open();
    const created = await fromIntake(w, "dark mode pls");
    expect(created).toMatchObject({ status: "backlog", needsInfo: expect.any(Object) });
    const row = await item(created.workItemId);
    expect(row.status).toBe("backlog");
    expect(JSON.parse(row.needs_info ?? "{}")).toMatchObject({
      waitingOn: w.userId,
      source: "precheck",
      heading: "queued",
      missing: ["outcome", "check"],
    });
    const [q] = await questionsOf(created.workItemId);
    expect(q).toMatchObject({ status: "open", assignee_user_id: w.userId });
    expect(q?.prompt).toContain("what should be true when this is done");
    // Nothing ran: no stage beyond intake, no job.
    const jobs = await rows("SELECT id FROM core_jobs WHERE work_item_id = ?", created.workItemId);
    expect(jobs).toEqual([]);
    const view = await ok<{ item: { needsInfo: { reason: string } | null } }>(
      "workItem.get",
      { workItemId: created.workItemId },
      w.human,
    );
    expect(view.item.needsInfo?.reason).toContain("doesn't say");
  });

  it("goes on to where it was heading once the answer makes it clear, and asks again when it doesn't", async () => {
    const w = await open();
    const created = await fromIntake(w, "dark mode pls");
    const [q] = await questionsOf(created.workItemId);
    if (!q) throw new Error("expected a question");
    await ok("question.answer", { questionId: q.id, answer: "ok" }, w.human);
    const again = await item(created.workItemId);
    expect(again.status).toBe("backlog");
    const asked = await questionsOf(created.workItemId);
    expect(asked).toHaveLength(2);
    const second = asked[1];
    if (!second) throw new Error("expected a second question");
    await ok(
      "question.answer",
      {
        questionId: second.id,
        answer:
          "Every page follows the system theme. When the Mac is in dark mode, the app should show dark colours.",
      },
      w.human,
    );
    const resumed = await item(created.workItemId);
    expect(resumed.needs_info).toBeNull();
    expect(["queued", "running"]).toContain(resumed.status);
    expect(resumed.body).toContain("should show dark colours");
  });

  it("re-checks when the request is edited, and lets a person move a parked item on", async () => {
    const w = await open();
    const a = await fromIntake(w, "dark mode pls", "ready");
    await ok("workItem.update", { workItemId: a.workItemId, body: CLEAR }, w.human);
    const edited = await item(a.workItemId);
    expect(edited).toMatchObject({ status: "ready", needs_info: null });
    expect((await questionsOf(a.workItemId))[0]?.status).toBe("withdrawn");

    const b = await fromIntake(w, "dark mode pls");
    // An agent can't move it on; a person can, as their judgement.
    expect(
      (await refusal(ok("workItem.release", { workItemId: b.workItemId }, FOREMAN))).code,
    ).toBe("conflict");
    const released = await ok<{ status: string; hint?: string }>(
      "workItem.release",
      { workItemId: b.workItemId },
      w.human,
    );
    expect(released.status).toBe("queued");
    expect(released.hint).toContain("too thin");
    expect((await item(b.workItemId)).needs_info).toBeNull();
    expect((await questionsOf(b.workItemId))[0]?.status).toBe("withdrawn");
  });

  it("never parks what a person releases; it shows them a hint they can ignore", async () => {
    const w = await world();
    const created = await ok<{ workItemId: string; status: string; hint?: string }>(
      "workItem.create",
      { projectId: w.projectId, title: "Dark mode", body: "dark mode pls", state: "queued" },
      w.human,
    );
    expect(created.status).toBe("queued");
    expect(created.hint).toContain("no checkable statement");
    expect((await item(created.workItemId)).needs_info).toBeNull();
    const backlog = await ok<{ workItemId: string }>(
      "workItem.create",
      { projectId: w.projectId, title: "Dark mode", body: "dark mode pls" },
      w.human,
    );
    const view = await ok<{ item: { readinessHint: string | null } }>(
      "workItem.get",
      { workItemId: backlog.workItemId },
      w.human,
    );
    expect(view.item.readinessHint).toContain("too thin");
  });
});
