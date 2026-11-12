// Spec 09 M3: the improver trials practice changes and keeps what holds up (ADR 0373).
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  type Actor,
  draftCandidate,
  evaluateTrial,
  type ItemOutcome,
  parseFloor,
  parseProjectPolicy,
} from "../src/index.ts";
import { practiceOnlyError } from "../src/operations/improve.ts";
import { call, first, newItem, ok, POLICY, refusal, world } from "./helpers.ts";

const IMPROVER: Actor = { type: "self-improve", id: "improver" };
const ON = { ...POLICY, improve: { enabled: true, trialSize: 3 } };
const parsed = (doc: unknown) => {
  const p = parseProjectPolicy(JSON.stringify(doc));
  if (!p.ok) throw new Error(p.error);
  return p.policy;
};
const item = (over: Partial<ItemOutcome> = {}): ItemOutcome => ({
  id: "wi",
  policySha: "v1",
  trialId: null,
  done: true,
  rounds: 0,
  failingChecks: [],
  tokens: 1000,
  finishedAt: "2026-11-12T00:00:00.000Z",
  ...over,
});

describe("drafting a practice change", () => {
  it("tells the builder to run a check that keeps failing verify", () => {
    const recent = [
      item({ done: false, rounds: 2, failingChecks: ["lint"] }),
      item({ rounds: 1, failingChecks: ["lint", "tests"] }),
      item(),
      item(),
      item(),
    ];
    const c = draftCandidate(ON, parsed(ON), recent, []);
    expect(c?.kind).toBe("instructions");
    expect(c?.summary).toMatch(/lint/);
    const builder = ((c?.policy?.agents ?? []) as { name: string; instructions: string }[])[0];
    expect(builder).toMatchObject({ name: "Builder", role: "implement" });
    expect(builder?.instructions).toMatch(/run the project's lint/);
  });

  it("moves the builder to the light tier when recent work all passed first time", () => {
    const recent = Array.from({ length: 5 }, () => item());
    const c = draftCandidate(ON, parsed(ON), recent, []);
    expect(c).toMatchObject({ kind: "tier", summary: "Build on the light tier" });
    // Not again straight after it was tried and disabled.
    expect(draftCandidate(ON, parsed(ON), recent, ["Build on the light tier"])).toBeNull();
    // Not with too little to go on.
    expect(draftCandidate(ON, parsed(ON), recent.slice(0, 4), [])).toBeNull();
  });
});

describe("deciding a trial", () => {
  it("promotes when outcomes hold up and disables when they're worse", () => {
    const base = [item({ rounds: 1 }), item(), item({ done: false, rounds: 2 })];
    const good = [item(), item(), item()];
    const bad = [item({ rounds: 2 }), item({ done: false, rounds: 3 }), item()];
    expect(evaluateTrial(good, base, 3, false).decision).toBe("promote");
    expect(evaluateTrial(bad, base, 3, false).decision).toBe("disable");
    expect(evaluateTrial(good.slice(0, 2), base, 3, false).decision).toBe("wait");
    // After 14 days it decides on what there is.
    expect(evaluateTrial(good.slice(0, 2), base, 3, true).decision).toBe("promote");
    // With nothing to compare: every item done in at most one round.
    expect(evaluateTrial(good, [], 3, false).decision).toBe("promote");
    expect(evaluateTrial(bad, [], 3, false).decision).toBe("disable");
  });
});

describe("practice only (ADR 0373)", () => {
  const floor = parseFloor("");
  const builder = { name: "Builder", role: "implement", tier: "standard", instructions: "" };
  const base = { ...ON, agents: [builder] };
  it("allows a builder's tier and instructions, and adding the Builder", () => {
    expect(
      practiceOnlyError(
        parsed(base),
        parsed({ ...base, agents: [{ ...builder, tier: "light" }] }),
        floor,
      ),
    ).toBeNull();
    expect(practiceOnlyError(parsed(ON), parsed(base), floor)).toBeNull();
  });
  it("refuses anything else", () => {
    expect(practiceOnlyError(parsed(base), parsed({ ...base, wipLimit: 9 }), floor)).toMatch(
      /wipLimit/,
    );
    expect(
      practiceOnlyError(parsed(base), parsed({ ...base, autonomyPolicy: "autonomous" }), floor),
    ).toMatch(/autonomyPolicy/);
    expect(
      practiceOnlyError(
        parsed(base),
        parsed({ ...base, agents: [builder, { name: "Spy", role: "review" }] }),
        floor,
      ),
    ).toMatch(/only add the Builder/);
    expect(
      practiceOnlyError(
        parsed(base),
        parsed({ ...base, agents: [{ ...builder, role: "review" }] }),
        floor,
      ),
    ).toMatch(/tier and instructions/);
    expect(practiceOnlyError(parsed(base), parsed({ ...ON, agents: [] }), floor)).toMatch(/remove/);
  });
});

async function finish(workItemId: string, status: "done" | "failed" = "done") {
  await env.DB.prepare("UPDATE core_work_items SET status = ?, updated_at = ? WHERE id = ?")
    .bind(status, new Date().toISOString(), workItemId)
    .run();
}

describe("trials", () => {
  const candidate = (policy: Record<string, unknown>) => ({
    ...policy,
    agents: [{ name: "Builder", role: "implement", tier: "light", instructions: "" }],
  });

  it("is refused while self-improvement is off, and for anything but practice", async () => {
    const w = await world();
    const off = await refusal(
      call(
        "config.trial.start",
        {
          projectId: w.projectId,
          baseVersion: 2,
          kind: "tier",
          summary: "x",
          policy: candidate(POLICY),
        },
        IMPROVER,
      ),
    );
    expect(off.code).toBe("denied");
    const on = await world(ON);
    const sha = await first<{ policy_sha: string }>(
      "SELECT policy_sha FROM core_projects WHERE id = ?",
      on.projectId,
    );
    const base = Number(sha.policy_sha.slice(1));
    const loosen = await refusal(
      call(
        "config.trial.start",
        {
          projectId: on.projectId,
          baseVersion: base,
          kind: "tier",
          summary: "x",
          policy: { ...candidate(ON), autonomyPolicy: "autonomous" },
        },
        IMPROVER,
      ),
    );
    expect(loosen.code).toBe("forbidden");
  });

  it("runs the next items on the candidate, then promotes it when they hold up", async () => {
    const w = await world(ON);
    const base = Number(w.policySha.slice(1));
    const started = await ok<{ trialId: string; candidateVersion: number }>(
      "config.trial.start",
      {
        projectId: w.projectId,
        baseVersion: base,
        kind: "tier",
        summary: "Build on the light tier",
        policy: candidate(ON),
      },
      IMPROVER,
    );
    // The project stays on its version; the next 3 items join the trial.
    const items = [
      await newItem(w, "a"),
      await newItem(w, "b"),
      await newItem(w, "c"),
      await newItem(w, "d"),
    ];
    const rows = await Promise.all(
      items.map((i) =>
        first<{ policy_sha: string; trial_id: string | null }>(
          "SELECT policy_sha, trial_id FROM core_work_items WHERE id = ?",
          i.workItemId,
        ),
      ),
    );
    expect(rows.slice(0, 3).every((r) => r.trial_id === started.trialId)).toBe(true);
    expect(rows[0]?.policy_sha).toBe(`v${started.candidateVersion}`);
    expect(rows[3]).toMatchObject({ trial_id: null, policy_sha: w.policySha });

    // Not all finished: it waits.
    await finish(items[0]?.workItemId as string);
    const waiting = await ok<{ status: string }>(
      "config.trial.resolve",
      { projectId: w.projectId, trialId: started.trialId },
      IMPROVER,
    );
    expect(waiting.status).toBe("running");
    await finish(items[1]?.workItemId as string);
    await finish(items[2]?.workItemId as string);
    const decided = await ok<{ status: string; reason: string }>(
      "config.trial.resolve",
      { projectId: w.projectId, trialId: started.trialId },
      IMPROVER,
    );
    expect(decided.status).toBe("promoted");
    const project = await first<{ policy_sha: string }>(
      "SELECT policy_sha FROM core_projects WHERE id = ?",
      w.projectId,
    );
    expect(project.policy_sha).toBe(`v${started.candidateVersion}`);
    const listed = await ok<{ trials: { status: string; itemsSoFar: number }[] }>(
      "config.trials",
      { projectId: w.projectId },
      w.human,
    );
    expect(listed.trials[0]).toMatchObject({ status: "promoted", itemsSoFar: 3 });
  });

  it("disables a trial whose items did worse, or when a person stops it", async () => {
    const w = await world(ON);
    const base = Number(w.policySha.slice(1));
    const t = await ok<{ trialId: string }>(
      "config.trial.start",
      {
        projectId: w.projectId,
        baseVersion: base,
        kind: "tier",
        summary: "Build on the light tier",
        policy: candidate(ON),
      },
      IMPROVER,
    );
    for (const name of ["a", "b", "c"]) {
      const i = await newItem(w, name);
      await finish(i.workItemId, "failed");
    }
    const r = await ok<{ status: string; reason: string }>(
      "config.trial.resolve",
      { projectId: w.projectId, trialId: t.trialId },
      IMPROVER,
    );
    expect(r.status).toBe("disabled");
    const project = await first<{ policy_sha: string }>(
      "SELECT policy_sha FROM core_projects WHERE id = ?",
      w.projectId,
    );
    expect(project.policy_sha).toBe(w.policySha);

    const w2 = await world(ON);
    const t2 = await ok<{ trialId: string }>(
      "config.trial.start",
      {
        projectId: w2.projectId,
        baseVersion: Number(w2.policySha.slice(1)),
        kind: "tier",
        summary: "x",
        policy: candidate(ON),
      },
      IMPROVER,
    );
    const stopped = await ok<{ status: string }>(
      "config.trial.resolve",
      { projectId: w2.projectId, trialId: t2.trialId, stop: true },
      w2.human,
    );
    expect(stopped.status).toBe("disabled");
  });

  it("treats turning self-improvement on as loosening (a person's call)", async () => {
    const w = await world();
    const r = await call(
      "config.save",
      { projectId: w.projectId, baseVersion: Number(w.policySha.slice(1)), policy: ON },
      w.human,
    );
    expect(r.status).toBe("pending");
  });
});
