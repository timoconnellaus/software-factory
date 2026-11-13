// A plan gate the adjudicator approves goes through what a person's approval does (review of #130):
// the kept `.kim/` designs the gate shows are recorded so the commit writes them, and when a pulled
// file changed on the default branch the gate stays with its person, who is told why.
import {
  type CapabilityManifest,
  CONTRACT_VERSION,
  type Job,
} from "@software-factory/runner-contract";
import { describe, expect, it } from "vitest";
import type { Actor } from "../src/index.ts";
import { FOREMAN } from "../src/index.ts";
import {
  call,
  first,
  newItem,
  ok,
  POLICY,
  RUNNER_ACTOR,
  rows,
  services,
  uid,
  world,
} from "./helpers.ts";

const IMPROVER: Actor = { type: "self-improve", id: "improver" };
const manifest: CapabilityManifest = {
  contractVersion: CONTRACT_VERSION,
  runnerKind: "orca",
  harnesses: ["claude-code"],
  capabilities: ["hooks"],
};
type W = Awaited<ReturnType<typeof world>>;
const D2 = "app -> db: reads\napp -> queue: jobs\n";
const SPEC = {
  specMd: "# Export\n\n## Scope\n- Members see Export",
  acceptanceCriteria: ["Members see Export"],
};
const onMain = (w: W, path: string, content: string) =>
  services.github.commitFile(w.repo, { branch: "main", path, content, message: "seed" });

/** The adjudicator's record on spec gates: 20 approvals a person agreed with (ADR 0374). */
async function earned(w: W) {
  const now = new Date().toISOString();
  for (let i = 0; i < 20; i++) {
    const item = await newItem(w, uid("earned "));
    const pa = uid("pa_");
    await rows(
      `INSERT INTO core_pending_actions (id, org_id, project_id, work_item_id, kind, operation, risk, actor_type, actor_id, input, status, decision, created_at, decided_at)
       VALUES (?, ?, ?, ?, 'spec', 'spec.accept', 'write', 'agent', 'foreman', '{}', 'approved', 'approved', ?, ?)`,
      pa,
      w.orgId,
      w.projectId,
      item.workItemId,
      now,
      now,
    );
    await rows(
      `INSERT INTO core_adjudications (id, pending_action_id, project_id, work_item_id, kind, mode, job_id, verdict, reason, acted, created_at, decided_at)
       VALUES (?, ?, ?, ?, 'spec', 'shadow', ?, 'approve', 'fine', 0, ?, ?)`,
      uid("adj_"),
      pa,
      w.projectId,
      item.workItemId,
      uid("job_"),
      now,
      now,
    );
  }
}

async function planningAtGate(w: W, changeMainAfterGate: boolean, unassigned = false) {
  await onMain(w, ".kim/designs/system.d2", D2);
  const r = await ok<{ runnerId: string }>("runner.register", { name: "M5" }, w.human);
  const m5 = RUNNER_ACTOR(r.runnerId);
  const item = await newItem(w, "Add CSV export");
  await ok("branch.ensure", { workItemId: item.workItemId }, FOREMAN);
  await ok("planning.start", { workItemId: item.workItemId }, FOREMAN);
  const { job } = await ok<{ job: Job | null }>(
    "job.claim",
    {
      claimId: uid("claim-"),
      manifest,
      capacity: { max: 2, inUse: 0, accepting: true, light: { max: 6, inUse: 0 } },
    },
    m5,
  );
  if (!job) throw new Error("expected the planning job");
  const agent = <O = Record<string, unknown>>(op: string, input: Record<string, unknown> = {}) =>
    ok<O>(op, { ...input, jobId: job.jobId, fencingToken: job.lease.fencingToken }, m5);
  const pulled = await agent<{ artifactId: string }>("design.pull", {
    path: ".kim/designs/system.d2",
  });
  await agent("artifact.update", {
    artifactId: pulled.artifactId,
    content: `${D2}app -> cache: reads\n`,
  });
  const { specId } = await agent<{ specId: string }>("spec.revise", SPEC);
  await agent("planning.news");
  await agent("planning.ready");
  const gate = await call("spec.accept", { workItemId: item.workItemId, specId }, FOREMAN);
  if (gate.status !== "pending") throw new Error("expected the spec gate to wait");
  await earned(w);
  if (changeMainAfterGate)
    await onMain(w, ".kim/designs/system.d2", `${D2}app -> search: queries\n`);
  if (unassigned)
    await rows(
      "UPDATE core_pending_actions SET assignee_user_id = NULL WHERE id = ?",
      gate.pendingActionId,
    );
  // The adjudicator is asked and approves.
  await ok("adjudicator.request", { pendingActionId: gate.pendingActionId }, IMPROVER);
  const a = await first<{ job_id: string }>(
    "SELECT job_id FROM core_adjudications WHERE pending_action_id = ?",
    gate.pendingActionId,
  );
  await rows(
    `INSERT INTO core_runs (id, job_id, work_item_id, run_no, stage, runner_id, branch, base_branch,
       fencing_token, status, result, started_at)
     VALUES (?, ?, ?, 99, 'verify', 'rnr_x', 'b', 'main', 1, 'handed_back', ?, ?)`,
    uid("run_"),
    a.job_id,
    item.workItemId,
    JSON.stringify({ verdict: "approve", reason: "Matches the brief" }),
    new Date().toISOString(),
  );
  const recorded = await ok<{ status: string }>(
    "adjudicator.record",
    { pendingActionId: gate.pendingActionId },
    IMPROVER,
  );
  return { item, specId, gate: gate.pendingActionId, recorded };
}

describe("an adjudicator-approved plan gate (review of #130)", () => {
  it("records the kept designs, so the commit writes them", async () => {
    const w = await world({ ...POLICY, adjudicator: { spec: "active" } });
    const { item, specId, gate, recorded } = await planningAtGate(w, false);
    expect(recorded.status).toBe("approved");
    const pa = await first<{ status: string }>(
      "SELECT status FROM core_pending_actions WHERE id = ?",
      gate,
    );
    expect(pa.status).toBe("approved");
    const spec = await first<{ kim_files: string | null }>(
      "SELECT kim_files FROM core_specs WHERE id = ?",
      specId,
    );
    expect(spec.kim_files).toContain(".kim/designs/system.d2");
    await rows("UPDATE core_specs SET status = 'approved' WHERE id = ?", specId);
    await ok("spec.commit", { workItemId: item.workItemId }, FOREMAN);
    const branch = (
      await first<{ branch: string }>(
        "SELECT branch FROM core_work_items WHERE id = ?",
        item.workItemId,
      )
    ).branch;
    expect(await services.github.readFile(w.repo, ".kim/designs/system.d2", branch)).toContain(
      "app -> cache",
    );
  });

  it("leaves the gate to its person, and tells them, when a pulled file changed since", async () => {
    const w = await world({ ...POLICY, adjudicator: { spec: "active" } });
    const { gate, recorded } = await planningAtGate(w, true);
    expect(recorded.status).toBe("recorded");
    const pa = await first<{ status: string; assignee_user_id: string }>(
      "SELECT status, assignee_user_id FROM core_pending_actions WHERE id = ?",
      gate,
    );
    expect(pa.status).toBe("pending");
    const adjudication = await first<{ acted: number; verdict: string }>(
      "SELECT acted, verdict FROM core_adjudications WHERE pending_action_id = ?",
      gate,
    );
    expect(adjudication).toMatchObject({ acted: 0, verdict: "approve" });
    const told = await rows<{ payload: string }>(
      "SELECT payload FROM core_outbox WHERE kind = 'notify' AND instr(payload, 'adjudicator.blocked') > 0 AND instr(payload, ?) > 0",
      pa.assignee_user_id,
    );
    expect(told).toHaveLength(1);
    expect(told[0]?.payload).toContain(".kim/designs/system.d2");
  });

  it("tells the project's first approver when the gate has no assignee (review of #144)", async () => {
    const w = await world({ ...POLICY, adjudicator: { spec: "active" } });
    const { recorded } = await planningAtGate(w, true, true);
    expect(recorded.status).toBe("recorded");
    const told = await rows<{ payload: string }>(
      "SELECT payload FROM core_outbox WHERE kind = 'notify' AND instr(payload, 'adjudicator.blocked') > 0 AND instr(payload, ?) > 0",
      w.userId,
    );
    expect(told).toHaveLength(1);
  });
});
