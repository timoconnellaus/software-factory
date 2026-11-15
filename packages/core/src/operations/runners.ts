// Runners (ADR 0014–0016, 0023, 0038, 0360, 0410, 0520): registration, keys, the owner's list, the
// account a runner's jobs use, and what a runner host reports on its heartbeat and claim. The runner
// channel in sf-engine maps each signed call to one of these operations with actor
// `{ type: "runner", id: <runner id> }`; the jobs themselves are the new core's (spec 70).

import { json, parseJson } from "@software-factory/db";
import {
  accountNameSchema,
  type CapabilityManifest,
  capabilityManifestSchema,
  capacityPausedSchema,
  capacitySchema,
  RUNNER_COMPAT,
  type RunnerAccounts,
  runnerAccountsSchema,
  runnerVersionSchema,
} from "@software-factory/runner-contract";
import { z } from "zod";
import { OperationError } from "../errors.ts";
import { newRunnerId } from "../ids.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { desiredRunnerVersion } from "../services.ts";

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
    /** A claim signed in the same second as the heartbeat before it still reports (claims only). */
    sameSecond?: boolean;
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
  // A heartbeat or claim is audited when it changes what a person looks for after an incident
  // (ADR 0590): whether the runner takes work (accepting, paused, rate limit), its code (version,
  // update state, compat), its manifest or accounts, or the owner's account pick settling. Capacity
  // in use and last seen change on every beat and are not audited.
  const paused = report.capacity.paused ? json(report.capacity.paused) : null;
  if (
    settled ||
    runner.accepting !== (report.capacity.accepting ? 1 : 0) ||
    pauseKey(runnerPaused(runner)) !== pauseKey(report.capacity.paused ?? null) ||
    runner.capacity_max !== report.capacity.max ||
    runner.light_max !== (report.capacity.light?.max ?? null) ||
    json(report.manifest) !== runner.manifest ||
    (report.rateLimitedUntil !== undefined &&
      report.rateLimitedUntil !== runner.rate_limited_until) ||
    (report.version !== undefined &&
      (report.version.sha !== runner.version ||
        (report.version.autoUpdate ? 1 : 0) !== runner.auto_update ||
        report.version.update.state !== runner.update_state ||
        report.version.update.target !== runner.update_target)) ||
    (report.accounts !== undefined && json(report.accounts) !== runner.accounts) ||
    (report.compat !== undefined && report.compat !== runner.compat)
  ) {
    ctx.changed();
  }
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
        paused,
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
            eb("last_signed_at", report.sameSecond ? "<=" : "<", report.signedAt ?? 0),
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
    "A runner host reports its manifest, capacity, rate limit, code version and accounts. Answers the commit it should run, the engine's compatibility level, and commands: the owner's account pick, and a cancel for any held job the engine doesn't know (the new core renews its own flow jobs' leases before this).",
  risk: "write",
  // Every 20 s per runner: audited only when it changes the runner's state or sends a command
  // (ADR 0590).
  audit: { changesOnly: true, changed: (out) => out.commands.length > 0 },
  actors: ["runner"],
  permission: "signed-in",
  input: z.object({
    manifest: capabilityManifestSchema,
    capacity: capacitySchema,
    activeJobs: z.array(z.object({ jobId: z.string(), fencingToken: z.number().int() })),
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
    // reported state, which only a newer heartbeat may.
    const signedAt = ctx.origin.signedAt;
    const stale =
      signedAt !== undefined && runner.last_signed_at !== null && signedAt <= runner.last_signed_at;
    const { pendingAccount } = reportRunnerState(ctx, runner, {
      ...input,
      compat: input.compat ?? null,
      signedAt,
      stale,
    });
    const commands: (
      | { kind: "cancel"; jobId: string; reason: string }
      | { kind: "account.use"; name: string }
    )[] = [];
    // Sent on every heartbeat until the host reports the switch (ADR 0410).
    if (pendingAccount) commands.push({ kind: "account.use", name: pendingAccount });
    // The flow jobs a runner holds are renewed by the new core before this (apps/engine
    // flow/channel.ts); any other job is one of the old core's, which no longer exist.
    for (const held of input.activeJobs) {
      commands.push({ kind: "cancel", jobId: held.jobId, reason: "not assigned to this runner" });
    }
    return {
      commands,
      // The wire keeps `leases`: the channel adds the flow jobs' renewals to it.
      leases: [],
      desiredVersion: desiredVersion(ctx),
      minRunnerCompat: RUNNER_COMPAT,
    };
  },
});

/** The pause a runner last reported (ADR 0552), or null. */
/** A pause as audited: why and which pools, not the load figures that change every beat. */
function pauseKey(p: z.infer<typeof capacityPausedSchema> | null | undefined): string | null {
  return p ? JSON.stringify({ reason: p.reason, pools: [...p.pools].sort() }) : null;
}

function runnerPaused(
  runner: Pick<RunnerRow, "paused">,
): z.infer<typeof capacityPausedSchema> | null {
  const parsed = capacityPausedSchema.safeParse(parseJson<unknown>(runner.paused, null));
  return parsed.success ? parsed.data : null;
}

export const runnerClaim = defineOperation({
  name: "runner.claim",
  description:
    "A runner host asks for its next job. The new core offers its queued flow runs first (apps/engine flow/channel.ts); this records what the claim reports (manifest, capacity, signed time), so a claim replayed within the signing window changes nothing, and answers no job.",
  risk: "write",
  // Every 20 s per runner: audited only when it changes what a person looks for (ADR 0590).
  audit: { changesOnly: true },
  actors: ["runner"],
  permission: "signed-in",
  input: z.object({
    claimId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
    manifest: capabilityManifestSchema,
    capacity: capacitySchema,
  }),
  output: z.object({ job: z.null() }),
  async handler(input, ctx) {
    const runner = await loadRunner(ctx, ctx.actor.id);
    const signedAt = ctx.origin.signedAt;
    // One signed before the runner's last accepted heartbeat or claim (a replay) writes nothing.
    if (
      signedAt === undefined ||
      runner.last_signed_at === null ||
      signedAt >= runner.last_signed_at
    ) {
      reportRunnerState(ctx, runner, { ...input, signedAt, sameSecond: true });
    }
    return { job: null };
  },
});
