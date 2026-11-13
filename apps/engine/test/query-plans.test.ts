// Every hot path's queries use an index (AGENTS.md, "Cloudflare cost", rule 1): each scenario runs a
// path through the real code against the migrated schema, and fails if any statement it ran plans a
// SCAN of a growing table. To guard another path, add a scenario to HOT_PATHS.
import { env } from "cloudflare:workers";
import {
  clearOrgConfigCache,
  FOREMAN,
  invoke,
  r2AttachmentBlobs,
  recentOutcomes,
  resolveScope,
  SCHEDULER,
  sweepStrayAttachmentBlobs,
} from "@software-factory/core";
import { SOFTWARE } from "@software-factory/core/stages";
import { createDb } from "@software-factory/db";
import { httpControlPlane, runnerChannelKey } from "@software-factory/runner-contract";
import { beforeAll, describe, expect, it } from "vitest";
import { archiveAudit } from "../src/audit-archive.ts";
import { invokeDeps } from "../src/deps.ts";
import worker, { pruneBabysit, pruneCheckResults } from "../src/index.ts";
import { deliverOutbox } from "../src/outbox.ts";
import { pruneReconcileShadow, SHADOW_LAG_MS, shadowPass } from "../src/reconcile-shadow.ts";
import { archiveRunEvents, pruneExpired, sampleArchive } from "../src/retention.ts";
import { github, MANIFEST, ok, uid, type World, waitFor, world } from "./helpers.ts";
import { growingScans, type Recorded, recordingEnv } from "./query-plans.ts";

let w: World;
let job: { jobId: string; fencingToken: number } | null = null;

async function channel(e: Env, runnerId: string) {
  return httpControlPlane({
    baseUrl: "https://sf-engine.example",
    runnerId,
    key: await runnerChannelKey("test-channel-secret", runnerId, 1),
    fetch: async (input, init) => worker.fetch(new Request(input, init), e),
  });
}

const as = (e: Env, op: string, input: unknown, actor: World["human"]) =>
  invoke(invokeDeps(e), op, input, { actor, origin: { surface: "test" } });

/** The latest past minute :17 (a future one would expire the test's live lease). */
function minute17(): number {
  const d = new Date();
  d.setUTCMinutes(17, 0, 0);
  return d.getTime() > Date.now() ? d.getTime() - 3_600_000 : d.getTime();
}

/**
 * A job's skills resolved at enqueue (the pinned org config by primary key, the needed skill versions
 * by primary key, without bodies), the list, a proposal, reading it and accepting it, and the
 * runner's read of a skill (`skill.forJob`: its job, run and lease by key, then the version).
 */
async function skillsScenario(e: Env) {
  const o = await world();
  const call = (op: string, input: unknown, actor: World["human"] = o.human) =>
    as(e, op, input, actor);
  const out = async <T>(op: string, input: unknown, actor?: World["human"]) => {
    const r = await call(op, input, actor);
    if (r.status !== "ok") throw new Error(`${op} is ${r.status}`);
    return r.output as T;
  };
  await out("agent.save", {
    orgId: o.orgId,
    baseVersion: 0,
    agent: { name: "Builder", role: "implement", tier: "standard", instructions: "" },
  });
  await out("skill.save", {
    orgId: o.orgId,
    baseVersion: 1,
    skill: { name: "Write a migration", description: "d", body: "b" },
  });
  const list = await out<{ skills: { id: string; builtin: boolean }[] }>("skill.list", {
    orgId: o.orgId,
  });
  const skillId = list.skills.find((x) => !x.builtin)?.id as string;
  await out("skill.attach", {
    orgId: o.orgId,
    baseVersion: 2,
    skillId,
    target: { agent: "Builder" },
  });
  // A second skill on the same agent: the enqueue reads two keys in one OR (review of #155).
  await out("skill.save", {
    orgId: o.orgId,
    baseVersion: 3,
    skill: { name: "Name the index", description: "d", body: "b" },
  });
  const second = (
    await out<{ skills: { id: string; builtin: boolean }[] }>("skill.list", { orgId: o.orgId })
  ).skills.find((x) => !x.builtin && x.id !== skillId)?.id as string;
  await out("skill.attach", {
    orgId: o.orgId,
    baseVersion: 4,
    skillId: second,
    target: { agent: "Builder" },
  });
  const ship = {
    ...SOFTWARE,
    id: "wf_ship",
    name: "Ship",
    stages: SOFTWARE.stages.map((x) => (x.id === "build" ? { ...x, agent: "Builder" } : x)),
  };
  await out("workflow.save", { orgId: o.orgId, baseVersion: 5, workflow: ship });
  const cfg = await out<{
    current: { version: number; policy: Record<string, unknown> | null } | null;
  }>("config.get", { projectId: o.projectId });
  await out("config.save", {
    projectId: o.projectId,
    baseVersion: cfg.current?.version ?? 0,
    policy: { ...(cfg.current?.policy ?? {}), workflow: "wf_ship", workflows: [], agents: [] },
  });
  const item = await out<{ workItemId: string }>("workItem.create", {
    state: "backlog",
    projectId: o.projectId,
    title: "Skilled",
  });
  await e.DB.prepare("UPDATE core_work_items SET org_config_version = 6 WHERE id = ?")
    .bind(item.workItemId)
    .run();
  await out(
    "job.enqueue",
    { workItemId: item.workItemId, stage: "build", role: "implement", prompt: "x", context: {} },
    FOREMAN as never,
  );
  // The factory proposes a change; a person reads it and accepts it.
  await out(
    "skill.propose",
    {
      projectId: o.projectId,
      skillId,
      skill: { name: "Write a migration", description: "d", body: "c" },
    },
    { type: "self-improve", id: "improver" } as never,
  );
  await out("skill.list", { orgId: o.orgId });
  const read = await out<{ version: { acceptHash: string } }>("skill.get", {
    orgId: o.orgId,
    skillId,
    version: 2,
  });
  await out("skill.accept", {
    orgId: o.orgId,
    baseVersion: 6,
    skillId,
    version: 2,
    acceptHash: read.version.acceptHash,
  });
  // The runner reads the job's skill: its run and lease, as a claim leaves them.
  const reg = await out<{ runnerId: string }>("runner.register", { name: "M5" });
  const runner = { type: "runner", id: reg.runnerId } as never;
  const job = await e.DB.prepare("SELECT id FROM core_jobs WHERE work_item_id = ?")
    .bind(item.workItemId)
    .first<{ id: string }>();
  if (!job) throw new Error("no job");
  const now = new Date().toISOString();
  await e.DB.batch([
    e.DB.prepare(
      `INSERT INTO core_runs (id, job_id, work_item_id, run_no, stage, runner_id, branch, base_branch,
         fencing_token, status, started_at) VALUES (?, ?, ?, 1, 'build', ?, 'b', 'main', 7, 'running', ?)`,
    ).bind(uid("run_"), job.id, item.workItemId, reg.runnerId, now),
    e.DB.prepare(
      `INSERT INTO core_leases (work_item_id, holder_kind, holder_id, fencing_token, claimed_at) VALUES (?, 'run', ?, 7, ?)
       ON CONFLICT (work_item_id) DO UPDATE SET fencing_token = 7, holder_kind = 'run', holder_id = excluded.holder_id`,
    ).bind(item.workItemId, job.id, now),
  ]);
  return out(
    "skill.forJob",
    { workItemId: item.workItemId, jobId: job.id, fencingToken: 7, slug: "write-a-migration" },
    runner,
  );
}

/** The registered hot paths: each runs once, then every statement it ran is EXPLAINed. */
const HOT_PATHS: { name: string; run: (e: Env) => Promise<unknown> }[] = [
  {
    // Spec 24: a split's parent waits for its children (each event, and once a day in its held
    // wait), by core_work_items_parent_idx (migration 0401).
    // Review of #171: a child's end (its siblings, and who waits for it), the release, and the
    // existing-children check at approval.
    name: "a split's child ends: its siblings and who waits for it",
    run: async (e) => {
      await e.DB.prepare(
        "SELECT * FROM core_work_items WHERE parent_work_item_id = ? AND source = 'planning' LIMIT 9",
      )
        .bind("wi_parent")
        .all();
      return e.DB.prepare(
        "SELECT work_item_id FROM core_work_item_links WHERE waits_for_id = ? AND work_item_id IN (?, ?)",
      )
        .bind("wi_child", "wi_a", "wi_b")
        .all();
    },
  },
  {
    name: "a split's release and its existing-children check",
    run: async (e) => {
      await e.DB.prepare(
        "SELECT id FROM core_work_items WHERE parent_work_item_id = ? AND source = 'planning' AND status = 'ready' LIMIT 8",
      )
        .bind("wi_parent")
        .all();
      return e.DB.prepare(
        "SELECT id FROM core_work_items WHERE parent_work_item_id = ? AND source = 'planning' LIMIT 1",
      )
        .bind("wi_parent")
        .all();
    },
  },
  {
    name: "a split's parent reads its children",
    run: (e) =>
      e.DB.prepare(
        "SELECT status FROM core_work_items WHERE parent_work_item_id = ? AND source = 'planning' LIMIT 9",
      )
        .bind("wi_parent")
        .all(),
  },
  {
    // The minute cron, on the minute that also sweeps attachment blobs and runs the improver.
    name: "the minute cron",
    run: (e) => worker.scheduled({ scheduledTime: minute17(), cron: "* * * * *", noRetry() {} }, e),
  },
  {
    name: "runner heartbeat (signed channel: authenticate, idempotency, operation)",
    run: async (e) =>
      (await channel(e, w.runner.runnerId)).heartbeat({
        manifest: MANIFEST,
        capacity: { max: 2, inUse: job ? 1 : 0, accepting: true },
        activeJobs: job ? [{ jobId: job.jobId, fencingToken: job.fencingToken }] : [],
      }),
  },
  {
    name: "job.claim with nothing to claim",
    run: async (e) =>
      (await channel(e, w.runner.runnerId)).claim({
        claimId: uid("claim-"),
        manifest: MANIFEST,
        capacity: { max: 2, inUse: 0, accepting: true },
      }),
  },
  {
    name: "job.claim with a queued job",
    run: async (e) => {
      await ok(
        "workItem.create",
        { state: "queued", projectId: w.projectId, title: "Plan me" },
        w.human,
      );
      return (await channel(e, w.runner.runnerId)).claim({
        claimId: uid("claim-"),
        manifest: MANIFEST,
        capacity: { max: 2, inUse: 0, accepting: true },
      });
    },
  },
  {
    name: "the held steer poll (run.takeSteers)",
    run: async (e) => {
      if (!job) return null;
      return (await channel(e, w.runner.runnerId)).steers?.(job.jobId, {
        fencingToken: job.fencingToken,
        waitMs: 0,
      });
    },
  },
  {
    // Spec 44 part A: the held steer call waits in the Worker, reading every HELD_POLL_MS whether
    // the run has a queued steer (core_run_steers_undelivered_idx). One poll at least.
    name: "the held steer call's poll (spec 44)",
    run: async (e) => {
      if (!job) return null;
      return (await channel(e, w.runner.runnerId)).steers?.(job.jobId, {
        fencingToken: job.fencingToken,
        waitMs: 3_500,
      });
    },
  },
  {
    // Spec 44 host ack: an acking host's held steer call, whose poll also skips steers on offer.
    name: "the held steer call's poll, for a host that acks (spec 44)",
    run: async (e) => {
      if (!job) return null;
      return (await channel(e, w.runner.runnerId)).steers?.(job.jobId, {
        fencingToken: job.fencingToken,
        waitMs: 3_500,
        ack: [],
      });
    },
  },
  {
    // Spec 44 host ack (review of #189): a take that acks a planning steer marks it, and its chat
    // message (core_planning_messages_steer_idx, migration 0410), delivered.
    name: "the steer call's ack of a planning steer (spec 44)",
    run: async (e) => {
      if (!job) return null;
      const run = await env.DB.prepare("SELECT id, work_item_id FROM core_runs WHERE job_id = ?")
        .bind(job.jobId)
        .first<{ id: string; work_item_id: string }>();
      if (!run) return null;
      const steerId = uid("st_");
      const at = new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO core_run_steers (id, run_id, work_item_id, author_user_id, text, created_at, offered_until, offers) VALUES (?, ?, ?, ?, 'hi', ?, ?, 1)",
        ).bind(steerId, run.id, run.work_item_id, w.human.id, at, at),
        env.DB.prepare(
          "INSERT INTO core_planning_messages (id, work_item_id, author_kind, author_id, text, steer_id, created_at) VALUES (?, ?, 'person', ?, 'hi', ?, ?)",
        ).bind(uid("pm_"), run.work_item_id, w.human.id, steerId, at),
      ]);
      return (await channel(e, w.runner.runnerId)).steers?.(job.jobId, {
        fencingToken: job.fencingToken,
        waitMs: 0,
        ack: [steerId],
      });
    },
  },
  {
    // Spec 44 part A: the held terminal call reads whether the run has an open attach
    // (core_run_terminal_attaches_open_idx), and asks the relay only when it does.
    name: "the held terminal call's poll (spec 44)",
    run: async (e) => {
      if (!job) return null;
      return (await channel(e, w.runner.runnerId)).terminal?.(job.jobId, {
        fencingToken: job.fencingToken,
        waitMs: 3_500,
      });
    },
  },
  {
    // Every planning call finds its session by the job. The test's job is dressed as a planning
    // run for the call, so the real lookup runs (and is refused: there is no session).
    name: "a planning call's session lookup",
    run: async (e) => {
      if (!job) return null;
      const stage = (sql: string) => env.DB.prepare(sql).bind(job?.jobId).run();
      const was = await env.DB.prepare("SELECT stage FROM core_runs WHERE job_id = ?")
        .bind(job.jobId)
        .first<string>("stage");
      await stage("UPDATE core_runs SET stage = 'planning' WHERE job_id = ?");
      try {
        return await as(e, "planning.wait", { ...job, timeoutMs: 0 }, w.runnerActor).catch(
          (error: { message?: string }) => {
            if (!/planning session is over/.test(error.message ?? "")) throw error;
          },
        );
      } finally {
        await env.DB.prepare("UPDATE core_runs SET stage = ? WHERE job_id = ?")
          .bind(was, job.jobId)
          .run();
      }
    },
  },
  {
    // Spec 44 part A3: the held planning wait polls planning.peek in the Worker (the session by its
    // job, the events after the cursor on (work_item_id, id), the open questions), every 3 s.
    name: "the held planning wait's poll (planning.peek, spec 44)",
    run: async (e) => {
      const item = await ok<{ workItemId: string }>(
        "workItem.create",
        { state: "queued", projectId: w.projectId, title: "Plan the guard" },
        w.human,
      );
      await ok("planning.start", { workItemId: item.workItemId }, FOREMAN);
      const c = await channel(env, w.runner.runnerId);
      let planningJob: { jobId: string; fencingToken: number } | null = null;
      for (let i = 0; i < 200 && !planningJob; i++) {
        const { job: got } = await c.claim({
          claimId: uid("claim-"),
          manifest: MANIFEST,
          capacity: { max: 4, inUse: 1, accepting: true, light: { max: 6, inUse: 0 } },
        });
        if (got?.stage === "planning") {
          planningJob = { jobId: got.jobId, fencingToken: got.lease.fencingToken };
        } else if (!got) await new Promise((r) => setTimeout(r, 50));
      }
      if (!planningJob) throw new Error("no planning job");
      return (await channel(e, w.runner.runnerId)).planning?.(planningJob.jobId, {
        fencingToken: planningJob.fencingToken,
        op: "planning.wait",
        input: { timeoutMs: 3_500 },
      });
    },
  },
  {
    // Spec 44 part B: the job line's call (the fenced run check, then a ticket from the relay).
    name: "the job line call (spec 44 part B)",
    run: async (e) => {
      if (!job) return null;
      return (await channel(e, w.runner.runnerId)).line?.(job.jobId, {
        fencingToken: job.fencingToken,
      });
    },
  },
  {
    // Spec 44 part B: delivering a run.steered queued before it carried jobId, and a
    // planning.changed, each finds the item's running job on UNIQUE (work_item_id, run_no).
    name: "the job line's routing of run.steered and planning.changed",
    run: async (e) => {
      if (!job) return null;
      const item = await env.DB.prepare("SELECT work_item_id FROM core_runs WHERE job_id = ?")
        .bind(job.jobId)
        .first<string>("work_item_id");
      const ids = [uid("ob_"), uid("ob_")];
      const now = new Date().toISOString();
      await env.DB.batch(
        [
          ["run.steered", { workItemId: item }],
          ["planning.changed", { workItemId: item }],
        ].map(([kind, payload], i) =>
          env.DB.prepare(
            "INSERT INTO core_outbox (id, at, kind, payload, attempts, next_at) VALUES (?, ?, ?, ?, 0, ?)",
          ).bind(ids[i], now, kind, JSON.stringify(payload), now),
        ),
      );
      return deliverOutbox(e, ids);
    },
  },
  { name: "inbox.list (polled)", run: (e) => as(e, "inbox.list", {}, w.human) },
  {
    // Polled by an open item; its runs query joins each run's archive incident
    // (core_incidents_run_idx). The item has a running job, so it has a run.
    name: "workItem.get (polled)",
    run: async (e) => {
      const item = await env.DB.prepare("SELECT work_item_id FROM core_runs WHERE job_id = ?")
        .bind(job?.jobId)
        .first<string>("work_item_id");
      return as(e, "workItem.get", { workItemId: item }, w.human);
    },
  },
  {
    // Not polled, but per push: a person's push to a factory item's branch at its merge stage
    // (ADR 0587) reads the item, its open gates and its queue entry, then moves its head.
    name: "a person's push to a factory item's branch (push.observe)",
    run: async (e) => {
      const item = await ok<{ workItemId: string }>(
        "workItem.create",
        { state: "queued", projectId: w.projectId, title: "Pushed to" },
        w.human,
      );
      const row = await e.DB.prepare("SELECT branch, number FROM core_work_items WHERE id = ?")
        .bind(item.workItemId)
        .first<{ branch: string; number: number }>();
      const branch = String(row?.branch);
      // Its Workflow has entered triage (so it won't set the stage after the update below).
      await waitFor("the triage job", () =>
        e.DB.prepare("SELECT id FROM core_jobs WHERE work_item_id = ? AND stage = 'triage'")
          .bind(item.workItemId)
          .first(),
      );
      const before = await github.push(w.repo, branch, undefined, ["src/a.ts"]);
      await e.DB.prepare(
        "UPDATE core_work_items SET stage = 'merge', status = 'waiting', head_sha = ? WHERE id = ?",
      )
        .bind(before, item.workItemId)
        .run();
      const after = await github.push(w.repo, branch, undefined, ["docs/b.md"]);
      const pushed = await invoke<{ outcome: string }>(
        invokeDeps(e),
        "push.observe",
        {
          repo: { owner: w.repo.owner, name: w.repo.repo },
          ref: `refs/heads/${branch}`,
          before,
          after,
          pusher: "octocat",
          pusherIsApp: false,
        },
        { actor: { type: "intake", id: "github" }, origin: { surface: "test" } },
      );
      // The whole path ran: the gate and queue reads, and the head moved.
      if (pushed.status !== "ok" || pushed.output.outcome !== "reverify") {
        throw new Error(`push.observe: ${JSON.stringify(pushed)}`);
      }
    },
  },
  {
    // Per check suite on the default branch (spec 53 part e, decision 7): main.observe opening a
    // red episode reads the suspects and the heads to hold, asks for the rerun, and records them.
    name: "main.observe opening a red episode (suspects, held heads)",
    run: async (e) => {
      const repo = { owner: w.repo.owner, name: w.repo.repo };
      const github_ = {
        actor: { type: "intake", id: "github" } as const,
        origin: { surface: "test" as const },
      };
      const main = String(await github.getBranchSha(w.repo, "main"));
      const ci = (conclusion: string) => [
        {
          name: "ci",
          status: "completed" as const,
          conclusion,
          appSlug: "github-actions",
          url: null,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        },
      ];
      await github.setChecks(w.repo, main, ci("success"));
      await invoke(invokeDeps(e), "main.observe", { repo, headSha: main, trigger: "ci" }, github_);
      await github.setChecks(w.repo, main, ci("failure"));
      await invoke(invokeDeps(e), "main.observe", { repo, headSha: main, trigger: "ci" }, github_);
      // While red: verify.refresh's held check, and naming a culprit (refused: not a suspect).
      await invoke(
        invokeDeps(e),
        "verify.refresh",
        { repo, headSha: main, trigger: "rerequested" },
        github_,
      );
      const item = await ok<{ workItemId: string }>(
        "workItem.create",
        { projectId: w.projectId, title: "Not a suspect" },
        w.human,
      );
      await as(e, "mainRed.attribute", { workItemId: item.workItemId, why: "x" }, w.human).catch(
        () => null,
      );
      // Green again: the release.
      await github.setChecks(w.repo, main, ci("success"));
      await invoke(invokeDeps(e), "main.observe", { repo, headSha: main, trigger: "ci" }, github_);
    },
  },
  {
    // Spec 53 §5: the engine's revert of a named culprit (claim, lease, ask GitHub: refused here,
    // so the give-up path too), then the reland and close lookups (refused: not a revert).
    name: "mainRed.revert, mainRed.reland and mainRed.closeRevert",
    run: async (e) => {
      const item = await ok<{ workItemId: string }>(
        "workItem.create",
        { projectId: w.projectId, title: "A culprit" },
        w.human,
      );
      const id = item.workItemId;
      const row = await e.DB.prepare("SELECT repository_id FROM core_work_items WHERE id = ?")
        .bind(id)
        .first<{ repository_id: string }>();
      const at = new Date(Date.now() - 3_600_000).toISOString();
      await e.DB.batch([
        e.DB.prepare(
          "UPDATE core_work_items SET status = 'done', merge_sha = ?, pr_number = 9999 WHERE id = ?",
        ).bind("c".repeat(40), id),
        e.DB.prepare(
          `INSERT OR REPLACE INTO core_main_health (repository_id, project_id, head_sha, state,
             checked_at, red_since, first_red_sha, culprit_work_item_id, attributed_by)
           VALUES (?, ?, ?, 'red', ?, ?, ?, ?, 'person')`,
        ).bind(row?.repository_id, w.projectId, "c".repeat(40), at, at, "c".repeat(40), id),
      ]);
      const step = (extra: Record<string, unknown> = {}) =>
        as(e, "mainRed.revert", { workItemId: id, ...extra }, w.human).catch(() => null);
      await step();
      const lease = (await step()) as { status: string; output?: { attempt?: number } } | null;
      await step({ attempt: lease?.output?.attempt ?? 1 });
      await as(e, "mainRed.reland", { workItemId: id }, w.human).catch(() => null);
      await e.DB.prepare("UPDATE core_main_health SET red_since = NULL WHERE repository_id = ?")
        .bind(row?.repository_id)
        .run();
    },
  },
  {
    name: "workItem.list by org (polled)",
    run: (e) => as(e, "workItem.list", { orgId: w.orgId }, w.human),
  },
  {
    name: "workItem.list by project (polled)",
    run: (e) => as(e, "workItem.list", { projectId: w.projectId }, w.human),
  },
  {
    name: "workItem.list by project and status",
    run: (e) =>
      as(e, "workItem.list", { projectId: w.projectId, status: ["queued", "running"] }, w.human),
  },
  {
    // The improver's history of finished items (improve.scan, config.trial.resolve).
    name: "recentOutcomes",
    run: (e) => recentOutcomes(createDb(e.DB), w.projectId, { limit: 10 }),
  },
  {
    // Every five minutes: the shadow reconciler (spec 52 PR (c)) reads the items that ended since its
    // cursor, with one to read: an ended item with its stages and a packet the queue carried.
    name: "the shadow reconciler's pass",
    run: async (e) => {
      const item = await ok<{ workItemId: string }>(
        "workItem.create",
        { state: "backlog", projectId: w.projectId, title: "Ended" },
        w.human,
      );
      const id = item.workItemId;
      const at = new Date().toISOString();
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO core_stages (id, work_item_id, stage, attempt, status, started_at) VALUES (?, ?, 'triage', 1, 'done', ?)",
        ).bind(`st_${id}`, id, at),
        env.DB.prepare(
          "INSERT INTO core_review_packets (id, work_item_id, head_sha, verdict, sections, created_at) VALUES (?, ?, 'b2', 'pass', '{\"carriedFrom\":\"a1\"}', ?)",
        ).bind(`rp_${id}`, id, at),
        env.DB.prepare(
          "UPDATE core_work_items SET status = 'done', size = 'small', updated_at = ? WHERE id = ?",
        ).bind(at, id),
      ]);
      const read = await shadowPass(e, new Date(Date.now() + SHADOW_LAG_MS + 60_000));
      if (read === 0) throw new Error("the pass read no ended item");
      return read;
    },
  },
  {
    name: "the shadow reconciler's prune",
    run: (e) => pruneReconcileShadow(e, new Date()),
  },
  {
    // The hourly stray-blob sweep with a blob to check (an empty bucket runs no D1 query).
    name: "the attachment sweep",
    run: async (e) => {
      await env.ATTACHMENTS.put(`${w.orgId}/plans/att_plan`, new Uint8Array([1]));
      return sweepStrayAttachmentBlobs(
        e.DB,
        r2AttachmentBlobs(env.ATTACHMENTS),
        new Date(Date.now() + 2 * 3_600_000),
      );
    },
  },
  {
    // The hourly check results prune (ADR 0501, fifth review), with a row past its cutoff to read.
    name: "the check results prune",
    run: async (e) => {
      await env.DB.prepare(
        `INSERT OR REPLACE INTO core_check_results
           (work_item_id, head_sha, name, run_id, command, exit_code, timed_out, duration_ms,
            log_tail, round, created_at)
         SELECT work_item_id, ?, 'plan-guard', id, 'true', 0, 0, 1, '', 0, '2000-01-01T00:00:00.000Z'
         FROM core_runs WHERE job_id = ?`,
      )
        .bind("a".repeat(40), job?.jobId ?? "")
        .run();
      // Its item is open, so the row is read, looked up and kept; limit 1 moves the cursor.
      return pruneCheckResults(e.DB, new Date(), 1);
    },
  },
  {
    // Spec 53 §4: the babysitter's reruns and known flakes past their 30 days, oldest first.
    name: "the babysitter's prune (reruns and known flakes)",
    run: (e) => pruneBabysit(e.DB, new Date()),
  },
  {
    name: "the hourly prunes (retention)",
    run: (e) => pruneExpired(e.DB, new Date()),
  },
  {
    // Spec 52 PR (d): a polled read on a project that runs an org workflow, with nothing cached, so
    // the org config's version and document are read: point reads by primary key. The timeline
    // (skipsOrgWorkflow) reads neither. (workItem.get's own reads aren't registered here yet.)
    name: "polled reads of an item on an org workflow",
    run: async (e) => {
      const o = await world();
      await ok(
        "workflow.save",
        { orgId: o.orgId, baseVersion: 0, workflow: { ...SOFTWARE, id: "wf_ship", name: "Ship" } },
        o.human,
      );
      const cfg = await ok<{
        current: { version: number; policy: Record<string, unknown> | null } | null;
      }>("config.get", { projectId: o.projectId }, o.human);
      const policy = cfg.current?.policy ?? {};
      await ok(
        "config.save",
        {
          projectId: o.projectId,
          baseVersion: cfg.current?.version ?? 0,
          policy: { ...policy, workflow: "wf_ship", workflows: [], agents: [] },
        },
        o.human,
      );
      const item = await ok<{ workItemId: string }>(
        "workItem.create",
        { state: "backlog", projectId: o.projectId, title: "Polled" },
        o.human,
      );
      clearOrgConfigCache();
      const scope = await resolveScope(createDb(e.DB), { workItemId: item.workItemId });
      if (scope.policy?.workflow !== "wf_ship") throw new Error("the org workflow didn't resolve");
      return as(e, "workItem.timeline", { workItemId: item.workItemId }, o.human);
    },
  },
  {
    // Spec 52 Q3 (review of #185): a re-pin at a stage boundary, on an item that already adopted a
    // version's tightenings, with nothing cached: the org row and each version's document by
    // primary key, override approvals by (project_id, org_version), the guarded update by id.
    name: "re-pinning a running item at a stage boundary",
    run: async (e) => {
      const o = await world();
      const ship = { ...SOFTWARE, id: "wf_ship", name: "Ship" };
      await ok("workflow.save", { orgId: o.orgId, baseVersion: 0, workflow: ship }, o.human);
      const cfg = await ok<{
        current: { version: number; policy: Record<string, unknown> | null } | null;
      }>("config.get", { projectId: o.projectId }, o.human);
      await ok(
        "config.save",
        {
          projectId: o.projectId,
          baseVersion: cfg.current?.version ?? 0,
          policy: {
            ...(cfg.current?.policy ?? {}),
            workflow: "wf_ship",
            workflows: [],
            agents: [],
          },
        },
        o.human,
      );
      const item = await ok<{ workItemId: string }>(
        "workItem.create",
        { state: "backlog", projectId: o.projectId, title: "Re-pinned" },
        o.human,
      );
      // Running, and it adopted v1's tightenings; v2 then tightens the spec threshold.
      await env.DB.prepare(
        "UPDATE core_work_items SET status = 'running', org_config_version = 1, org_config_adopted = '[1]' WHERE id = ?",
      )
        .bind(item.workItemId)
        .run();
      const tighter = {
        ...ship,
        stages: ship.stages.map((x) =>
          x.id === "spec"
            ? {
                ...x,
                settings: { ...(x.settings as Record<string, unknown>), requiredFrom: "small" },
              }
            : x,
        ),
      };
      await ok("workflow.save", { orgId: o.orgId, baseVersion: 1, workflow: tighter }, o.human);
      clearOrgConfigCache();
      const moved = await invoke(
        invokeDeps(e),
        "workItem.repinWorkflow",
        { workItemId: item.workItemId, at: "merge #1" },
        { actor: FOREMAN, origin: { surface: "test" } },
      );
      if (moved.status !== "ok" || (moved.output as { repinned: boolean }).repinned !== true)
        throw new Error(`the re-pin didn't happen: ${JSON.stringify(moved)}`);
      return moved;
    },
  },
  {
    // Spec 52 (f), reviews of #155: a job's skills resolved at enqueue, then list, propose, read
    // and accept, and the runner's skill.forJob (see skillsScenario).
    name: "skills: enqueue, list, propose, get, accept and skill.forJob",
    run: (e) => skillsScenario(e),
  },
  {
    // The last four: they end the test's run 31 days ago, archive it, read it back, and lose one of its objects.
    name: "archiving an ended run's events (retention)",
    run: async (e) => {
      if (!job) return null;
      await env.DB.prepare(
        "UPDATE core_runs SET status = 'handed_back', ended_at = ? WHERE job_id = ?",
      )
        .bind(new Date(Date.now() - 31 * 86_400_000).toISOString(), job.jobId)
        .run();
      return archiveRunEvents(e, new Date());
    },
  },
  {
    name: "run.live of an archived run",
    run: async (e) => {
      const run = await env.DB.prepare("SELECT work_item_id FROM core_runs WHERE job_id = ?")
        .bind(job?.jobId)
        .first<string>("work_item_id");
      await as(e, "run.live", { workItemId: run }, w.human);
      return as(e, "run.live", { workItemId: run, afterSeq: 0 }, w.human);
    },
  },
  {
    // Every five minutes: the audit archiver's tick (ADR 0591). With a day recorded 100 days ago,
    // the days after it are due: each takes its lease, finds the rowid floor with probes, bounds
    // the window, reads a page and records the (empty) day. Its chunk batches run over real old
    // rows in audit-archive.test.ts, under the same check.
    name: "the audit archive's tick",
    run: async (e) => {
      const day = new Date(Date.now() - 100 * 86_400_000).toISOString().slice(0, 10);
      await env.DB.prepare(
        "INSERT OR IGNORE INTO core_audit_archives (day, chunks, rows, root, prev_root, archived_at) VALUES (?, 0, 0, ?, ?, ?)",
      )
        .bind(day, "0".repeat(64), "0".repeat(64), new Date().toISOString())
        .run();
      return archiveAudit(e, new Date(), { rows: 1_000 });
    },
  },
  {
    // Polled by an open item's Activity tab: the D1 entries and the item's archived chunks, one
    // request; then, on demand, the archived entries read back.
    name: "workItem.timeline, with its archived entries",
    run: async (e) => {
      const item = await env.DB.prepare("SELECT work_item_id FROM core_runs WHERE job_id = ?")
        .bind(job?.jobId)
        .first<string>("work_item_id");
      await as(e, "workItem.timeline", { workItemId: item }, w.human);
      return as(e, "workItem.timeline", { workItemId: item, archived: true }, w.human);
    },
  },
  {
    // The archiver's health report (only after three stopped ticks, or the tick after): the open
    // archiver incident on core_incidents_audit_archive_idx.
    name: "audit.archiveHealth",
    run: (e) =>
      as(e, "audit.archiveHealth", { stopped: false }, SCHEDULER as unknown as World["human"]),
  },
  {
    // An org admin's verify of the chain (on demand): the days and their chunks by primary key.
    name: "audit.verify",
    run: (e) => {
      const to = new Date(Date.now() - 95 * 86_400_000).toISOString().slice(0, 10);
      const from = new Date(Date.now() - 100 * 86_400_000).toISOString().slice(0, 10);
      return as(e, "audit.verify", { orgId: w.orgId, from, to }, w.human);
    },
  },
  {
    // The archive's daily sample, with one of the run's objects gone: it finds the gap (the top
    // rowid, then the picks by rowid) and reports it through run.reportArchiveMissing as the
    // scheduler, which opens the run's one incident record.
    name: "the archive's daily sample, reporting a missing object",
    run: async (e) => {
      // The run's archive index names an object that isn't in the bucket (the run had no events of
      // its own to archive, so the chunk is recorded here, as the archiver records one).
      const run = await env.DB.prepare("SELECT id FROM core_runs WHERE job_id = ?")
        .bind(job?.jobId)
        .first<string>("id");
      const key = `runs/${run}/events/0-0.ndjson`;
      await env.DB.prepare(
        `INSERT OR IGNORE INTO core_run_archive_chunks
           (run_id, first_seq, last_seq, r2_key, rows, bytes, sha256, archived_at)
         VALUES (?, 0, 0, ?, 1, 1, 'x', ?)`,
      )
        .bind(run, key, new Date().toISOString())
        .run();
      await env.ARCHIVE.delete(key);
      const top = await env.DB.prepare(
        "SELECT max(rowid) AS top FROM core_run_archive_chunks",
      ).first<number>("top");
      const at = await env.DB.prepare("SELECT rowid FROM core_run_archive_chunks WHERE r2_key = ?")
        .bind(key)
        .first<number>("rowid");
      const missing = await sampleArchive(e, new Date(), 1, () => ((at ?? 1) - 0.5) / (top ?? 1));
      if (!missing.includes(key)) throw new Error(`the sample didn't find ${key} missing`);
      return missing;
    },
  },
  {
    // A viewer meeting the same gap once the incident is recorded: the chunk and the run's incident.
    name: "run.reportArchiveMissing (a viewer, incident already recorded)",
    run: async (e) => {
      const run = await env.DB.prepare(
        "SELECT r.id, r.work_item_id, c.first_seq FROM core_runs r JOIN core_run_archive_chunks c ON c.run_id = r.id WHERE r.job_id = ? AND c.first_seq = 0",
      )
        .bind(job?.jobId)
        .first<{ id: string; work_item_id: string; first_seq: number }>();
      if (!run) throw new Error("the run wasn't archived");
      return as(
        e,
        "run.reportArchiveMissing",
        { workItemId: run.work_item_id, runId: run.id, firstSeq: run.first_seq },
        w.human,
      );
    },
  },
  {
    // Read when the desktop's Checks and incidents page opens (not polled): the open archive
    // incidents on core_incidents_open_archive_idx, newest first, no sort.
    name: "incident.listArchiveMissing",
    run: (e) => as(e, "incident.listArchiveMissing", { orgId: w.orgId }, w.human),
  },
];

describe("hot-path query plans (AGENTS.md, Cloudflare cost)", () => {
  beforeAll(async () => {
    w = await world();
    // A running job, so the heartbeat and steer paths carry one.
    await ok("workItem.create", { state: "queued", projectId: w.projectId, title: "Run" }, w.human);
    const c = await channel(env, w.runner.runnerId);
    for (let i = 0; i < 100 && !job; i++) {
      const claimed = await c.claim({
        claimId: uid("claim-"),
        manifest: { ...MANIFEST, capabilities: [...MANIFEST.capabilities, "steer"] },
        capacity: { max: 4, inUse: 0, accepting: true },
      });
      if (claimed.job) {
        job = { jobId: claimed.job.jobId, fencingToken: claimed.job.lease.fencingToken };
      } else await new Promise((r) => setTimeout(r, 50));
    }
    if (!job) throw new Error("no job to run the heartbeat and steer paths with");
  });

  it("catches a scan (the guard itself works)", async () => {
    const seen: Recorded[] = [];
    await recordingEnv(env, seen)
      .DB.prepare("SELECT id FROM core_audit a WHERE a.outcome = ? LIMIT 1")
      .bind("ok")
      .first();
    expect(await growingScans(env.DB, seen)).toEqual([
      expect.objectContaining({ table: "core_audit", detail: "SCAN a" }),
    ]);
  });

  it("a status-filtered list reads only that status's rows (no walk of every item)", async () => {
    const seen: Recorded[] = [];
    await as(
      recordingEnv(env, seen),
      "workItem.list",
      { projectId: w.projectId, status: ["queued"] },
      w.human,
    );
    const list = seen.find(
      (r) => /from "core_work_items"/.test(r.sql) && /"status" in/.test(r.sql),
    );
    if (!list) throw new Error("the list query didn't run");
    const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${list.sql}`)
      .bind(...list.params)
      .all<{ detail: string }>();
    expect(results.map((r) => r.detail).join("\n")).toMatch(/USING INDEX \w+ \(status=\?/);
  });

  it("job.claim reads the queue in claim order from its index: no sort of the queued jobs", async () => {
    const seen: Recorded[] = [];
    await (await channel(recordingEnv(env, seen), w.runner.runnerId)).claim({
      claimId: uid("claim-"),
      manifest: MANIFEST,
      capacity: { max: 2, inUse: 0, accepting: true },
    });
    const claim = seen.find((r) => /WITH q AS/.test(r.sql));
    if (!claim) throw new Error("the claim query didn't run");
    const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${claim.sql}`)
      .bind(...claim.params)
      .all<{ id: number; parent: number; detail: string }>();
    // The CTE q: core_jobs through core_jobs_queue_idx, and no temp B-tree under it.
    const q = results.find((r) => /^(MATERIALIZE|CO-ROUTINE) q$/.test(r.detail));
    if (!q) throw new Error(`no q in the plan:\n${results.map((r) => r.detail).join("\n")}`);
    const under = results.filter((r) => r.parent === q.id).map((r) => r.detail);
    expect(under.join("\n")).toMatch(/core_jobs_queue_idx/);
    expect(under.join("\n")).not.toMatch(/TEMP B-TREE/);
  });

  for (const path of HOT_PATHS) {
    it(`${path.name}: no SCAN of a growing table`, async () => {
      const seen: Recorded[] = [];
      await path.run(recordingEnv(env, seen));
      expect(seen.length).toBeGreaterThan(0);
      expect(await growingScans(env.DB, seen)).toEqual([]);
    });
  }

  it("every read of a skill version uses its full key or a named index, never the org's history", async () => {
    const seen: Recorded[] = [];
    await skillsScenario(recordingEnv(env, seen));
    const reads = seen.filter(
      (r) => /core_skill_versions/.test(r.sql) && /^\s*select/i.test(r.sql),
    );
    expect(reads.length).toBeGreaterThan(0);
    for (const { sql, params } of reads) {
      const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .bind(...params)
        .all<{ detail: string }>();
      const lines = results.map((r) => r.detail).filter((d) => /core_skill_versions/.test(d));
      for (const d of lines)
        expect(d, sql).toMatch(
          /(?:PRIMARY KEY|INDEX sqlite_autoindex_core_skill_versions_1) \(org_id=\? AND skill_id=\?(?: AND version=\?)?\)|core_skill_versions_(status|rejected|author)_idx/,
        );
      // The batch read of versions by key: each arm on the whole primary key.
      if (/\bOR\b/.test(sql))
        expect(lines.join("\n"), sql).toMatch(/org_id=\? AND skill_id=\? AND version=\?/);
    }
  });
});
