// Runners, the job queue, runs and leases (ADR 0014–0016, 0023, 0033, 0035, 0038, 0040). The runner
// channel in sf-engine maps each signed call to one of these operations with actor
// `{ type: "runner", id: <runner id> }`.

import { json, parseJson } from "@software-factory/db";
import {
  accountNameSchema,
  type artifactSchema,
  CAPABILITIES,
  type Capability,
  type CapabilityManifest,
  canRun,
  capabilityManifestSchema,
  capacityPausedSchema,
  capacitySchema,
  JOB_STAGES,
  type Job,
  MODEL_ROLES,
  type ModelRole,
  PLANNING_YIELD_AFTER_MS,
  type Pool,
  RUNNER_COMPAT,
  type RunnerAccounts,
  runBranch,
  runnerAccountsSchema,
  runnerEventSchema,
  runnerVersionSchema,
  stagePool,
  storedArtifactSchema,
} from "@software-factory/runner-contract";
import { sql } from "kysely";
import { z } from "zod";
import { OperationError } from "../errors.ts";
import { newId, newRunnerId } from "../ids.ts";
import { MODEL_TIERS, resolveModel } from "../model-roles.ts";
import {
  defineOperation,
  type HandlerContext,
  type ProjectRow,
  type WorkItemRow,
} from "../operation.ts";
import { planningRunEnded, USER_EVENTS } from "../planning.ts";
import { policyImpact } from "../policy/impact.ts";
import type { ProjectPolicy } from "../policy/project-policy.ts";
import { activeKillSwitch, loadPolicy } from "../scope.ts";
import { desiredRunnerVersion } from "../services.ts";
import { runEvent } from "../workflow-events.ts";
import { protectionBlocksBuild } from "./protection.ts";
import {
  fencingToken,
  itemRepository,
  jobId,
  repoRef,
  requireRepository,
  requireWorkItem,
  sha,
  workItemId,
} from "./shared.ts";
import { RUNNER_OFFLINE_MS, WIP_WAIT_REASON } from "./work-items.ts";

/** How long a lease lasts without a heartbeat (open question in ADR 0021; ADR 0052 picks this). */
export const LEASE_TTL_MS = 10 * 60_000;
export const ACTIVE_RUN = ["claimed", "preparing", "running", "collecting"] as const;
const MAX_ARTIFACT_BODY = 512 * 1024;
const MAX_RESULT = 200 * 1024;

const runnerView = z.object({
  id: z.string(),
  name: z.string(),
  ownerUserId: z.string(),
  keyVersion: z.number(),
  manifest: capabilityManifestSchema.nullable(),
  capacityMax: z.number(),
  /** The light pool (ADR 0301); null when the runner reports none. */
  light: z.object({ max: z.number(), inUse: z.number() }).nullable(),
  accepting: z.boolean(),
  rateLimitedUntil: z.string().nullable(),
  lastSeenAt: z.string().nullable(),
  /**
   * The runner's code (ADR 0360): the commit it runs, the commit the factory wants it on, and where
   * its self-update stands. `version` null: it hasn't reported one (an older runner).
   */
  version: z.string().nullable(),
  desiredVersion: z.string().nullable(),
  autoUpdate: z.boolean().nullable(),
  update: z
    .object({ state: z.string(), target: z.string().nullable(), reason: z.string().nullable() })
    .nullable(),
  /**
   * Its Claude accounts (ADR 0410): names, the active one, the one its owner asked for (until the
   * runner reports it active) and recent usage limits. Null: it hasn't reported any (an older
   * runner).
   */
  accounts: z
    .object({
      names: z.array(z.string()),
      active: z.string(),
      requested: z.string().nullable(),
      limits: z.array(z.object({ name: z.string(), at: z.string(), message: z.string() })),
    })
    .nullable(),
});

/** A runner row's accounts, for `runnerView`. */
function accountsView(r: {
  accounts: string | null;
  account_requested: string | null;
}): z.infer<typeof runnerView>["accounts"] {
  const reported = parseJson<RunnerAccounts | null>(r.accounts, null);
  if (!reported) return null;
  return {
    names: reported.names,
    active: reported.active,
    requested: r.account_requested,
    limits: reported.limits ?? [],
  };
}

const desiredVersion = (ctx: HandlerContext): string | null => desiredRunnerVersion(ctx.services);

async function loadRunner(ctx: HandlerContext, id: string) {
  const runner = await ctx.db
    .selectFrom("core_runners")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  if (!runner || runner.revoked_at)
    throw new OperationError("forbidden", "unknown or revoked runner");
  return runner;
}
type RunnerRow = Awaited<ReturnType<typeof loadRunner>>;

export const runnerRegister = defineOperation({
  name: "runner.register",
  description:
    "Register a runner owned by the signed-in person. Returns its id and channel key, shown once: the runner host signs every call with it (ADR 0016). Runners are owner-only until the owner shares them (ADR 0038).",
  risk: "write",
  actors: ["human"],
  permission: "signed-in",
  browserOnly: true,
  input: z.object({ name: z.string().min(1).max(80) }),
  output: z.object({ runnerId: z.string(), keyVersion: z.number(), key: z.string() }),
  redact: { output: (o) => ({ ...o, key: "[redacted]" }) },
  async handler(input, ctx) {
    const id = newRunnerId();
    const key = await ctx.services.runnerKey(id, 1);
    ctx.write(
      ctx.db.insertInto("core_runners").values({
        id,
        owner_user_id: ctx.actor.id,
        name: input.name,
        key_version: 1,
        created_at: ctx.now,
      }),
    );
    ctx.change({ entity: "runner", id, after: { name: input.name, owner: ctx.actor.id } });
    return { runnerId: id, keyVersion: 1, key };
  },
});

export const runnerRotateKey = defineOperation({
  name: "runner.rotateKey",
  description: "Issue a runner a new channel key, revoking the old one. The runner's owner only.",
  risk: "write",
  actors: ["human"],
  permission: "signed-in",
  browserOnly: true,
  input: z.object({ runnerId: z.string().min(1) }),
  output: z.object({ runnerId: z.string(), keyVersion: z.number(), key: z.string() }),
  redact: { output: (o) => ({ ...o, key: "[redacted]" }) },
  async handler(input, ctx) {
    const runner = await loadRunner(ctx, input.runnerId);
    if (runner.owner_user_id !== ctx.actor.id)
      throw new OperationError("forbidden", "not your runner");
    const version = runner.key_version + 1;
    ctx.write(
      ctx.db
        .updateTable("core_runners")
        .set({ key_version: version })
        .where("id", "=", runner.id)
        .where("key_version", "=", runner.key_version),
    );
    ctx.guardChanged("rotate once");
    ctx.change({
      entity: "runner",
      id: runner.id,
      before: { keyVersion: runner.key_version },
      after: { keyVersion: version },
    });
    return {
      runnerId: runner.id,
      keyVersion: version,
      key: await ctx.services.runnerKey(runner.id, version),
    };
  },
});

export const runnerList = defineOperation({
  name: "runner.list",
  description: "The signed-in person's runners with their last reported manifest and state.",
  risk: "read",
  actors: ["human"],
  permission: "signed-in",
  input: z.object({}),
  output: z.object({ runners: z.array(runnerView) }),
  async handler(_input, ctx) {
    const rows = await ctx.db
      .selectFrom("core_runners")
      .selectAll()
      .where("owner_user_id", "=", ctx.actor.id)
      .where("revoked_at", "is", null)
      .orderBy("created_at")
      .execute();
    return {
      runners: rows.map((r) => ({
        id: r.id,
        name: r.name,
        ownerUserId: r.owner_user_id,
        keyVersion: r.key_version,
        manifest: parseJson<CapabilityManifest | null>(r.manifest, null),
        capacityMax: r.capacity_max,
        light: r.light_max === null ? null : { max: r.light_max, inUse: r.light_in_use },
        accepting: r.accepting === 1,
        rateLimitedUntil: r.rate_limited_until,
        lastSeenAt: r.last_seen_at,
        version: r.version,
        desiredVersion: desiredVersion(ctx),
        autoUpdate: r.auto_update === null ? null : r.auto_update === 1,
        update: r.update_state
          ? { state: r.update_state, target: r.update_target, reason: r.update_reason }
          : null,
        accounts: accountsView(r),
      })),
    };
  },
});

function reportRunnerState(
  ctx: HandlerContext,
  runner: RunnerRow,
  report: {
    manifest: CapabilityManifest;
    capacity: z.infer<typeof capacitySchema>;
    rateLimitedUntil?: string | null | undefined;
    version?: z.infer<typeof runnerVersionSchema> | undefined;
    accounts?: RunnerAccounts | undefined;
    /** Only the heartbeat carries it; a claim leaves the stored value alone. */
    compat?: number | null;
    /** A heartbeat's signed time: the update applies only when it is newer than the last one. */
    signedAt?: number | undefined;
    /** Signed no later than the last accepted heartbeat: report nothing, write nothing. */
    stale?: boolean;
  },
): { pendingAccount: string | null } {
  // The owner's pick is done once the runner reports it active, and moot once the runner reports
  // accounts without it (removed on the host).
  const requested = runner.account_requested;
  const settled =
    requested !== null &&
    report.accounts !== undefined &&
    (report.accounts.active === requested || !report.accounts.names.includes(requested));
  if (report.stale) return { pendingAccount: requested !== null && !settled ? requested : null };
  ctx.write(
    ctx.db
      .updateTable("core_runners")
      .set({
        manifest: json(report.manifest),
        capacity_max: report.capacity.max,
        capacity_in_use: report.capacity.inUse,
        light_max: report.capacity.light?.max ?? null,
        light_in_use: report.capacity.light?.inUse ?? 0,
        accepting: report.capacity.accepting ? 1 : 0,
        paused: report.capacity.paused ? json(report.capacity.paused) : null,
        ...(report.rateLimitedUntil !== undefined
          ? { rate_limited_until: report.rateLimitedUntil }
          : {}),
        last_seen_at: ctx.now,
        ...(report.version
          ? {
              version: report.version.sha,
              auto_update: report.version.autoUpdate ? 1 : 0,
              update_state: report.version.update.state,
              update_target: report.version.update.target,
              update_reason: report.version.update.reason,
            }
          : {}),
        ...(report.accounts ? { accounts: json(report.accounts) } : {}),
        ...(report.compat !== undefined ? { compat: report.compat } : {}),
        ...(settled ? { account_requested: null, account_requested_at: null } : {}),
        ...(report.signedAt !== undefined ? { last_signed_at: report.signedAt } : {}),
      })
      .where("id", "=", runner.id)
      .$if(report.signedAt !== undefined, (q) =>
        q.where((eb) =>
          eb.or([
            eb("last_signed_at", "is", null),
            eb("last_signed_at", "<", report.signedAt ?? 0),
          ]),
        ),
      ),
  );
  // No batch guard (it would cost an insert and a delete per beat, and a failed one would cost the
  // beat's lease renewals): a stale heartbeat never gets here, and this condition only keeps the
  // newer of two racing heartbeats' runner state.
  return { pendingAccount: requested !== null && !settled ? requested : null };
}

export const runnerAccountUse = defineOperation({
  name: "runner.account.use",
  description:
    "Pick which of a runner's Claude accounts new jobs use (ADR 0410). Takes the account's name only: accounts and their credentials live on the runner's host. Running jobs keep theirs. The runner's owner only.",
  risk: "write",
  actors: ["human"],
  permission: "signed-in",
  input: z.object({ runnerId: z.string().min(1), name: accountNameSchema }),
  output: z.object({ runnerId: z.string(), requested: z.string(), active: z.string() }),
  async handler(input, ctx) {
    const runner = await loadRunner(ctx, input.runnerId);
    if (runner.owner_user_id !== ctx.actor.id)
      throw new OperationError("forbidden", "not your runner");
    const reported = parseJson<RunnerAccounts | null>(runner.accounts, null);
    if (!reported) {
      throw new OperationError(
        "conflict",
        "this runner hasn't reported its Claude accounts: update it (sf-runner) first",
      );
    }
    if (!reported.names.includes(input.name)) {
      throw new OperationError(
        "invalid_input",
        `no account "${input.name}" on this runner; add it on the host with sf-runner account add`,
      );
    }
    // Picking the active one clears a pending pick.
    const requested = input.name === reported.active ? null : input.name;
    ctx.write(
      ctx.db
        .updateTable("core_runners")
        .set({ account_requested: requested, account_requested_at: requested ? ctx.now : null })
        .where("id", "=", runner.id),
    );
    ctx.change({
      entity: "runner",
      id: runner.id,
      before: { account: reported.active, requested: runner.account_requested },
      after: { account: input.name },
    });
    return { runnerId: runner.id, requested: input.name, active: reported.active };
  },
});

export const runnerHeartbeat = defineOperation({
  name: "runner.heartbeat",
  description:
    "A runner host reports its manifest, capacity, rate limit and the jobs it holds. Each held job's lease is renewed if its fencing token is current; jobs the cloud has stopped (cancelled, taken over, kill switch) come back as cancel commands.",
  risk: "write",
  actors: ["runner"],
  permission: "signed-in",
  input: z.object({
    manifest: capabilityManifestSchema,
    capacity: capacitySchema,
    activeJobs: z.array(z.object({ jobId: z.string(), fencingToken })),
    rateLimitedUntil: z.iso.datetime({ offset: true }).nullable().optional(),
    /** The runner's own code and its self-update (ADR 0360); older runners omit it. */
    version: runnerVersionSchema.optional(),
    /** Its Claude accounts, names only (ADR 0410); older runners omit it. */
    accounts: runnerAccountsSchema.optional(),
    /** Its code's RUNNER_COMPAT (ADR 0520); older runners omit it, which counts as 1. */
    compat: z.number().int().min(0).optional(),
  }),
  output: z.object({
    commands: z.array(
      z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("cancel"), jobId: z.string(), reason: z.string() }),
        z.object({ kind: z.literal("account.use"), name: z.string() }),
      ]),
    ),
    leases: z.array(z.object({ jobId: z.string(), expiresAt: z.string() })),
    /** The commit the runner should run (ADR 0360, 0520); null when the engine doesn't know. */
    desiredVersion: z.string().nullable(),
    /** The engine's RUNNER_COMPAT: a runner below it claims nothing until it updates (ADR 0520). */
    minRunnerCompat: z.number().int(),
  }),
  async handler(input, ctx) {
    const runner = await loadRunner(ctx, ctx.actor.id);
    // A heartbeat isn't stored by the channel, so a captured one could be replayed within the
    // signing window. One signed no later than the last accepted (a replay, `sf-runner doctor`'s
    // beat in the same second as the service's, a clock put back) doesn't change the runner's
    // reported state, which only a newer heartbeat may. It still renews its leases below, fenced as
    // always: the guard must never cost a running job its lease.
    const signedAt = ctx.origin.signedAt;
    const stale =
      signedAt !== undefined && runner.last_signed_at !== null && signedAt <= runner.last_signed_at;
    const { pendingAccount } = reportRunnerState(ctx, runner, {
      ...input,
      compat: input.compat ?? null,
      signedAt,
      stale,
    });
    // The runner claims nothing until an update it is waiting for (ADR 0520): free its light pool
    // by asking an idle planning session (nobody there, nothing undelivered) to yield, as a full
    // pool would. Its resume is pinned to this runner and placed once it has updated.
    if (
      !stale &&
      input.version?.update.state === "waiting" &&
      input.version.update.claims === "none"
    ) {
      await requestYield(ctx, runner.id);
    }
    const commands: (
      | { kind: "cancel"; jobId: string; reason: string }
      | { kind: "account.use"; name: string }
    )[] = [];
    // Sent on every heartbeat until the host reports the switch (ADR 0410).
    if (pendingAccount) commands.push({ kind: "account.use", name: pendingAccount });
    const leases: { jobId: string; expiresAt: string }[] = [];
    const expiresAt = new Date(Date.parse(ctx.now) + LEASE_TTL_MS).toISOString();
    for (const held of input.activeJobs) {
      const run = await ctx.db
        .selectFrom("core_runs")
        .innerJoin("core_work_items", "core_work_items.id", "core_runs.work_item_id")
        .innerJoin("core_leases", "core_leases.work_item_id", "core_runs.work_item_id")
        .select([
          "core_runs.id",
          "core_runs.status",
          "core_runs.runner_id",
          "core_runs.work_item_id",
          "core_work_items.org_id",
          "core_work_items.project_id",
          "core_leases.fencing_token",
        ])
        .where("core_runs.job_id", "=", held.jobId)
        .executeTakeFirst();
      if (!run || run.runner_id !== runner.id) {
        commands.push({ kind: "cancel", jobId: held.jobId, reason: "not assigned to this runner" });
        continue;
      }
      if (!(ACTIVE_RUN as readonly string[]).includes(run.status)) {
        commands.push({ kind: "cancel", jobId: held.jobId, reason: `run is ${run.status}` });
        continue;
      }
      if (run.fencing_token !== held.fencingToken) {
        commands.push({
          kind: "cancel",
          jobId: held.jobId,
          reason: "fenced: the work item was taken over",
        });
        continue;
      }
      const kill = await activeKillSwitch(ctx.db, run.org_id, run.project_id);
      if (kill) {
        commands.push({ kind: "cancel", jobId: held.jobId, reason: `kill switch (${kill.scope})` });
        continue;
      }
      ctx.write(
        ctx.db
          .updateTable("core_leases")
          .set({ expires_at: expiresAt })
          .where("work_item_id", "=", run.work_item_id)
          .where("fencing_token", "=", held.fencingToken),
      );
      leases.push({ jobId: held.jobId, expiresAt });
    }
    return {
      commands,
      leases,
      desiredVersion: desiredVersion(ctx),
      minRunnerCompat: RUNNER_COMPAT,
    };
  },
});

export const jobEnqueue = defineOperation({
  name: "job.enqueue",
  description:
    "Queue a stage job (triage, spec, build or verify) for a work item. A runner with the needed capabilities, owned by the requester or sharing into the project, claims it. The model is named by role, never by id (ADR 0018).",
  risk: "write",
  actors: ["agent"],
  permission: "signed-in",
  input: z.object({
    workItemId,
    stage: z.enum(JOB_STAGES),
    role: z.enum(MODEL_ROLES),
    prompt: z.string().min(1).max(200_000),
    context: z.record(z.string(), z.unknown()).default({}),
    /** The agent's model tier (ADR 0372); the runner's claim resolves it to a model. */
    tier: z.enum(MODEL_TIERS).default("standard"),
    /** Capabilities the agent needs on top of the stage's. */
    agentRequires: z.array(z.enum(CAPABILITIES)).max(10).default([]),
    sessionTimeoutMs: z
      .number()
      .int()
      .positive()
      .max(6 * 3_600_000)
      .default(60 * 60_000),
  }),
  output: z.object({ jobId: z.string() }),
  async handler(input, ctx) {
    const w = requireWorkItem(ctx);
    const requires = [
      ...new Set([...(ctx.scope.policy?.requires[input.stage] ?? []), ...input.agentRequires]),
    ];
    const id = newId("job");
    ctx.write(
      ctx.db.insertInto("core_jobs").values({
        id,
        work_item_id: w.id,
        project_id: w.project_id,
        org_id: w.org_id,
        stage: input.stage,
        role: input.role,
        requires: JSON.stringify(requires),
        prompt: input.prompt,
        context: JSON.stringify(input.context),
        session_timeout_ms: input.sessionTimeoutMs,
        created_at: ctx.now,
        pool: stagePool(input.stage),
        tier: input.tier === "standard" ? null : input.tier,
      }),
    );
    ctx.change({
      entity: "job",
      id,
      after: { stage: input.stage, role: input.role, tier: input.tier, requires },
    });
    return { jobId: id };
  },
});

/** Why a runner may not take a job on this work item now, or null if it may (ADR 0015, 0038, 0040). */
export async function placementRefusal(
  ctx: Pick<HandlerContext, "db" | "now">,
  runner: RunnerRow,
  manifest: CapabilityManifest | null,
  job: {
    stage: string;
    requires: Capability[];
    harness: string;
    pinnedRunnerId?: string | null;
  },
  item: Pick<WorkItemRow, "id" | "org_id" | "project_id" | "requester_user_id"> & {
    repository_id?: string | null;
  },
  project: Pick<ProjectRow, "id" | "factory_id" | "policy_sha">,
): Promise<{ reason: string; wip?: true; waitReason?: string } | null> {
  if (!manifest) return { reason: "runner has not reported a manifest" };
  // Checked before anything is claimed (ADR 0490): an item with no repository waits, with the
  // reason, and never blocks the jobs behind it.
  if (
    "repository_id" in item &&
    !(await itemRepository(ctx.db, {
      repository_id: item.repository_id ?? null,
      project_id: item.project_id,
    }))
  ) {
    const reason = "the work item has no repository: choose one of its project's";
    return { reason, waitReason: reason };
  }
  // A planning resume goes back to its session's runner (ADR 0300), and only a runner with a light
  // pool takes planning at all (ADR 0301).
  if (job.pinnedRunnerId && job.pinnedRunnerId !== runner.id) {
    return { reason: "pinned to another runner" };
  }
  if (job.stage === "planning" && runner.light_max === null) {
    return { reason: "runner reports no light pool" };
  }
  // A runner waiting to update starts no planning session (ADR 0520): one moves at human speed and
  // would hold the update off. A pinned resume waits for it too, then goes back to it.
  if (job.stage === "planning" && runner.update_state === "waiting") {
    return { reason: "runner is waiting to update" };
  }
  const fit = canRun(manifest, {
    harness: { id: job.harness } as Job["harness"],
    requires: job.requires,
  });
  if (!fit.ok) return { reason: fit.reason };
  if (runner.owner_user_id !== item.requester_user_id) {
    const share = await ctx.db
      .selectFrom("core_runner_shares")
      .select("runner_id")
      .where("runner_id", "=", runner.id)
      .where((eb) =>
        eb.or([
          eb.and([eb("scope", "=", "org"), eb("scope_id", "=", item.org_id)]),
          eb.and([eb("scope", "=", "factory"), eb("scope_id", "=", project.factory_id)]),
          eb.and([eb("scope", "=", "project"), eb("scope_id", "=", project.id)]),
        ]),
      )
      .executeTakeFirst();
    if (!share)
      return { reason: "runner is not the requester's and is not shared into this project" };
  }
  if (await activeKillSwitch(ctx.db, item.org_id, item.project_id))
    return { reason: "kill switch" };
  const { policy } = await loadPolicy(ctx.db, project);
  if (!policy) return { reason: "project has no valid policy" };
  if (job.stage === "build" && (await atWipLimit(ctx, project.id, policy))) {
    return { reason: WIP_WAIT_REASON, wip: true };
  }
  if (job.stage === "build") {
    // ADR 0280: a policy may hold builds while the default branch's protection is red.
    const held = await protectionBlocksBuild(ctx, project.id, policy.protection.onRed);
    if (held) return { reason: held, waitReason: held };
  }
  const lease = await ctx.db
    .selectFrom("core_leases")
    .select(["holder_kind", "expires_at"])
    .where("work_item_id", "=", item.id)
    .executeTakeFirst();
  if (
    lease?.holder_kind &&
    lease.expires_at &&
    Date.parse(lease.expires_at) > Date.parse(ctx.now)
  ) {
    return { reason: `held by a ${lease.holder_kind}` };
  }
  return null;
}

/** A project is at its WIP limit when that many items wait at human gates (ADR 0040). */
async function atWipLimit(
  ctx: Pick<HandlerContext, "db">,
  projectId: string,
  policy: ProjectPolicy,
) {
  const row = await ctx.db
    .selectFrom("core_work_items")
    .select((eb) => eb.fn.countAll().as("n"))
    .where("project_id", "=", projectId)
    .where("status", "=", "waiting")
    .executeTakeFirst();
  return Number(row?.n ?? 0) >= policy.wipLimit;
}

/** Active runs on a runner per pool (ADR 0301). */
async function activeRunsByPool(
  ctx: Pick<HandlerContext, "db">,
  runnerId: string,
): Promise<Record<Pool, number>> {
  const rows = await ctx.db
    .selectFrom("core_runs")
    .innerJoin("core_jobs", "core_jobs.id", "core_runs.job_id")
    .select(["core_jobs.pool", (eb) => eb.fn.countAll().as("n")])
    .where("core_runs.runner_id", "=", runnerId)
    .where("core_runs.status", "in", [...ACTIVE_RUN])
    .groupBy("core_jobs.pool")
    .execute();
  const out: Record<Pool, number> = { heavy: 0, light: 0 };
  for (const r of rows) out[r.pool] = Number(r.n);
  return out;
}

/**
 * Which pools have a free slot on a runner right now (online, accepting, not rate-limited). With a
 * light pool reported, heavy and light are counted apart (ADR 0301); without one, every job shares
 * `capacity_max`.
 */
async function freePools(
  ctx: Pick<HandlerContext, "db" | "now">,
  runner: RunnerRow,
  reported?: z.infer<typeof capacitySchema>,
): Promise<{ heavy: boolean; light: boolean; split: boolean } | null> {
  const nowMs = Date.parse(ctx.now);
  if (!runner.accepting) return null;
  if (runner.rate_limited_until && Date.parse(runner.rate_limited_until) > nowMs) return null;
  const active = await activeRunsByPool(ctx, runner.id);
  // A pool the runner paused (ADR 0552: its load, or its tmux) gets nothing new.
  const paused = (reported ? reported.paused : runnerPaused(runner))?.pools ?? [];
  if (runner.light_max === null) {
    const any =
      paused.length === 0 &&
      Math.max(active.heavy + active.light, reported?.inUse ?? 0) < runner.capacity_max;
    return { heavy: any, light: any, split: false };
  }
  return {
    heavy:
      !paused.includes("heavy") &&
      Math.max(active.heavy, reported?.inUse ?? 0) < runner.capacity_max,
    light:
      !paused.includes("light") &&
      Math.max(active.light, reported?.light?.inUse ?? 0) < runner.light_max,
    split: true,
  };
}

/** The pause a runner last reported (ADR 0552), or null. */
function runnerPaused(
  runner: Pick<RunnerRow, "paused">,
): z.infer<typeof capacityPausedSchema> | null {
  const parsed = capacityPausedSchema.safeParse(parseJson<unknown>(runner.paused, null));
  return parsed.success ? parsed.data : null;
}

/**
 * The light pool is full and a light job is waiting that this runner could take: ask its oldest
 * idle planning session to yield (ADR 0301). Only one with nobody present and nothing undelivered
 * for PLANNING_YIELD_AFTER_MS, and only one request at a time per runner. An idle session never
 * yields while the pool has room: this is only called when it hasn't.
 */
export async function requestYield(
  ctx: Pick<HandlerContext, "db" | "now" | "write">,
  runnerId: string,
): Promise<string | null> {
  const before = new Date(Date.parse(ctx.now) - PLANNING_YIELD_AFTER_MS).toISOString();
  const pending = await ctx.db
    .selectFrom("core_planning_sessions")
    .select("id")
    .where("runner_id", "=", runnerId)
    .where("status", "in", ["idle", "yielding"])
    .where("yield_requested_at", "is not", null)
    .executeTakeFirst();
  if (pending) return null;
  const candidate = await ctx.db
    .selectFrom("core_planning_sessions as s")
    .select(["s.id", "s.work_item_id"])
    .where("s.runner_id", "=", runnerId)
    .where("s.status", "=", "idle")
    .where("s.idle_since", "<=", before)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("core_planning_presence as p")
            .select("p.user_id")
            .whereRef("p.work_item_id", "=", "s.work_item_id")
            .where("p.seen_at", ">", before),
        ),
      ),
    )
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("core_planning_events as e")
            .select("e.id")
            .whereRef("e.work_item_id", "=", "s.work_item_id")
            .whereRef("e.id", ">", "s.delivered_cursor")
            .where("e.type", "in", [...USER_EVENTS]),
        ),
      ),
    )
    .orderBy("s.idle_since")
    .limit(1)
    .executeTakeFirst();
  if (!candidate) return null;
  ctx.write(
    ctx.db
      .updateTable("core_planning_sessions")
      .set({ yield_requested_at: ctx.now, updated_at: ctx.now })
      .where("id", "=", candidate.id)
      .where("status", "=", "idle"),
  );
  ctx.write(
    ctx.db.insertInto("core_planning_events").values({
      work_item_id: candidate.work_item_id,
      type: "session.changed",
      actor_type: "agent",
      actor_id: "scheduler",
      payload: JSON.stringify({ yieldRequested: true }),
      at: ctx.now,
    }),
  );
  return candidate.id;
}

async function buildJob(
  ctx: HandlerContext,
  job: {
    id: string;
    stage: string;
    role: string;
    harness: string;
    requires: string;
    prompt: string;
    context: string;
    session_timeout_ms: number;
    tier?: string | null;
  },
  run: { id: string; run_no: number; branch: string; fencing_token: number },
  item: WorkItemRow,
  project: ProjectRow,
  leaseExpiresAt: string,
): Promise<Job> {
  const { policy } = await loadPolicy(ctx.db, project);
  // The item's repository (ADR 0490); placementRefusal already checked there is one.
  const repository = await itemRepository(ctx.db, item);
  if (!repository) {
    throw new OperationError("conflict", `work item #${item.number} has no repository`);
  }
  // The harness stays at least as narrow as the version the item started under (ADR 0370 §5).
  const pinned =
    item.policy_sha && item.policy_sha !== project.policy_sha
      ? (await loadPolicy(ctx.db, { id: project.id, policy_sha: item.policy_sha })).policy
      : null;
  const widened =
    pinned && policy
      ? policyImpact(pinned, policy, ctx.floor).changes.some(
          (c) => c.class === "loosens" && c.path.startsWith("harness"),
        )
      : false;
  const harnessProfile = widened ? pinned?.harness : policy?.harness;
  const role = job.role as ModelRole;
  const context = parseJson<Record<string, unknown>>(job.context, {});
  const planning = context.planning as Job["planning"] | undefined;
  return {
    jobId: job.id,
    runId: run.id,
    runNo: run.run_no,
    stage: job.stage as Job["stage"],
    workItem: { id: item.id, number: item.number, title: item.title },
    repo: {
      url: `https://github.com/${repository.owner}/${repository.name}.git`,
      owner: repository.owner,
      name: repository.name,
      baseRef: item.branch,
      defaultBranch: repository.default_branch,
    },
    branch: run.branch,
    harness: {
      id: job.harness as Job["harness"]["id"],
      role,
      model: resolveModel(role, policy?.modelRoles, job.tier === "light" ? "light" : "standard"),
      prompt: job.prompt,
      // From the project's config version (ADR 0370, 0270), never the run's own branch.
      ...(harnessProfile ? { profile: harnessProfile } : {}),
    },
    context,
    ...(job.stage === "planning" && planning ? { planning } : {}),
    requires: parseJson<Capability[]>(job.requires, []),
    limits: { sessionTimeoutMs: job.session_timeout_ms },
    lease: { fencingToken: run.fencing_token, expiresAt: leaseExpiresAt },
  };
}

export const jobClaim = defineOperation({
  name: "job.claim",
  description:
    "A runner host asks for its next job (pull, spike ADR 0100). The scheduler gives the oldest queued job this runner may take: capabilities and harness covered, the requester's own runner or one shared into the project, a free slot, not rate-limited, no kill switch, the project under its WIP limit for builds, the item not leased to someone else. Claiming takes the work item's lease with a new fencing token and creates the run and its branch name. The same claimId returns the same job.",
  risk: "write",
  actors: ["runner"],
  permission: "signed-in",
  input: z.object({
    claimId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
    manifest: capabilityManifestSchema,
    capacity: capacitySchema,
  }),
  output: z.object({ job: z.custom<Job>().nullable() }),
  async handler(input, ctx) {
    const runner = await loadRunner(ctx, ctx.actor.id);
    reportRunnerState(ctx, runner, input);
    const current = {
      ...runner,
      accepting: input.capacity.accepting ? 1 : 0,
      capacity_max: input.capacity.max,
      light_max: input.capacity.light?.max ?? null,
    };

    // A retried claim gets the job it already got.
    const prior = await ctx.db
      .selectFrom("core_jobs")
      .selectAll()
      .where("runner_id", "=", runner.id)
      .where("claim_id", "=", input.claimId)
      .executeTakeFirst();
    if (prior?.run_id) {
      const run = await ctx.db
        .selectFrom("core_runs")
        .selectAll()
        .where("id", "=", prior.run_id)
        .executeTakeFirstOrThrow();
      const item = await ctx.db
        .selectFrom("core_work_items")
        .selectAll()
        .where("id", "=", prior.work_item_id)
        .executeTakeFirstOrThrow();
      const project = await ctx.db
        .selectFrom("core_projects")
        .selectAll()
        .where("id", "=", item.project_id)
        .executeTakeFirstOrThrow();
      const lease = await ctx.db
        .selectFrom("core_leases")
        .select("expires_at")
        .where("work_item_id", "=", item.id)
        .executeTakeFirst();
      return { job: await buildJob(ctx, prior, run, item, project, lease?.expires_at ?? ctx.now) };
    }

    // Code older than the engine's compatibility level gets nothing (ADR 0520), whatever the runner
    // decides itself: one from before RUNNER_COMPAT, or one that can't update, may still claim.
    if ((runner.compat ?? 1) < RUNNER_COMPAT) return { job: null };

    const room = await freePools(ctx, current, input.capacity);
    if (!room || (!room.heavy && !room.light && !room.split)) return { job: null };
    // A light job this runner could take but for a full light pool: ask an idle session to yield.
    let lightBlocked = false;

    // Released work first: a shaping item's triage and planning jobs (ADR 0493) wait behind the
    // jobs of work people already committed to, then oldest first.
    const queued = await ctx.db
      .selectFrom("core_jobs")
      .selectAll()
      .where("status", "=", "queued")
      .orderBy(
        sql`(SELECT w.status = 'shaping' FROM core_work_items w WHERE w.id = core_jobs.work_item_id)`,
      )
      .orderBy("created_at")
      .limit(50)
      .execute();
    for (const job of queued) {
      const item = await ctx.db
        .selectFrom("core_work_items")
        .selectAll()
        .where("id", "=", job.work_item_id)
        .executeTakeFirst();
      const project = await ctx.db
        .selectFrom("core_projects")
        .selectAll()
        .where("id", "=", job.project_id)
        .executeTakeFirst();
      if (!item || !project) continue;
      // `shaping`: shaping stages before release runs its triage and planning jobs too (ADR 0493).
      if (!["running", "waiting", "shaping"].includes(item.status)) continue;
      if (!room[job.pool] && (job.pool !== "light" || !room.split || lightBlocked)) continue;
      const refusal = await placementRefusal(
        ctx,
        current,
        input.manifest,
        {
          stage: job.stage,
          requires: parseJson<Capability[]>(job.requires, []),
          harness: job.harness,
          pinnedRunnerId: job.pinned_runner_id,
        },
        item,
        project,
      );
      if (refusal) {
        const waitReason = refusal.wip ? WIP_WAIT_REASON : (refusal.waitReason ?? null);
        if (waitReason && job.wait_reason !== waitReason) {
          ctx.write(
            ctx.db
              .updateTable("core_jobs")
              .set({ wait_reason: waitReason })
              .where("id", "=", job.id),
          );
        }
        continue;
      }
      if (!room[job.pool]) {
        lightBlocked = true;
        continue;
      }

      const lease = await ctx.db
        .selectFrom("core_leases")
        .select("fencing_token")
        .where("work_item_id", "=", item.id)
        .executeTakeFirst();
      const previous = lease?.fencing_token ?? 0;
      const token = previous + 1;
      const lastRun = await ctx.db
        .selectFrom("core_runs")
        .select((eb) => eb.fn.max("run_no").as("n"))
        .where("work_item_id", "=", item.id)
        .executeTakeFirst();
      const runNo = (lastRun?.n ?? 0) + 1;
      const runId = newId("run");
      const branch = runBranch(item.branch, runNo);
      const expiresAt = new Date(Date.parse(ctx.now) + LEASE_TTL_MS).toISOString();

      ctx.write(
        ctx.db
          .updateTable("core_jobs")
          .set({
            status: "claimed",
            runner_id: runner.id,
            claim_id: input.claimId,
            run_id: runId,
            claimed_at: ctx.now,
            wait_reason: null,
          })
          .where("id", "=", job.id)
          .where("status", "=", "queued"),
      );
      ctx.guardChanged("job still queued");
      ctx.write(
        ctx.db.insertInto("core_runs").values({
          id: runId,
          job_id: job.id,
          work_item_id: item.id,
          run_no: runNo,
          stage: job.stage,
          runner_id: runner.id,
          branch,
          base_branch: item.branch,
          fencing_token: token,
          status: "claimed",
          started_at: ctx.now,
        }),
      );
      ctx.write(
        ctx.db
          .insertInto("core_leases")
          .values({
            work_item_id: item.id,
            holder_kind: "run",
            holder_id: runId,
            fencing_token: token,
            claimed_at: ctx.now,
            expires_at: expiresAt,
            released_at: null,
          })
          .onConflict((oc) =>
            oc
              .column("work_item_id")
              .doUpdateSet({
                holder_kind: "run",
                holder_id: runId,
                fencing_token: token,
                claimed_at: ctx.now,
                expires_at: expiresAt,
                released_at: null,
              })
              .where("core_leases.fencing_token", "=", previous),
          ),
      );
      ctx.guardChanged("fencing token unchanged");
      if (job.stage === "planning" && job.planning_session_id) {
        // The session lives on this runner from now on: a resume comes back here (ADR 0300).
        ctx.write(
          ctx.db
            .updateTable("core_planning_sessions")
            .set({ runner_id: runner.id, updated_at: ctx.now })
            .where("id", "=", job.planning_session_id)
            .where("current_job_id", "=", job.id),
        );
        ctx.write(
          ctx.db.insertInto("core_planning_events").values({
            work_item_id: item.id,
            type: "session.changed",
            actor_type: "runner",
            actor_id: runner.id,
            payload: JSON.stringify({ status: "claimed", runnerId: runner.id }),
            at: ctx.now,
          }),
        );
        ctx.emit({ kind: "planning.changed", payload: { workItemId: item.id } });
      }
      ctx.subject({ workItemId: item.id, projectId: project.id, orgId: item.org_id });
      ctx.change({
        entity: "run",
        id: runId,
        after: { jobId: job.id, runner: runner.id, branch, fencingToken: token },
      });
      return {
        job: await buildJob(
          ctx,
          job,
          { id: runId, run_no: runNo, branch, fencing_token: token },
          item,
          project,
          expiresAt,
        ),
      };
    }
    if (lightBlocked) await requestYield(ctx, runner.id);
    return { job: null };
  },
});

async function loadRun(ctx: HandlerContext, job: string) {
  const run = await ctx.db
    .selectFrom("core_runs")
    .selectAll()
    .where("job_id", "=", job)
    .executeTakeFirst();
  if (!run) throw new OperationError("not_found", `no run for job ${job}`);
  if (ctx.actor.type === "runner" && run.runner_id !== ctx.actor.id) {
    throw new OperationError("forbidden", "this job belongs to another runner");
  }
  return run;
}
const isActive = (status: string) => (ACTIVE_RUN as readonly string[]).includes(status);

export const runIssueToken = defineOperation({
  name: "run.issueToken",
  description:
    "Mint the job token for a running job: a short-lived GitHub App installation token for the job's one repo (ADR 0033). Never stored; every call mints a fresh one. The runner may push only the run branch with it (ADR 0052).",
  risk: "write",
  actors: ["runner"],
  permission: "signed-in",
  fenced: true,
  input: z.object({ jobId, fencingToken }),
  output: z.object({
    token: z.string(),
    expiresAt: z.string(),
    repo: z.object({ owner: z.string(), name: z.string() }),
    pushBranch: z.string(),
  }),
  redact: { output: (o) => ({ ...o, token: "[redacted]" }) },
  async handler(input, ctx) {
    const run = await loadRun(ctx, input.jobId);
    if (!isActive(run.status)) throw new OperationError("conflict", `run is ${run.status}`);
    const repository = requireRepository(ctx);
    const repo = await repoRef(ctx, repository);
    const minted = await ctx.services.github.mintRepoToken(repo);
    return {
      token: minted.token,
      expiresAt: minted.expiresAt,
      repo: { owner: repo.owner, name: repo.repo },
      pushBranch: run.branch,
    };
  },
});

export const runReportEvents = defineOperation({
  name: "run.reportEvents",
  description:
    "A running job's events (state changes, agent status, logs, tool calls), deduplicated on (run, seq).",
  risk: "write",
  actors: ["runner"],
  permission: "signed-in",
  fenced: true,
  input: z.object({ jobId, fencingToken, events: z.array(runnerEventSchema).max(500) }),
  output: z.object({ accepted: z.number() }),
  async handler(input, ctx) {
    const run = await loadRun(ctx, input.jobId);
    for (const e of input.events) {
      const { jobId: _job, seq, at, type, ...payload } = e;
      ctx.write(
        ctx.db
          .insertInto("core_run_events")
          .values({ run_id: run.id, seq, at, type, payload: JSON.stringify(payload) })
          .onConflict((oc) => oc.columns(["run_id", "seq"]).doNothing()),
      );
    }
    const states = input.events.filter((e) => e.type === "job.state");
    const last = states.at(-1);
    const mapped =
      last?.type === "job.state" && ["preparing", "running", "collecting"].includes(last.state)
        ? (last.state as "preparing" | "running" | "collecting")
        : null;
    const started = input.events.find((e) => e.type === "session.started");
    // A stream session handed to a person (ADR 0450): its resume command is the run's takeover.
    const handed = input.events.findLast((e) => e.type === "takeover");
    const takeover =
      handed?.type === "takeover"
        ? { label: "Resume in a terminal", hint: handed.hint }
        : started?.type === "session.started" && started.takeover
          ? started.takeover
          : null;
    if (isActive(run.status)) {
      ctx.write(
        ctx.db
          .updateTable("core_runs")
          .set({
            last_event_at: ctx.now,
            ...(mapped ? { status: mapped } : {}),
            ...(takeover ? { takeover: json(takeover) } : {}),
          })
          .where("id", "=", run.id),
      );
    }
    return { accepted: input.events.length };
  },
});

export const runAddArtifact = defineOperation({
  name: "run.addArtifact",
  description:
    "Store one artifact from a run (diff, log, screenshot, summary, usage). Ids are content hashes, so a re-upload is a no-op. Bodies over 512 KB are truncated.",
  risk: "write",
  actors: ["runner"],
  permission: "signed-in",
  fenced: true,
  input: z.object({ jobId, fencingToken, artifact: storedArtifactSchema }),
  output: z.object({ id: z.string() }),
  redact: { input: (i) => ({ ...i, artifact: { id: i.artifact.id, kind: i.artifact.kind } }) },
  async handler(input, ctx) {
    const run = await loadRun(ctx, input.jobId);
    const a = input.artifact as z.infer<typeof artifactSchema> & { id: string };
    const body =
      a.kind === "diff"
        ? a.patch
        : a.kind === "screenshot"
          ? a.base64
          : a.kind === "usage"
            ? JSON.stringify({ harness: a.harness, entries: a.entries, wallMs: a.wallMs ?? null })
            : a.text;
    const truncated = body.length > MAX_ARTIFACT_BODY;
    const meta =
      a.kind === "diff"
        ? { baseSha: a.baseSha, headSha: a.headSha, branch: a.branch, stats: a.stats }
        : a.kind === "screenshot"
          ? { url: a.url, contentType: a.contentType }
          : a.kind === "usage"
            ? { harness: a.harness, entries: a.entries, wallMs: a.wallMs ?? null }
            : {};
    ctx.write(
      ctx.db
        .insertInto("core_artifacts")
        .values({
          id: a.id,
          run_id: run.id,
          kind: a.kind,
          name: "name" in a ? a.name : null,
          meta: JSON.stringify({ ...meta, truncated }),
          body: truncated ? body.slice(0, MAX_ARTIFACT_BODY) : body,
          created_at: ctx.now,
        })
        .onConflict((oc) => oc.column("id").doNothing()),
    );
    return { id: a.id };
  },
});

export function finishRun(
  ctx: HandlerContext,
  run: { id: string; job_id: string; work_item_id: string; stage?: string },
  workflowId: string,
  status: "handed_back" | "failed",
  outcome: "completed" | "failed" | "timed_out" | "cancelled" | "stalled",
  fields: {
    summary?: string | null;
    headSha?: string | null;
    result?: string | null;
    reason: string | null;
  },
) {
  ctx.write(
    ctx.db
      .updateTable("core_runs")
      .set({
        status,
        outcome,
        summary: fields.summary ?? null,
        head_sha: fields.headSha ?? null,
        result: fields.result ?? null,
        ended_at: ctx.now,
      })
      .where("id", "=", run.id)
      .where("status", "in", [...ACTIVE_RUN]),
  );
  ctx.write(
    ctx.db
      .updateTable("core_jobs")
      .set({ status: status === "handed_back" ? "done" : "failed", finished_at: ctx.now })
      .where("id", "=", run.job_id),
  );
  // The run is over: free the lease (its fencing token stays, so it never goes down).
  ctx.write(
    ctx.db
      .updateTable("core_leases")
      .set({ holder_kind: null, holder_id: null, released_at: ctx.now })
      .where("work_item_id", "=", run.work_item_id)
      .where("holder_id", "=", run.id),
  );
  // A planning run's session stops holding a slot: yielded, or interrupted (ADR 0350).
  if (run.stage === "planning") planningRunEnded(ctx, run);
  ctx.emit({
    kind: "workflow.event",
    payload: {
      instanceId: workflowId,
      type: runEvent(run.job_id),
      payload: { runId: run.id, outcome, reason: fields.reason },
    },
  });
  ctx.change({
    entity: "run",
    id: run.id,
    after: { status, outcome, headSha: fields.headSha ?? null },
  });
}

export const runHandBack = defineOperation({
  name: "run.handBack",
  description:
    "A run hands back: its outcome, summary, artifacts, the branch it pushed and its head, and the stage's structured result. The branch must be the run's own branch, and for a build the pushed head is checked on GitHub; otherwise the run fails. The Workflow continues with the result.",
  risk: "write",
  actors: ["runner"],
  permission: "signed-in",
  fenced: true,
  input: z.object({
    jobId,
    fencingToken,
    outcome: z.enum(["completed", "failed", "timed_out", "cancelled"]),
    summary: z.string().max(20_000).optional(),
    artifactIds: z.array(z.string()),
    branch: z.string(),
    headSha: sha.optional(),
    result: z.unknown().optional(),
  }),
  output: z.object({ accepted: z.boolean(), reason: z.string().nullable() }),
  async handler(input, ctx) {
    const run = await loadRun(ctx, input.jobId);
    const w = requireWorkItem(ctx);
    if (!isActive(run.status)) {
      return { accepted: run.status === "handed_back", reason: `run already ${run.status}` };
    }
    const fail = (reason: string) => {
      finishRun(ctx, run, w.workflow_id, "failed", "failed", {
        summary: input.summary ?? null,
        reason,
      });
      return { accepted: false, reason };
    };
    // One branch per run (ADR 0035): the hand-back names the branch it pushed.
    if (input.branch !== run.branch) {
      return fail(`pushed ${input.branch}, but this run may only push ${run.branch}`);
    }
    if (input.outcome === "completed" && run.stage === "build") {
      if (!input.headSha) return fail("a build hand-back needs the pushed head SHA");
      const pushed = await ctx.services.github.getBranchSha(
        await repoRef(ctx, requireRepository(ctx)),
        run.branch,
      );
      if (pushed !== input.headSha) {
        return fail(`${run.branch} is at ${pushed ?? "nothing"} on GitHub, not ${input.headSha}`);
      }
    }
    const result = input.result === undefined ? null : JSON.stringify(input.result);
    if (result && result.length > MAX_RESULT) return fail("result too large");
    const ok = input.outcome === "completed";
    finishRun(ctx, run, w.workflow_id, ok ? "handed_back" : "failed", input.outcome, {
      summary: input.summary ?? null,
      headSha: input.headSha ?? null,
      result,
      reason: ok ? null : (input.summary ?? input.outcome),
    });
    return { accepted: true, reason: null };
  },
});

export const runRelease = defineOperation({
  name: "run.release",
  description:
    "A runner host released a job's workspace. Frees the lease (keeping its fencing token) and, if the run never handed back, fails it so the Workflow can retry. Allowed while a kill switch is on.",
  risk: "write",
  actors: ["runner"],
  permission: "signed-in",
  fenced: true,
  allowWhenKilled: true,
  input: z.object({
    jobId,
    fencingToken,
    finalState: z.enum(["handed_back", "failed"]),
    reason: z.string().max(2_000).optional(),
  }),
  output: z.object({ released: z.boolean() }),
  async handler(input, ctx) {
    const run = await loadRun(ctx, input.jobId);
    const w = requireWorkItem(ctx);
    ctx.write(
      ctx.db.updateTable("core_runs").set({ released_at: ctx.now }).where("id", "=", run.id),
    );
    ctx.write(
      ctx.db
        .updateTable("core_leases")
        .set({ holder_kind: null, holder_id: null, released_at: ctx.now })
        .where("work_item_id", "=", w.id)
        .where("holder_id", "=", run.id),
    );
    if (isActive(run.status)) {
      finishRun(ctx, run, w.workflow_id, "failed", "failed", {
        reason: input.reason ?? "released without a hand-back",
      });
    }
    return { released: true };
  },
});

export const runExpire = defineOperation({
  name: "run.expire",
  description:
    "Fail a run that went quiet (no hand-back before its stall timeout, or its lease expired): bumps the fencing token so a zombie run's writes are refused, fails the job and tells the Workflow. A job no runner has claimed yet is left queued.",
  risk: "write",
  actors: ["agent"],
  permission: "signed-in",
  input: z.object({ jobId, reason: z.string().max(2_000) }),
  output: z.object({ expired: z.boolean(), jobStatus: z.string() }),
  async handler(input, ctx) {
    const job = await ctx.db
      .selectFrom("core_jobs")
      .selectAll()
      .where("id", "=", input.jobId)
      .executeTakeFirst();
    if (!job) throw new OperationError("not_found", "no such job");
    if (job.status !== "claimed" || !job.run_id) return { expired: false, jobStatus: job.status };
    const run = await ctx.db
      .selectFrom("core_runs")
      .selectAll()
      .where("id", "=", job.run_id)
      .executeTakeFirstOrThrow();
    if (!isActive(run.status)) return { expired: false, jobStatus: job.status };
    const w = requireWorkItem(ctx);
    ctx.write(
      ctx.db
        .updateTable("core_leases")
        .set((eb) => ({
          fencing_token: eb("fencing_token", "+", 1),
          holder_kind: null,
          holder_id: null,
          released_at: ctx.now,
        }))
        .where("work_item_id", "=", w.id)
        .where("fencing_token", "=", run.fencing_token),
    );
    finishRun(ctx, run, w.workflow_id, "failed", "stalled", { reason: input.reason });
    return { expired: true, jobStatus: "failed" };
  },
});

// ---- leases for sessions (local Claude over MCP, later) ----

export const leaseClaim = defineOperation({
  name: "lease.claim",
  description:
    "Claim a work item's lease for a session (ADR 0021, 0035). Returns a fencing token that every later write must carry. A held, unexpired lease is refused, unless a person takes it over (`takeover`), which stops the cloud run: its next write is refused and its slot freed.",
  risk: "write",
  actors: ["human", "agent"],
  permission: "member",
  input: z.object({
    workItemId,
    holderId: z.string().min(1).max(100),
    ttlSeconds: z.number().int().min(30).max(3_600).default(600),
    takeover: z.boolean().default(false),
  }),
  output: z.object({ fencingToken: z.number(), expiresAt: z.string() }),
  async handler(input, ctx) {
    const w = requireWorkItem(ctx);
    if (input.takeover && ctx.actor.type !== "human") {
      throw new OperationError("forbidden", "only a person can take a work item over");
    }
    const lease = await ctx.db
      .selectFrom("core_leases")
      .selectAll()
      .where("work_item_id", "=", w.id)
      .executeTakeFirst();
    const held =
      lease?.holder_id &&
      lease.holder_id !== input.holderId &&
      lease.expires_at &&
      Date.parse(lease.expires_at) > Date.parse(ctx.now);
    if (held && !input.takeover) {
      throw new OperationError(
        "conflict",
        `held by a ${lease?.holder_kind} until ${lease?.expires_at}`,
      );
    }
    const previous = lease?.fencing_token ?? 0;
    const token = previous + 1;
    const expiresAt = new Date(Date.parse(ctx.now) + input.ttlSeconds * 1_000).toISOString();
    ctx.write(
      ctx.db
        .insertInto("core_leases")
        .values({
          work_item_id: w.id,
          holder_kind: "session",
          holder_id: input.holderId,
          fencing_token: token,
          claimed_at: ctx.now,
          expires_at: expiresAt,
          released_at: null,
        })
        .onConflict((oc) =>
          oc
            .column("work_item_id")
            .doUpdateSet({
              holder_kind: "session",
              holder_id: input.holderId,
              fencing_token: token,
              claimed_at: ctx.now,
              expires_at: expiresAt,
              released_at: null,
            })
            .where("core_leases.fencing_token", "=", previous),
        ),
    );
    ctx.guardChanged("fencing token unchanged");
    if (held && lease?.holder_kind === "run" && lease.holder_id) {
      const run = await ctx.db
        .selectFrom("core_runs")
        .selectAll()
        .where("id", "=", lease.holder_id)
        .executeTakeFirst();
      if (run && isActive(run.status)) {
        ctx.write(
          ctx.db
            .updateTable("core_runs")
            .set({ status: "cancelled", outcome: "cancelled", ended_at: ctx.now })
            .where("id", "=", run.id),
        );
        ctx.write(
          ctx.db
            .updateTable("core_jobs")
            .set({ status: "cancelled", finished_at: ctx.now })
            .where("id", "=", run.job_id),
        );
        ctx.emit({
          kind: "workflow.event",
          payload: {
            instanceId: w.workflow_id,
            type: runEvent(run.job_id),
            payload: { runId: run.id, outcome: "cancelled", reason: "taken over" },
          },
        });
      }
    }
    ctx.change({
      entity: "lease",
      id: w.id,
      before: { fencingToken: previous },
      after: { fencingToken: token, holder: input.holderId },
    });
    return { fencingToken: token, expiresAt };
  },
});

export const leaseHeartbeat = defineOperation({
  name: "lease.heartbeat",
  description: "Keep a session's lease alive. Refused (`fenced`) once someone else has claimed it.",
  risk: "write",
  actors: ["human", "agent"],
  permission: "member",
  fenced: true,
  input: z.object({
    workItemId,
    fencingToken,
    ttlSeconds: z.number().int().min(30).max(3_600).default(600),
  }),
  output: z.object({ expiresAt: z.string() }),
  async handler(input, ctx) {
    const expiresAt = new Date(Date.parse(ctx.now) + input.ttlSeconds * 1_000).toISOString();
    ctx.write(
      ctx.db
        .updateTable("core_leases")
        .set({ expires_at: expiresAt })
        .where("work_item_id", "=", input.workItemId)
        .where("fencing_token", "=", input.fencingToken),
    );
    return { expiresAt };
  },
});

export const leaseRelease = defineOperation({
  name: "lease.release",
  description:
    "Give a session's lease back. The fencing token stays where it is (it never goes down).",
  risk: "write",
  actors: ["human", "agent"],
  permission: "member",
  fenced: true,
  input: z.object({ workItemId, fencingToken }),
  output: z.object({ released: z.boolean() }),
  async handler(input, ctx) {
    ctx.write(
      ctx.db
        .updateTable("core_leases")
        .set({ holder_kind: null, holder_id: null, released_at: ctx.now })
        .where("work_item_id", "=", input.workItemId)
        .where("fencing_token", "=", input.fencingToken),
    );
    return { released: true };
  },
});

export const workItemPreviewRouting = defineOperation({
  name: "workItem.previewRouting",
  description:
    "Where new work on a project would run (spec 11): the runner the scheduler would place its build on (same placement rules as job.claim), the harness, the models for implement and review, the gates, and whether the build would wait on the WIP limit.",
  risk: "read",
  actors: ["human"],
  permission: "member",
  input: z.object({ projectId: z.string().min(1) }),
  output: z.object({
    runner: z
      .object({
        id: z.string(),
        name: z.string(),
        ownerUserId: z.string(),
        freeSlots: z.number(),
        max: z.number(),
      })
      .nullable(),
    candidates: z.array(
      z.object({ id: z.string(), name: z.string(), refusal: z.string().nullable() }),
    ),
    harness: z.string(),
    models: z.object({ implement: z.string(), review: z.string(), sameModel: z.boolean() }),
    gates: z.array(z.string()),
    waitReason: z.string().nullable(),
  }),
  async handler(_input, ctx) {
    const project = ctx.scope.project;
    if (!project) throw new OperationError("not_found", "no such project");
    const policy = ctx.scope.policy;
    const requester = ctx.actor.id;
    const runners = await ctx.db
      .selectFrom("core_runners")
      .selectAll()
      .where("revoked_at", "is", null)
      .orderBy("created_at")
      .execute();
    const nowMs = Date.parse(ctx.now);
    const candidates: {
      id: string;
      name: string;
      refusal: string | null;
      free: number;
      owner: string;
      max: number;
    }[] = [];
    for (const r of runners) {
      const manifest = parseJson<CapabilityManifest | null>(r.manifest, null);
      const refusal = await placementRefusal(
        ctx,
        r,
        manifest,
        { stage: "build", requires: policy?.requires.build ?? [], harness: "claude-code" },
        { id: "", org_id: project.org_id, project_id: project.id, requester_user_id: requester },
        project,
      );
      if (refusal?.reason.startsWith("runner is not the requester")) continue;
      // A build takes a heavy slot (ADR 0301).
      const active = (await activeRunsByPool(ctx, r.id)).heavy;
      const offline = !r.last_seen_at || nowMs - Date.parse(r.last_seen_at) > RUNNER_OFFLINE_MS;
      const busy = !(await freePools(ctx, r))?.heavy;
      candidates.push({
        id: r.id,
        name: r.name,
        refusal: refusal?.reason ?? (offline ? "offline" : busy ? "no free slot" : null),
        free: Math.max(0, r.capacity_max - active),
        owner: r.owner_user_id,
        max: r.capacity_max,
      });
    }
    // The requester's own runners first, then the most free slots (ADR 0023).
    const placeable = candidates
      .filter((c) => c.refusal === null || c.refusal === WIP_WAIT_REASON)
      .sort(
        (a, b) => Number(b.owner === requester) - Number(a.owner === requester) || b.free - a.free,
      );
    const pick = placeable[0];
    const gates = [
      `spec gate from ${policy?.spec.requiredFrom ?? "medium"} size`,
      "merge gate (always a person)",
    ];
    return {
      runner: pick
        ? {
            id: pick.id,
            name: pick.name,
            ownerUserId: pick.owner,
            freeSlots: pick.free,
            max: pick.max,
          }
        : null,
      candidates: candidates.map(({ id, name, refusal }) => ({ id, name, refusal })),
      harness: "claude-code",
      models: {
        implement: resolveModel("implement", policy?.modelRoles),
        review: resolveModel("review", policy?.modelRoles),
        sameModel:
          resolveModel("implement", policy?.modelRoles) ===
          resolveModel("review", policy?.modelRoles),
      },
      gates,
      waitReason:
        pick?.refusal === WIP_WAIT_REASON
          ? WIP_WAIT_REASON
          : pick
            ? null
            : "no runner can take it now",
    };
  },
});
