// job.claim's D1 queries per call (AGENTS.md "Cloudflare cost", rule 8): a claim reads its candidate
// jobs in one joined query, so its cost doesn't grow with the jobs it can't take. Every claim
// behaviour is covered by the existing claim tests; this counts the queries.
import { env } from "cloudflare:workers";
import { invoke } from "@software-factory/core";
import { beforeAll, describe, expect, it } from "vitest";
import { invokeDeps } from "../src/deps.ts";
import { all, MANIFEST, ok, uid, type World, waitFor, world } from "./helpers.ts";
import { type Recorded, recordingEnv } from "./query-plans.ts";

const QUEUED = 8;
let owner: World;
let stranger: World;

async function claimQueries(w: World): Promise<{ queries: number; job: unknown }> {
  const seen: Recorded[] = [];
  const result = await invoke<{ job: unknown }>(
    invokeDeps(recordingEnv(env, seen)),
    "job.claim",
    {
      claimId: uid("claim-"),
      manifest: MANIFEST,
      capacity: { max: 4, inUse: 0, accepting: true },
    },
    { actor: w.runnerActor, origin: { surface: "test" } },
  );
  return { queries: seen.length, job: result.status === "ok" ? result.output.job : null };
}

describe("job.claim queries per call", () => {
  beforeAll(async () => {
    owner = await world();
    stranger = await world();
    for (let i = 0; i < QUEUED; i++) {
      await ok(
        "workItem.create",
        { state: "queued", projectId: owner.projectId, title: `Queued ${i}` },
        owner.human,
      );
    }
    await waitFor(`${QUEUED} queued jobs`, async () => {
      const rows = await all(
        "SELECT 1 FROM core_jobs WHERE project_id = ? AND status = 'queued'",
        owner.projectId,
      );
      return rows.length >= QUEUED;
    });
  });

  it("a runner nobody shared into the project: a few queries, not a few per queued job", async () => {
    const { queries, job } = await claimQueries(stranger);
    expect(job).toBeNull();
    console.log(`claim by an unshared runner over ${QUEUED} queued jobs: ${queries} queries`);
    expect(queries).toBeLessThanOrEqual(8);
  });

  it("a kill switch on the project: likewise", async () => {
    await env.DB.prepare(
      `INSERT INTO core_kill_switches (scope, scope_id, is_on, changed_at, changed_by)
       VALUES ('project', ?, 1, ?, 'test')
       ON CONFLICT (scope, scope_id) DO UPDATE SET is_on = 1`,
    )
      .bind(owner.projectId, new Date().toISOString())
      .run();
    try {
      const { queries, job } = await claimQueries(owner);
      expect(job).toBeNull();
      console.log(`claim under a kill switch over ${QUEUED} queued jobs: ${queries} queries`);
      expect(queries).toBeLessThanOrEqual(8);
    } finally {
      await env.DB.prepare(
        "UPDATE core_kill_switches SET is_on = 0 WHERE scope = 'project' AND scope_id = ?",
      )
        .bind(owner.projectId)
        .run();
    }
  });

  it("the owner's runner still claims the oldest job", async () => {
    const { queries, job } = await claimQueries(owner);
    expect(job).toMatchObject({ workItem: expect.objectContaining({ title: "Queued 0" }) });
    console.log(`a successful claim: ${queries} queries`);
  });
});
