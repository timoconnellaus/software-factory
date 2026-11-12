// Spec 27 (ADR 0471): people edit the plan and comment on its parts. The planner keeps a person's
// wording word for word, records the answers an edit settles, and hears comments with their quote.
import type { CapabilityManifest, Job, PlanningNews } from "@software-factory/runner-contract";
import { CONTRACT_VERSION } from "@software-factory/runner-contract";
import { describe, expect, it } from "vitest";
import { FOREMAN, invoke } from "../src/index.ts";
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

/** Runs an operation held after its reads, before its commit, until released (deterministic races). */
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
  result.catch(() => reached());
  return { result, reached: reachedP, release };
}

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
        { prompt: "Who may file them?", domain: "security", default: "Members" },
        {
          kind: "single-choice",
          prompt: "Where do they land?",
          options: ["The project's inbox", "Backlog"],
          default: "The project's inbox",
        },
      ],
    });
    const [who, where] = questionIds as [string, string];
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

  const LINE = "- New items land in the inbox of the project that owns the repository [Q2]";
  const EDITED = "- New items land in the Backlog of the project that owns the repository [Q2]";
  const edit = (
    w: W,
    workItemId: string,
    specId: string,
    before = LINE,
    after = EDITED,
    line = 4,
  ) =>
    ok<{ specId: string; editId: string }>(
      "spec.edit",
      { workItemId, specId, lineStart: line, lineEnd: line, before, after },
      w.human,
    );

  it("doesn't lose a person's edit to a revision racing it, in either order (review of #85, 5)", async () => {
    // The planner reads, the person's edit commits, then the planner's revision: refused.
    {
      const w = await world();
      const { item, job, m5, agent } = await planning(w);
      const { specId } = await agent<{ specId: string }>("spec.revise", SPEC);
      const revise = held(
        "spec.revise",
        { ...SPEC, summary: "racing", jobId: job.jobId, fencingToken: job.lease.fencingToken },
        m5,
      );
      await revise.reached;
      await edit(w, item.workItemId, specId);
      revise.release();
      expect((await refusal(revise.result)).code).toBe("conflict");
      expect((await current(item.workItemId)).body_md).toContain("Backlog");
    }
    // The person reads, the planner's revision commits, then the edit: refused, nothing changed.
    {
      const w = await world();
      const { item, agent } = await planning(w);
      const { specId } = await agent<{ specId: string }>("spec.revise", SPEC);
      const e = held(
        "spec.edit",
        {
          workItemId: item.workItemId,
          specId,
          lineStart: 4,
          lineEnd: 4,
          before: LINE,
          after: EDITED,
        },
        w.human,
      );
      await e.reached;
      await agent("spec.revise", { ...SPEC, summary: "meanwhile" });
      e.release();
      expect((await refusal(e.result)).code).toBe("conflict");
      expect((await current(item.workItemId)).body_md).not.toContain("Backlog");
    }
  });

  it("refuses an edit once the plan is approved (review of #85, 2)", async () => {
    const w = await world();
    const { item, agent } = await planning(w);
    const { specId } = await agent<{ specId: string }>("spec.revise", SPEC);
    await agent("planning.ready");
    const gate = await call("spec.accept", { workItemId: item.workItemId, specId }, FOREMAN);
    if (gate.status !== "pending") throw new Error("expected the spec gate");
    await ok("spec.approve", { workItemId: item.workItemId }, w.human);
    const late = await refusal(edit(w, item.workItemId, specId));
    expect(late.code).toBe("conflict");
    expect(late.message).toContain("approved");
  });

  it("keeps a person's wording block for block: appended text, a short edit inside another block, and a deletion (review of #85, 1 and 3)", async () => {
    const w = await world();
    const { item, agent } = await planning(w);
    const { specId } = await agent<{ specId: string }>("spec.revise", SPEC);
    await edit(w, item.workItemId, specId);
    await agent("planning.news");
    // The planner keeps the words but adds its own to the block: refused.
    const appended = await refusal(
      agent("spec.revise", { ...SPEC, specMd: BODY.replace(LINE, `${EDITED}, except on Fridays`) }),
    );
    expect(appended.code).toBe("conflict");
    // A deletion: kept while the line stays out, refused when it comes back.
    const now = await current(item.workItemId);
    await ok(
      "spec.edit",
      {
        workItemId: item.workItemId,
        specId: now.id,
        lineStart: 3,
        lineEnd: 3,
        before: "- Only issues with the factory label come in [Q1]",
        after: "",
      },
      w.human,
    );
    await agent("planning.news");
    const without = BODY.replace(LINE, EDITED).replace(
      "- Only issues with the factory label come in [Q1]\n",
      "",
    );
    expect(await agent("spec.revise", { ...SPEC, specMd: without })).toMatchObject({});
    const back = await refusal(
      agent("spec.revise", { ...SPEC, specMd: BODY.replace(LINE, EDITED) }),
    );
    expect(back.code).toBe("conflict");
  });

  it("retires an edit a later one covers, and lets a person release one (review of #85, 1)", async () => {
    const w = await world();
    const { item, agent } = await planning(w);
    const { specId } = await agent<{ specId: string }>("spec.revise", SPEC);
    const first_ = await edit(w, item.workItemId, specId);
    // Someone rewrites the block holding the first edit: the first no longer stands.
    const now = await current(item.workItemId);
    const second = await edit(
      w,
      item.workItemId,
      now.id,
      EDITED,
      "- New items land in the project's Backlog, unreleased [Q2]",
    );
    const standing = await rows<{ id: string }>(
      "SELECT id FROM core_spec_edits WHERE work_item_id = ? AND replaced_by IS NULL AND released_at IS NULL",
      item.workItemId,
    );
    expect(standing.map((e) => e.id)).toEqual([second.editId]);
    expect(first_.editId).not.toBe(second.editId);
    // Released: the planner may reword it.
    await ok("spec.releaseEdit", { workItemId: item.workItemId, editId: second.editId }, w.human);
    await agent("planning.news");
    expect(await agent("spec.revise", SPEC)).toMatchObject({});
  });

  it("lets a person release an edit the plan can no longer keep, so the gate isn't held forever (review of #85, round 2)", async () => {
    const w = await world();
    const { item, agent } = await planning(w);
    const { specId } = await agent<{ specId: string }>("spec.revise", SPEC);
    const label = "- Only issues with the sf label come in [Q1]";
    const where = "- New items land in the project's Backlog [Q2]";
    const a = await ok<{ specId: string; editId: string }>(
      "spec.edit",
      {
        workItemId: item.workItemId,
        specId,
        lineStart: 3,
        lineEnd: 4,
        before: BODY.split("\n").slice(3, 5).join("\n"),
        after: `${label}\n${where}`,
      },
      w.human,
    );
    // Someone rewrites half of it: the first edit isn't covered, and the plan can't keep it.
    await ok(
      "spec.edit",
      {
        workItemId: item.workItemId,
        specId: a.specId,
        lineStart: 3,
        lineEnd: 3,
        before: label,
        after: "- Only issues with the agent label come in [Q1]",
      },
      w.human,
    );
    await agent("planning.news");
    const held = await refusal(agent("planning.ready"));
    expect(held.code).toBe("conflict");
    const view = await ok<{ edits: { id: string; kept: boolean }[] }>(
      "planning.get",
      { workItemId: item.workItemId },
      w.human,
    );
    expect(view.edits.find((e) => e.id === a.editId)?.kept).toBe(false);
    await ok("spec.releaseEdit", { workItemId: item.workItemId, editId: a.editId }, w.human);
    await agent("planning.news");
    expect(await agent("planning.ready")).toMatchObject({ round: 1 });
  });

  it("records an answer from an edit only when it still stands, is newest, is about the question, and its author may answer (review of #85, 4)", async () => {
    const w = await world();
    const { item, agent } = await planning(w);
    const { questionIds } = await agent<{ questionIds: string[] }>("question.ask", {
      questions: [
        { prompt: "Which label?", default: "factory" },
        {
          kind: "single-choice",
          prompt: "Where do they land?",
          options: ["The project's inbox", "Backlog"],
          default: "The project's inbox",
        },
      ],
    });
    const [label, where] = questionIds as [string, string];
    const { specId } = await agent<{ specId: string }>("spec.revise", SPEC);
    const { editId } = await edit(w, item.workItemId, specId);
    // Not about Q1: the edited line carries [Q2], not [Q1].
    expect(
      (await refusal(agent("question.answerFromEdit", { questionId: label, answer: "sf", editId })))
        .code,
    ).toBe("conflict");
    // Answered directly after the edit: the edit is stale.
    await ok("question.answer", { questionId: where, answer: "The project's inbox" }, w.human);
    const stale = await refusal(
      agent("question.answerFromEdit", { questionId: where, answer: "Backlog", editId }),
    );
    expect(stale.code).toBe("conflict");
    expect(stale.message).toContain("answered after");
  });

  it("refuses an edit that cites an open question as decided (review of #85, 8)", async () => {
    const w = await world();
    const { item, agent } = await planning(w);
    await agent("question.ask", { questions: [{ prompt: "Which label?" }, { prompt: "Where?" }] });
    const { specId } = await agent<{ specId: string }>("spec.revise", {
      ...SPEC,
      specMd: `${BODY}\n- Edits after release are ignored [assumption]`,
    });
    const refused = await refusal(
      edit(
        w,
        item.workItemId,
        specId,
        "- Edits after release are ignored [assumption]",
        "- Edits after release are ignored [Q2]",
        5,
      ),
    );
    expect(refused.code).toBe("invalid_input");
    expect(refused.message).toContain("Q2");
  });

  it("never answers an assigned question in the name of an unassigned member who edited the plan (review of #85, 4)", async () => {
    const w = await world();
    const { item, agent } = await planning(w);
    const { questionIds } = await agent<{ questionIds: string[] }>("question.ask", {
      questions: [
        { prompt: "Which label?" },
        {
          kind: "single-choice",
          prompt: "Where do they land?",
          options: ["The project's inbox", "Backlog"],
        },
      ],
    });
    const { specId } = await agent<{ specId: string }>("spec.revise", SPEC);
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
    const { editId } = await ok<{ editId: string }>(
      "spec.edit",
      {
        workItemId: item.workItemId,
        specId,
        lineStart: 4,
        lineEnd: 4,
        before: LINE,
        after: EDITED,
      },
      { type: "human", id: memberId },
    );
    const refused = await refusal(
      agent("question.answerFromEdit", { questionId: questionIds[1], answer: "Backlog", editId }),
    );
    expect(refused.code).toBe("forbidden");
  });
});
