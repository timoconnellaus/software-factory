// The web terminal's operations (spec 35, ADR 0440): run.terminal.attach / detach / host, and
// run.live's `terminal` verdict.
import { env } from "cloudflare:workers";
import type { CapabilityManifest, Job } from "@software-factory/runner-contract";
import { CONTRACT_VERSION } from "@software-factory/runner-contract";
import { describe, expect, it } from "vitest";
import { FOREMAN } from "../src/index.ts";
import { first, newItem, ok, RUNNER_ACTOR, refusal, rows, uid, world } from "./helpers.ts";

const manifest = (capabilities: CapabilityManifest["capabilities"]): CapabilityManifest => ({
  contractVersion: CONTRACT_VERSION,
  runnerKind: "local",
  harnesses: ["claude-code"],
  capabilities,
});

async function running(capabilities: CapabilityManifest["capabilities"] = ["hooks", "terminal"]) {
  const w = await world();
  const runner = await ok<{ runnerId: string }>("runner.register", { name: "M5" }, w.human);
  const actor = RUNNER_ACTOR(runner.runnerId);
  const item = await newItem(w);
  await ok("branch.ensure", { workItemId: item.workItemId }, FOREMAN);
  await ok(
    "job.enqueue",
    { workItemId: item.workItemId, stage: "build", role: "implement", prompt: "Do it" },
    FOREMAN,
  );
  const { job } = await ok<{ job: Job | null }>(
    "job.claim",
    {
      claimId: uid("claim-"),
      manifest: manifest(capabilities),
      capacity: { max: 2, inUse: 0, accepting: true },
    },
    actor,
  );
  if (!job) throw new Error("no job");
  const live = await ok<{ run: { id: string } }>(
    "run.live",
    { workItemId: item.workItemId },
    w.human,
  );
  return { w, actor, item, job, runId: live.run.id };
}

async function member(orgId: string) {
  const id = uid("usr_");
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO core_user (id, name, email, created_at, updated_at) VALUES (?, 'Sam', ?, ?, ?)",
    ).bind(id, `${id}@example.com`, now, now),
    env.DB.prepare(
      "INSERT INTO core_member (id, organization_id, user_id, role, created_at) VALUES (?, ?, ?, 'member', ?)",
    ).bind(uid("mem_"), orgId, id, now),
  ]);
  return { type: "human" as const, id };
}

type Attach = { attachId: string; runId: string; jobId: string; mode: "type" | "watch" };
type Verdict = { terminal: { allowed: boolean; mode: string | null; reason: string | null } };

describe("the web terminal's operations", () => {
  it("lets the runner's owner type and everyone else in the org watch, and records each attach", async () => {
    const { w, item, job, runId } = await running();
    const watcher = await member(w.orgId);

    const mine = await ok<Verdict>("run.live", { workItemId: item.workItemId }, w.human);
    expect(mine.terminal).toEqual({ allowed: true, mode: "type", reason: null });
    const theirs = await ok<Verdict>("run.live", { workItemId: item.workItemId }, watcher);
    expect(theirs.terminal).toMatchObject({ allowed: true, mode: "watch" });
    expect(theirs.terminal.reason).toMatch(/runner's owner/);

    const owner = await ok<Attach>(
      "run.terminal.attach",
      { workItemId: item.workItemId, runId },
      w.human,
    );
    expect(owner).toMatchObject({ runId, jobId: job.jobId, mode: "type" });
    const watching = await ok<Attach>(
      "run.terminal.attach",
      { workItemId: item.workItemId, runId },
      watcher,
    );
    expect(watching.mode).toBe("watch");

    const recorded = await rows<{ user_id: string; mode: string; closed_at: string | null }>(
      "SELECT user_id, mode, closed_at FROM core_run_terminal_attaches WHERE run_id = ? ORDER BY opened_at, mode",
      runId,
    );
    expect(recorded).toEqual(
      expect.arrayContaining([
        { user_id: w.userId, mode: "type", closed_at: null },
        { user_id: watcher.id, mode: "watch", closed_at: null },
      ]),
    );
    // Journalled: an audit row per attach, naming the person.
    const audit = await rows<{ actor_id: string; outcome: string }>(
      "SELECT actor_id, outcome FROM core_audit WHERE operation = 'run.terminal.attach' AND work_item_id = ?",
      item.workItemId,
    );
    expect(audit.map((a) => a.actor_id).sort()).toEqual([w.userId, watcher.id].sort());

    // Detach stamps the close, once, and only for the attach's own person.
    expect(
      (
        await refusal(
          ok(
            "run.terminal.detach",
            { workItemId: item.workItemId, attachId: owner.attachId },
            watcher,
          ),
        )
      ).code,
    ).toBe("not_found");
    expect(
      await ok(
        "run.terminal.detach",
        { workItemId: item.workItemId, attachId: owner.attachId },
        w.human,
      ),
    ).toEqual({ closed: true });
    expect(
      await ok(
        "run.terminal.detach",
        { workItemId: item.workItemId, attachId: owner.attachId },
        w.human,
      ),
    ).toEqual({ closed: false });
    const closed = await first<{ closed_at: string | null }>(
      "SELECT closed_at FROM core_run_terminal_attaches WHERE id = ?",
      owner.attachId,
    );
    expect(closed.closed_at).not.toBeNull();

    // Someone outside the org can't attach.
    const stranger = { type: "human" as const, id: uid("usr_") };
    expect(
      (await refusal(ok("run.terminal.attach", { workItemId: item.workItemId, runId }, stranger)))
        .code,
    ).toMatch(/forbidden|not_found/);
  });

  it("refuses a runner without `terminal` and an ended run", async () => {
    const old = await running(["hooks", "steer"]);
    const view = await ok<Verdict>("run.live", { workItemId: old.item.workItemId }, old.w.human);
    expect(view.terminal).toMatchObject({ allowed: false, mode: null });
    expect(
      (
        await refusal(
          ok(
            "run.terminal.attach",
            { workItemId: old.item.workItemId, runId: old.runId },
            old.w.human,
          ),
        )
      ).code,
    ).toBe("unavailable");

    const { w, actor, item, job, runId } = await running();
    await ok(
      "run.release",
      { jobId: job.jobId, fencingToken: job.lease.fencingToken, finalState: "failed" },
      actor,
    );
    expect(
      (await refusal(ok("run.terminal.attach", { workItemId: item.workItemId, runId }, w.human)))
        .code,
    ).toBe("conflict");
    expect(
      (
        await refusal(
          ok(
            "run.terminal.host",
            { jobId: job.jobId, fencingToken: job.lease.fencingToken },
            actor,
          ),
        )
      ).code,
    ).toMatch(/conflict|fenced/);
  });

  it("answers the host's check for its own live job only, with the current fencing token", async () => {
    const { w, actor, item, job, runId } = await running();
    expect(
      await ok(
        "run.terminal.host",
        { jobId: job.jobId, fencingToken: job.lease.fencingToken },
        actor,
      ),
    ).toEqual({ runId, workItemId: item.workItemId });
    expect(
      (
        await refusal(
          ok(
            "run.terminal.host",
            { jobId: job.jobId, fencingToken: job.lease.fencingToken + 5 },
            actor,
          ),
        )
      ).code,
    ).toBe("fenced");
    const other = await ok<{ runnerId: string }>("runner.register", { name: "other" }, w.human);
    expect(
      (
        await refusal(
          ok(
            "run.terminal.host",
            { jobId: job.jobId, fencingToken: job.lease.fencingToken },
            RUNNER_ACTOR(other.runnerId),
          ),
        )
      ).code,
    ).toBe("forbidden");
  });
});
