// Spec 09 M4: the adjudicator earns gate approvals in shadow mode (ADR 0374).
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Actor } from "../src/index.ts";
import { call, FOREMAN, first, newItem, ok, POLICY, refusal, uid, world } from "./helpers.ts";

const IMPROVER: Actor = { type: "self-improve", id: "improver" };
const SHADOW = { ...POLICY, adjudicator: { step: "shadow" } };

type W = Awaited<ReturnType<typeof world>>;

/** A workflow gate step waiting for a person on a new work item. */
async function openGate(w: W) {
  const item = await newItem(w, uid("gate "));
  const r = await call(
    "workflow.gate",
    { workItemId: item.workItemId, workflow: "W", stepId: "design", name: "Design sign-off" },
    FOREMAN,
  );
  if (r.status !== "pending") throw new Error("expected the gate to wait");
  return { workItemId: item.workItemId, pendingActionId: r.pendingActionId };
}

/** Plays the runner: the adjudicator's job hands back this verdict. */
async function handBack(pendingActionId: string, result: unknown) {
  const a = await first<{ job_id: string; work_item_id: string }>(
    "SELECT job_id, work_item_id FROM core_adjudications WHERE pending_action_id = ?",
    pendingActionId,
  );
  await env.DB.prepare(
    `INSERT INTO core_runs (id, job_id, work_item_id, run_no, stage, runner_id, branch, base_branch,
       fencing_token, status, result, started_at)
     VALUES (?, ?, ?, 1, 'verify', 'rnr_x', 'b', 'main', 1, 'handed_back', ?, ?)`,
  )
    .bind(uid("run_"), a.job_id, a.work_item_id, JSON.stringify(result), new Date().toISOString())
    .run();
}

describe("the adjudicator in shadow mode", () => {
  it("is asked about a gate step, records its verdict, and never changes the outcome", async () => {
    const w = await world(SHADOW);
    const gate = await openGate(w);
    const asked = await ok<{ adjudicationId: string | null }>(
      "adjudicator.request",
      { pendingActionId: gate.pendingActionId },
      IMPROVER,
    );
    expect(asked.adjudicationId).toBeTruthy();
    const job = await first<{ stage: string; role: string; context: string }>(
      "SELECT stage, role, context FROM core_jobs WHERE id = (SELECT job_id FROM core_adjudications WHERE id = ?)",
      asked.adjudicationId,
    );
    expect(job).toMatchObject({ stage: "verify", role: "review" });
    expect(JSON.parse(job.context)).toMatchObject({ adjudicate: { kind: "step" } });

    const waiting = await ok<{ status: string }>(
      "adjudicator.record",
      { pendingActionId: gate.pendingActionId },
      IMPROVER,
    );
    expect(waiting.status).toBe("waiting");
    await handBack(gate.pendingActionId, { verdict: "approve", reason: "Looks right" });
    const recorded = await ok<{ status: string; verdict: string }>(
      "adjudicator.record",
      { pendingActionId: gate.pendingActionId },
      IMPROVER,
    );
    expect(recorded).toMatchObject({ status: "recorded", verdict: "approve" });
    const pa = await first<{ status: string }>(
      "SELECT status FROM core_pending_actions WHERE id = ?",
      gate.pendingActionId,
    );
    expect(pa.status).toBe("pending");
  });

  it("isn't asked when it's off, and never about a merge or a config change", async () => {
    const off = await world();
    const gate = await openGate(off);
    const none = await ok<{ adjudicationId: string | null; reason: string }>(
      "adjudicator.request",
      { pendingActionId: gate.pendingActionId },
      IMPROVER,
    );
    expect(none).toMatchObject({ adjudicationId: null, reason: expect.stringMatching(/off/) });

    const w = await world({ ...SHADOW, adjudicator: { spec: "shadow", step: "shadow" } });
    const loosen = await call(
      "config.save",
      {
        projectId: w.projectId,
        baseVersion: Number(w.policySha.slice(1)),
        policy: { ...SHADOW, approvers: ["x"] },
      },
      w.human,
    );
    if (loosen.status !== "pending") throw new Error("expected pending");
    const config = await ok<{ adjudicationId: string | null }>(
      "adjudicator.request",
      { pendingActionId: loosen.pendingActionId },
      IMPROVER,
    );
    expect(config.adjudicationId).toBeNull();
  });
});

describe("going active", () => {
  it("is refused until it has 20 decisions at 95%", async () => {
    const w = await world(SHADOW);
    const r = await call(
      "config.save",
      {
        projectId: w.projectId,
        baseVersion: Number(w.policySha.slice(1)),
        policy: { ...SHADOW, adjudicator: { step: "active" } },
      },
      w.human,
    );
    // Active loosens, so it waits for an approver; approving it is refused: not earned.
    if (r.status !== "pending") throw new Error("expected pending");
    const refused = await refusal(
      call(
        "approval.decide",
        { pendingActionId: r.pendingActionId, decision: "approved" },
        w.human,
      ),
    );
    expect(refused.code).toBe("conflict");
    expect(refused.message).toMatch(/hasn't earned/);
  });

  it("approves a gate once earned, and still leaves a person every gate it defers", async () => {
    const w = await world(SHADOW);
    // 20 gates where its approve matched the person's approval.
    for (let i = 0; i < 20; i++) {
      const g = await openGate(w);
      await ok("adjudicator.request", { pendingActionId: g.pendingActionId }, IMPROVER);
      await handBack(g.pendingActionId, { verdict: "approve", reason: "fine" });
      await ok("adjudicator.record", { pendingActionId: g.pendingActionId }, IMPROVER);
      await ok(
        "approval.decide",
        { pendingActionId: g.pendingActionId, decision: "approved" },
        w.human,
      );
    }
    const stats = await ok<{ step: { decisions: number; precision: number; eligible: boolean } }>(
      "adjudicator.stats",
      { projectId: w.projectId },
      w.human,
    );
    expect(stats.step).toMatchObject({ decisions: 20, precision: 1, eligible: true });

    const current = Number(
      (
        await first<{ policy_sha: string }>(
          "SELECT policy_sha FROM core_projects WHERE id = ?",
          w.projectId,
        )
      ).policy_sha.slice(1),
    );
    const save = await call(
      "config.save",
      {
        projectId: w.projectId,
        baseVersion: current,
        policy: { ...SHADOW, adjudicator: { step: "active" } },
      },
      w.human,
    );
    if (save.status !== "pending") throw new Error("expected pending");
    await ok(
      "approval.decide",
      { pendingActionId: save.pendingActionId, decision: "approved" },
      w.human,
    );

    const g = await openGate(w);
    await ok("adjudicator.request", { pendingActionId: g.pendingActionId }, IMPROVER);
    await handBack(g.pendingActionId, { verdict: "approve", reason: "Matches the spec" });
    const acted = await ok<{ status: string }>(
      "adjudicator.record",
      { pendingActionId: g.pendingActionId },
      IMPROVER,
    );
    expect(acted.status).toBe("approved");
    const pa = await first<{ status: string; decided_by: string; note: string }>(
      "SELECT status, decided_by, note FROM core_pending_actions WHERE id = ?",
      g.pendingActionId,
    );
    expect(pa).toMatchObject({ status: "approved", decided_by: "improver" });
    expect(pa.note).toMatch(/Adjudicator: Matches the spec/);

    // A defer never decides.
    const d = await openGate(w);
    await ok("adjudicator.request", { pendingActionId: d.pendingActionId }, IMPROVER);
    await handBack(d.pendingActionId, { verdict: "defer", reason: "Needs a person" });
    const deferred = await ok<{ status: string }>(
      "adjudicator.record",
      { pendingActionId: d.pendingActionId },
      IMPROVER,
    );
    expect(deferred.status).toBe("recorded");
    const still = await first<{ status: string }>(
      "SELECT status FROM core_pending_actions WHERE id = ?",
      d.pendingActionId,
    );
    expect(still.status).toBe("pending");
  });
});
