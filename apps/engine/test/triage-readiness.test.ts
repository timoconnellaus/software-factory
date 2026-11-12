// Spec 23 part B (Workflow v8, ADR 0304): triage scores readiness. A small item triage finds needs
// answers gets its questions without a spec stage and is re-triaged on the answers; a medium one
// opens planning with them already asked; a not-actionable one is parked in the Backlog for its
// requester (no slot, no Workflow) and runs again on a new Workflow once answered.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { pullQueuedWork } from "../src/pull.ts";
import { all, first, itemStatus, ok, runStage, triage, waitFor, world } from "./helpers.ts";

const CLEAR =
  "Issues labelled factory become work items in the backlog. When a labelled issue is opened, an item should appear within a minute.";
const QUESTION = {
  prompt: "Which label marks an issue for the factory?",
  options: ["factory", "sf"],
  defaultAnswer: "factory",
};

type World = Awaited<ReturnType<typeof world>>;
const queued = (w: World, title: string) =>
  ok<{ workItemId: string }>(
    "workItem.create",
    { state: "queued", projectId: w.projectId, title, body: CLEAR },
    w.human,
  );
const openQuestion = (workItemId: string) =>
  waitFor("an open question", () =>
    first<{ id: string; planning_session_id: string | null; prompt: string }>(
      "SELECT id, planning_session_id, prompt FROM core_questions WHERE work_item_id = ? AND status = 'open'",
      workItemId,
    ),
  );

describe("triage's readiness (spec 23 part B)", () => {
  it("asks a small item's questions without a spec, then re-triages on the answers (criterion 2)", async () => {
    const w = await world();
    const item = await queued(w, "Small but unclear");
    await runStage(w, item.workItemId, "triage", () =>
      triage("small", {
        readiness: "needs_answers",
        readinessReason: "Which label?",
        questions: [QUESTION],
      }),
    );
    const q = await openQuestion(item.workItemId);
    expect(q.planning_session_id).toBeNull();
    await ok("question.answer", { questionId: q.id, answer: "sf" }, w.human);
    await runStage(w, item.workItemId, "triage", () => triage("small"));
    // No spec stage: the build is next.
    await waitFor("a build job", () =>
      first("SELECT id FROM core_jobs WHERE work_item_id = ? AND stage = 'build'", item.workItemId),
    );
    const decisions = await all<{ id: string }>(
      "SELECT id FROM core_audit WHERE operation = 'workItem.triage' AND work_item_id = ?",
      item.workItemId,
    );
    expect(decisions).toHaveLength(2);
  });

  it("opens planning with triage's questions already asked for a medium item (criterion 3)", async () => {
    const w = await world();
    const item = await queued(w, "Medium and unclear");
    await runStage(w, item.workItemId, "triage", () =>
      triage("medium", { readiness: "needs_answers", questions: [QUESTION] }),
    );
    const q = await openQuestion(item.workItemId);
    expect(q.planning_session_id).not.toBeNull();
    expect(q.prompt).toBe(QUESTION.prompt);
  });

  it("parks a not-actionable item for its requester, holding no slot, and runs again once answered (criteria 4, 6)", async () => {
    const w = await world();
    const item = await queued(w, "Unclear");
    await runStage(w, item.workItemId, "triage", () =>
      triage("small", {
        readiness: "not_actionable",
        readinessReason: "It doesn't say which issues",
        questions: [QUESTION],
      }),
    );
    await itemStatus(item.workItemId, "backlog");
    const parked = await first<{ needs_info: string; workflow_id: string }>(
      "SELECT needs_info, workflow_id FROM core_work_items WHERE id = ?",
      item.workItemId,
    );
    expect(JSON.parse(parked?.needs_info ?? "{}")).toMatchObject({ source: "triage" });
    expect(parked?.workflow_id).toBe(`${item.workItemId}-r2`);
    const q = await openQuestion(item.workItemId);
    await ok("question.answer", { questionId: q.id, answer: "factory" }, w.human);
    await pullQueuedWork(env);
    // Triage runs again, on the new generation, with the answer in the request.
    await runStage(w, item.workItemId, "triage", (job) => {
      expect(JSON.stringify(job)).toContain("factory");
      return triage("small");
    });
    await waitFor("a build job", () =>
      first("SELECT id FROM core_jobs WHERE work_item_id = ? AND stage = 'build'", item.workItemId),
    );
  });
});
