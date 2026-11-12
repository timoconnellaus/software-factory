// Workflow v5's spec stage is a planning session (spec 20, ADR 0300, 0350), end to end against real
// D1, the real Workflow and the PlanningHub, with the runner's side played by operation calls as
// the planning job's runner.
import type { Job, PlanningNews } from "@software-factory/runner-contract";
import { describe, expect, it } from "vitest";
import {
  all,
  build,
  first,
  gateOpen,
  github,
  MANIFEST,
  ok,
  runStage,
  triage,
  uid,
  waitFor,
  world,
} from "./helpers.ts";

type W = Awaited<ReturnType<typeof world>>;

const CAPACITY = { max: 2, inUse: 0, accepting: true, light: { max: 6, inUse: 0 } };

async function claimPlanning(w: W, workItemId: string): Promise<Job> {
  await waitFor("a queued planning job", () =>
    first(
      "SELECT id FROM core_jobs WHERE work_item_id = ? AND stage = 'planning' AND status = 'queued'",
      workItemId,
    ),
  );
  const { job } = await ok<{ job: Job | null }>(
    "job.claim",
    { claimId: uid("claim-"), manifest: MANIFEST, capacity: CAPACITY },
    w.runnerActor,
  );
  if (job?.stage !== "planning") throw new Error(`expected the planning job, got ${job?.stage}`);
  return job;
}

const agent = <O = Record<string, unknown>>(
  w: W,
  job: Job,
  op: string,
  input: Record<string, unknown> = {},
) => ok<O>(op, { ...input, jobId: job.jobId, fencingToken: job.lease.fencingToken }, w.runnerActor);

const SPEC = {
  specMd: [
    "# Add CSV export",
    "",
    "## Goal",
    "Export the deals list as CSV [request].",
    "",
    "## Scope",
    "- A streaming export [Q1]",
    "- Dates in ISO 8601 [assumption]",
  ].join("\n"),
  acceptanceCriteria: ["Members with deals:read see Export [Q1]", "Dates are ISO 8601"],
  assumptions: ["ISO 8601 dates in the org's time zone"],
  coverage: [
    { category: "scope", status: "clear" },
    { category: "ux", status: "partial", questions: [1] },
  ],
  clarifications: [{ question: 1, q: "Stream or email?", a: "Stream", date: "2026-11-12" }],
  summary: "first draft",
};

describe("Workflow v5: the planning session (spec 20)", () => {
  it("plans on its own, opens the gate on ready, takes a change request in the same session, and ends it on approval", async () => {
    const w = await world();
    const item = await ok<{ workItemId: string; branch: string }>(
      "workItem.create",
      { projectId: w.projectId, title: "Add CSV export" },
      w.human,
    );
    await runStage(w, item.workItemId, "triage", () => triage("medium"));

    // Criterion 1: one planning session, on a runner with a free light slot, with nobody looking.
    const job = await claimPlanning(w, item.workItemId);
    expect(job.planning?.resume).toBe(false);
    expect(job.harness.prompt).toContain("mcp__planning__");
    const asked = await agent<{ questionIds: string[] }>(w, job, "question.ask", {
      questions: [
        {
          kind: "single-choice",
          prompt: "Stream the download or email a link?",
          options: ["Stream", "Email a link"],
          default: "Stream",
          recommendation: "The reports page timeout is the original bug.",
        },
      ],
    });
    await agent(w, job, "spec.revise", SPEC);
    const idle = await agent<PlanningNews & { due: boolean }>(w, job, "planning.wait", {});
    expect(idle.due).toBe(false);
    const inbox = await ok<{ planning: { workItemId: string }[] }>("inbox.list", {}, w.human);
    expect(inbox.planning.map((p) => p.workItemId)).toContain(item.workItemId);
    const sessions = await all<{ id: string }>(
      "SELECT id FROM core_planning_sessions WHERE work_item_id = ?",
      item.workItemId,
    );
    expect(sessions).toHaveLength(1);

    // The person answers; the agent asks for the gate.
    await ok("question.answer", { questionId: asked.questionIds[0], answer: "Stream" }, w.human);
    await agent(w, job, "planning.news", {});
    await agent(w, job, "planning.ready", { note: "Ready" });
    await gateOpen(item.workItemId, "spec");

    // Criterion 10: request changes goes into the same session; no new session, no new job.
    await ok(
      "spec.requestChanges",
      { workItemId: item.workItemId, note: "Name the time zone" },
      w.human,
    );
    const note = await waitFor("the approver's note in the session", async () => {
      const news = await agent<PlanningNews>(w, job, "planning.news", {});
      return news.events.find((e) => e.type === "chat.message" && e.kind === "gate");
    });
    expect(note).toMatchObject({ text: "Name the time zone" });
    await agent(w, job, "spec.revise", {
      ...SPEC,
      specMd: `${SPEC.specMd}\n- The org's time zone [Q1]`,
      summary: "time zone named",
    });
    await agent(w, job, "planning.ready", {});
    await gateOpen(item.workItemId, "spec");
    expect(
      await all("SELECT id FROM core_planning_sessions WHERE work_item_id = ?", item.workItemId),
    ).toHaveLength(1);
    expect(
      await all(
        "SELECT id FROM core_jobs WHERE work_item_id = ? AND stage = 'planning'",
        item.workItemId,
      ),
    ).toHaveLength(1);

    // Approval ends the session and frees its slot; the build starts from the committed spec.
    await ok("spec.approve", { workItemId: item.workItemId }, w.human);
    await waitFor("the session ended", () =>
      first(
        "SELECT id FROM core_planning_sessions WHERE work_item_id = ? AND status = 'ended'",
        item.workItemId,
      ),
    );
    const run = await first<{ status: string }>(
      "SELECT status FROM core_runs WHERE job_id = ?",
      job.jobId,
    );
    expect(run?.status).toBe("cancelled");
    const fenced = await agent(w, job, "planning.news", {}).catch((e) => e);
    expect((fenced as { code?: string }).code).toBe("fenced");

    const built = await runStage(w, item.workItemId, "build", (b) => {
      // The approved spec's criteria reach the build.
      expect(b.harness.prompt).toContain("Members with deals:read see Export [Q1]");
      return build();
    });
    expect(built.stage).toBe("build");
    // Criterion 9: the committed spec keeps its tags and has the three sections.
    const committed = await first<{ path: string }>(
      "SELECT path FROM core_specs WHERE work_item_id = ? AND status = 'approved'",
      item.workItemId,
    );
    const state = await github.state(w.repo);
    const file = state.files[item.branch]?.[committed?.path ?? ""] ?? "";
    expect(file).toContain("[request]");
    expect(file).toContain("[assumption]");
    expect(file).toContain("## Assumptions");
    expect(file).toContain("## Coverage\n- scope: clear\n- ux: partial (Q1)");
    expect(file).toContain("## Clarifications\n- 2026-11-12 [Q1]: Stream or email? → Stream");
  }, 60_000);

  it("takes the spec back from the gate when a person writes, and the same session asks again (spec 26, criterion 3)", async () => {
    const w = await world();
    const item = await ok<{ workItemId: string }>(
      "workItem.create",
      { projectId: w.projectId, title: "Add CSV export" },
      w.human,
    );
    await runStage(w, item.workItemId, "triage", () => triage("medium"));
    const job = await claimPlanning(w, item.workItemId);
    await agent(w, job, "spec.revise", SPEC);
    await agent(w, job, "planning.ready", {});
    const first_ = await gateOpen(item.workItemId, "spec");

    // A person redirects while the spec waits at the gate: the gate is withdrawn.
    await ok(
      "chat.send",
      { workItemId: item.workItemId, text: "Actually, tab-separated." },
      w.human,
    );
    const withdrawn = await first<{ decision: string }>(
      "SELECT decision FROM core_pending_actions WHERE id = ?",
      first_.id,
    );
    expect(withdrawn?.decision).toBe("withdrawn");

    // The planner reads it, revises in the same session, and the Workflow opens a new gate.
    const news = await agent<PlanningNews>(w, job, "planning.news", {});
    expect(news.events).toEqual([
      expect.objectContaining({ type: "chat.message", text: "Actually, tab-separated." }),
    ]);
    await agent(w, job, "spec.revise", { ...SPEC, summary: "tab-separated" });
    await agent(w, job, "planning.ready", {});
    const second = await waitFor("a new spec gate", () =>
      first<{ id: string }>(
        "SELECT id FROM core_pending_actions WHERE work_item_id = ? AND kind = 'spec' AND status = 'pending' AND id != ?",
        item.workItemId,
        first_.id,
      ),
    );
    expect(second.id).not.toBe(first_.id);
    await ok("spec.approve", { workItemId: item.workItemId }, w.human);
    await waitFor("the session ended", () =>
      first(
        "SELECT id FROM core_planning_sessions WHERE work_item_id = ? AND status = 'ended'",
        item.workItemId,
      ),
    );
    expect(
      await all("SELECT id FROM core_planning_sessions WHERE work_item_id = ?", item.workItemId),
    ).toHaveLength(1);
  }, 60_000);

  it("ends the planning session when the spec is rejected, and when the item is cancelled", async () => {
    const w = await world();
    const item = await ok<{ workItemId: string }>(
      "workItem.create",
      { projectId: w.projectId, title: "Something else" },
      w.human,
    );
    await runStage(w, item.workItemId, "triage", () => triage("medium"));
    const job = await claimPlanning(w, item.workItemId);
    await ok("workItem.cancel", { workItemId: item.workItemId, reason: "not now" }, w.human);
    const session = await first<{ status: string }>(
      "SELECT status FROM core_planning_sessions WHERE work_item_id = ?",
      item.workItemId,
    );
    expect(session?.status).toBe("ended");
    const fenced = await agent(w, job, "planning.news", {}).catch((e) => e);
    expect((fenced as { code?: string }).code).toBe("fenced");
  }, 60_000);
});
