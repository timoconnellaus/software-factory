// Runner device login (ADR 0056), the OAuth device-flow shape: `sf-runner login` asks for a code
// (runner.deviceStart), shows the short user code and a link, and polls (runner.devicePoll). The
// person approves the code in the app (runner.approveDevice, human only), which registers a runner
// they own. The next poll hands the CLI its key, once. Nobody copies a key or a runner id.
//
// The CLI isn't anyone yet, so the runner channel calls deviceStart and devicePoll unsigned, as
// DEVICE_LOGIN_ACTOR. The device code is the CLI's secret (stored only as its SHA-256); the user code
// is useless without a signed-in person approving it.
import { DEVICE_APPROVE_PATH } from "@software-factory/runner-contract";
import { z } from "zod";
import type { Actor } from "../actors.ts";
import { OperationError } from "../errors.ts";
import { newId, newRunnerId } from "../ids.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import { randomToken, sha256Hex } from "./onboarding.ts";

/** The actor the runner channel uses for the two unsigned device-login calls. */
export const DEVICE_LOGIN_ACTOR: Actor = { type: "runner", id: "device-login" };
/** How long a code may wait for approval. */
export const DEVICE_CODE_TTL_MS = 10 * 60_000;
/** Seconds between polls. */
export const DEVICE_POLL_INTERVAL_S = 5;
/** No 0/O, 1/I/L, or vowels (no accidental words). */
const USER_CODE_ALPHABET = "BCDFGHJKMNPQRSTVWXZ23456789";

export function newUserCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const chars = Array.from(bytes, (b) => USER_CODE_ALPHABET[b % USER_CODE_ALPHABET.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

/** `bcdf ghjk`, `BCDFGHJK`, `bcdf-ghjk` → `BCDF-GHJK`. */
export function normalizeUserCode(text: string): string {
  const raw = text.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return raw.length === 8 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
}

const userCode = z.string().min(8).max(20).transform(normalizeUserCode);
const runnerName = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[\w .@-]+$/, "letters, digits, spaces and . _ @ - only");

async function byUserCode(ctx: HandlerContext, code: string) {
  const row = await ctx.db
    .selectFrom("core_runner_device_codes")
    .selectAll()
    .where("user_code", "=", code)
    .executeTakeFirst();
  if (!row) throw new OperationError("not_found", "no such code: check it against your terminal");
  return row;
}

const expired = (ctx: HandlerContext, row: { expires_at: string }) =>
  Date.parse(row.expires_at) <= Date.parse(ctx.now);

export const runnerDeviceStart = defineOperation({
  name: "runner.deviceStart",
  description:
    "Start a runner device login (`sf-runner login`, ADR 0056): returns a device code (the CLI's secret, for runner.devicePoll), a short user code for a person to approve in the app at /runners/connect, and when it expires (10 minutes). Called unsigned by the runner channel.",
  risk: "write",
  actors: ["runner"],
  permission: "signed-in",
  input: z.object({ name: runnerName.optional() }),
  output: z.object({
    deviceCode: z.string(),
    userCode: z.string(),
    /** Where the person approves it: the app's /runners/connect with the code filled in. */
    verificationUrl: z.string(),
    expiresAt: z.string(),
    interval: z.number(),
  }),
  redact: { output: (o) => ({ ...o, deviceCode: "[redacted]" }) },
  async handler(input, ctx) {
    if (ctx.actor.id !== DEVICE_LOGIN_ACTOR.id) {
      throw new OperationError("forbidden", "a paired runner doesn't need a device login");
    }
    const deviceCode = randomToken();
    const code = newUserCode();
    const expiresAt = new Date(Date.parse(ctx.now) + DEVICE_CODE_TTL_MS).toISOString();
    ctx.write(
      ctx.db.insertInto("core_runner_device_codes").values({
        id: newId("deviceCode"),
        device_code_hash: await sha256Hex(deviceCode),
        user_code: code,
        suggested_name: input.name ?? null,
        status: "pending",
        decided_by: null,
        runner_id: null,
        created_at: ctx.now,
        expires_at: expiresAt,
        decided_at: null,
        consumed_at: null,
      }),
    );
    const base = (ctx.services.publicBaseUrl ?? "").replace(/\/+$/, "");
    return {
      deviceCode,
      userCode: code,
      verificationUrl: `${base}${DEVICE_APPROVE_PATH}?code=${code}`,
      expiresAt,
      interval: DEVICE_POLL_INTERVAL_S,
    };
  },
});

export const runnerDevicePoll = defineOperation({
  name: "runner.devicePoll",
  description:
    "The CLI asks whether its device login was approved. `pending` until a person approves; then, once, `approved` with the runner id and its channel key (the code is spent: a second poll gets `expired`). `denied` or `expired` end the login. Called unsigned by the runner channel.",
  risk: "write",
  // Every few seconds during a login: audited once it settles (ADR 0590).
  audit: { changesOnly: true, changed: (out) => out.status !== "pending" },
  actors: ["runner"],
  permission: "signed-in",
  input: z.object({ deviceCode: z.string().min(20).max(200) }),
  output: z.object({
    status: z.enum(["pending", "approved", "denied", "expired"]),
    runnerId: z.string().nullable(),
    name: z.string().nullable(),
    keyVersion: z.number().nullable(),
    key: z.string().nullable(),
  }),
  redact: {
    input: () => ({ deviceCode: "[redacted]" }),
    output: (o) => ({ ...o, key: o.key ? "[redacted]" : null }),
  },
  async handler(input, ctx) {
    if (ctx.actor.id !== DEVICE_LOGIN_ACTOR.id) {
      throw new OperationError("forbidden", "a paired runner doesn't need a device login");
    }
    const none = { runnerId: null, name: null, keyVersion: null, key: null };
    const row = await ctx.db
      .selectFrom("core_runner_device_codes")
      .selectAll()
      .where("device_code_hash", "=", await sha256Hex(input.deviceCode))
      .executeTakeFirst();
    if (!row || row.status === "consumed") return { status: "expired" as const, ...none };
    if (row.status === "denied") return { status: "denied" as const, ...none };
    if (row.status === "pending") {
      return { status: expired(ctx, row) ? ("expired" as const) : ("pending" as const), ...none };
    }
    // Approved: hand the key over once. The guard makes a concurrent second poll fail.
    const runner = row.runner_id
      ? await ctx.db
          .selectFrom("core_runners")
          .select(["id", "name", "key_version", "revoked_at"])
          .where("id", "=", row.runner_id)
          .executeTakeFirst()
      : undefined;
    if (!runner || runner.revoked_at) return { status: "expired" as const, ...none };
    ctx.write(
      ctx.db
        .updateTable("core_runner_device_codes")
        .set({ status: "consumed", consumed_at: ctx.now })
        .where("id", "=", row.id)
        .where("status", "=", "approved"),
    );
    ctx.guardChanged("hand the key over once");
    ctx.change({ entity: "runner_device_code", id: row.id, after: { status: "consumed" } });
    return {
      status: "approved" as const,
      runnerId: runner.id,
      name: runner.name,
      keyVersion: runner.key_version,
      key: await ctx.services.runnerKey(runner.id, runner.key_version),
    };
  },
});

export const runnerDeviceLookup = defineOperation({
  name: "runner.deviceLookup",
  description:
    "What a runner login code is waiting for, so the app can show it before a person approves: the name the CLI suggested, its status and expiry.",
  risk: "read",
  actors: ["human"],
  permission: "signed-in",
  input: z.object({ userCode }),
  output: z.object({
    userCode: z.string(),
    suggestedName: z.string().nullable(),
    status: z.enum(["pending", "approved", "denied", "consumed", "expired"]),
    expiresAt: z.string(),
    /** Whether the person asking decided it (an approved code shows its runner only to them). */
    decidedByYou: z.boolean(),
    runnerId: z.string().nullable(),
  }),
  async handler(input, ctx) {
    const row = await byUserCode(ctx, input.userCode);
    const mine = row.decided_by === ctx.actor.id;
    return {
      userCode: row.user_code,
      suggestedName: row.suggested_name,
      status: row.status === "pending" && expired(ctx, row) ? ("expired" as const) : row.status,
      expiresAt: row.expires_at,
      decidedByYou: mine,
      runnerId: mine ? row.runner_id : null,
    };
  },
});

export const runnerApproveDevice = defineOperation({
  name: "runner.approveDevice",
  description:
    "Approve a runner login code shown by `sf-runner login` (ADR 0056): registers a runner owned by the person approving, under the name they give, and lets the waiting CLI collect its key once. Human only, for a pending, unexpired code; a code another person already decided is refused.",
  risk: "write",
  actors: ["human"],
  permission: "signed-in",
  browserOnly: true,
  input: z.object({ userCode, name: runnerName }),
  output: z.object({ runnerId: z.string(), name: z.string() }),
  async handler(input, ctx) {
    const row = await byUserCode(ctx, input.userCode);
    if (row.status !== "pending") {
      throw new OperationError(
        "conflict",
        row.decided_by === ctx.actor.id
          ? `you already ${row.status === "denied" ? "denied" : "approved"} this code`
          : "this code was already used: run `sf-runner login` again",
      );
    }
    if (expired(ctx, row)) {
      throw new OperationError("conflict", "this code expired: run `sf-runner login` again");
    }
    const runnerId = newRunnerId();
    ctx.write(
      ctx.db.insertInto("core_runners").values({
        id: runnerId,
        owner_user_id: ctx.actor.id,
        name: input.name,
        key_version: 1,
        created_at: ctx.now,
      }),
    );
    ctx.write(
      ctx.db
        .updateTable("core_runner_device_codes")
        .set({
          status: "approved",
          decided_by: ctx.actor.id,
          decided_at: ctx.now,
          runner_id: runnerId,
        })
        .where("id", "=", row.id)
        .where("status", "=", "pending"),
    );
    ctx.guardChanged("decide once");
    ctx.change({
      entity: "runner",
      id: runnerId,
      after: { name: input.name, owner: ctx.actor.id, via: "device login" },
    });
    return { runnerId, name: input.name };
  },
});

export const runnerDenyDevice = defineOperation({
  name: "runner.denyDevice",
  description:
    "Deny a runner login code: the waiting `sf-runner login` stops. For a code you didn't start.",
  risk: "write",
  actors: ["human"],
  permission: "signed-in",
  input: z.object({ userCode }),
  output: z.object({ denied: z.boolean() }),
  async handler(input, ctx) {
    const row = await byUserCode(ctx, input.userCode);
    if (row.status !== "pending")
      throw new OperationError("conflict", "this code was already decided");
    ctx.write(
      ctx.db
        .updateTable("core_runner_device_codes")
        .set({ status: "denied", decided_by: ctx.actor.id, decided_at: ctx.now })
        .where("id", "=", row.id)
        .where("status", "=", "pending"),
    );
    ctx.guardChanged("decide once");
    return { denied: true };
  },
});
