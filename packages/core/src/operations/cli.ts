// The sf CLI's login and tokens (ADR 0340, spec 07), the device-flow shape of the runner's login
// (ADR 0056): `sf login` asks for a code (cli.deviceStart), shows the short user code and a link,
// and polls (cli.devicePoll). The person approves the code in the app (cli.approveDevice,
// browser-only) and picks the token's scope there. The next poll mints the token and hands it
// over once; only its SHA-256 is stored. Tokens act as the person, on the `cli` surface, and can
// never decide a gate (`browserOnly` operations are refused off the app).
//
// The CLI isn't anyone yet, so sf-engine's /cli/v1 calls deviceStart and devicePoll unsigned, as
// CLI_DEVICE_ACTOR.
import type { CliScope } from "@software-factory/db";
import { z } from "zod";
import type { Actor } from "../actors.ts";
import { OperationError } from "../errors.ts";
import { newId } from "../ids.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";
import {
  DEVICE_CODE_TTL_MS,
  DEVICE_POLL_INTERVAL_S,
  newUserCode,
  normalizeUserCode,
} from "./devices.ts";
import { randomToken, sha256Hex } from "./onboarding.ts";

/** The actor /cli/v1 uses for the two unsigned device-login calls. No signed caller can be it. */
export const CLI_DEVICE_ACTOR: Actor = { type: "runner", id: "cli-device-login" };
/** Where a person approves a CLI login in the app. */
export const CLI_APPROVE_PATH = "/cli/connect";
/** How long a CLI token lasts. */
export const CLI_TOKEN_TTL_MS = 30 * 24 * 3_600_000;
/** CLI tokens start with this, so they're recognisable in a leak scan. */
export const CLI_TOKEN_PREFIX = "sfc_";

const scope = z.enum(["read", "write"]);
const userCode = z.string().min(8).max(20).transform(normalizeUserCode);
const clientName = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[\w .@:/-]+$/, "letters, digits, spaces and . _ @ : / - only");

const expired = (ctx: HandlerContext, row: { expires_at: string }) =>
  Date.parse(row.expires_at) <= Date.parse(ctx.now);

async function byUserCode(ctx: HandlerContext, code: string) {
  const row = await ctx.db
    .selectFrom("core_cli_device_codes")
    .selectAll()
    .where("user_code", "=", code)
    .executeTakeFirst();
  if (!row) throw new OperationError("not_found", "no such code: check it against your terminal");
  return row;
}

function requireDeviceActor(ctx: HandlerContext) {
  if (ctx.actor.id !== CLI_DEVICE_ACTOR.id) {
    throw new OperationError("forbidden", "only the CLI's device login calls this");
  }
}

/** A CLI token as its owner sees it: never the token itself. */
export interface CliTokenRow {
  id: string;
  user_id: string;
  scope: CliScope;
  expires_at: string;
  revoked_at: string | null;
}

/**
 * The person and scope behind a CLI bearer token, or null when it's unknown, revoked or expired.
 * A read: the /cli/v1 endpoint calls it before `invoke()`, which then audits as that person.
 */
export async function resolveCliToken(
  db: HandlerContext["db"],
  token: string,
  now: string,
): Promise<CliTokenRow | null> {
  if (!token.startsWith(CLI_TOKEN_PREFIX)) return null;
  const row = await db
    .selectFrom("core_cli_tokens")
    .select(["id", "user_id", "scope", "expires_at", "revoked_at"])
    .where("token_hash", "=", await sha256Hex(token))
    .where("kind", "=", "cli")
    .executeTakeFirst();
  if (!row || row.revoked_at || Date.parse(row.expires_at) <= Date.parse(now)) return null;
  return row;
}

export const cliDeviceStart = defineOperation({
  name: "cli.deviceStart",
  description:
    "Start an `sf login` (ADR 0340): returns a device code (the CLI's secret, for cli.devicePoll), a short user code for the person to approve in the app at /cli/connect, and when it expires (10 minutes). The CLI may ask for `write`; the person picks the scope when approving. Called unsigned by sf-engine's /cli/v1.",
  risk: "write",
  actors: ["runner"],
  permission: "signed-in",
  input: z.object({ name: clientName.optional(), scope: scope.default("read") }),
  output: z.object({
    deviceCode: z.string(),
    userCode: z.string(),
    verificationUrl: z.string(),
    expiresAt: z.string(),
    interval: z.number(),
  }),
  redact: { output: (o) => ({ ...o, deviceCode: "[redacted]" }) },
  async handler(input, ctx) {
    requireDeviceActor(ctx);
    const deviceCode = randomToken();
    const code = newUserCode();
    const expiresAt = new Date(Date.parse(ctx.now) + DEVICE_CODE_TTL_MS).toISOString();
    ctx.write(
      ctx.db.insertInto("core_cli_device_codes").values({
        id: newId("cliDeviceCode"),
        device_code_hash: await sha256Hex(deviceCode),
        user_code: code,
        client_name: input.name ?? null,
        requested_scope: input.scope,
        granted_scope: null,
        decided_by: null,
        token_id: null,
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
      verificationUrl: `${base}${CLI_APPROVE_PATH}?code=${code}`,
      expiresAt,
      interval: DEVICE_POLL_INTERVAL_S,
    };
  },
});

export const cliDevicePoll = defineOperation({
  name: "cli.devicePoll",
  description:
    "`sf login` asks whether its code was approved. `pending` until a person approves; then, once, `approved` with a new CLI token (scope as the person granted, 30 days) and its id; the code is then spent. `denied` or `expired` end the login. Called unsigned by sf-engine's /cli/v1.",
  risk: "write",
  // Every few seconds during a login: audited once it settles (ADR 0590).
  audit: { changesOnly: true, changed: (out) => out.status !== "pending" },
  actors: ["runner"],
  permission: "signed-in",
  input: z.object({ deviceCode: z.string().min(20).max(200) }),
  output: z.object({
    status: z.enum(["pending", "approved", "denied", "expired"]),
    token: z.string().nullable(),
    tokenId: z.string().nullable(),
    scope: scope.nullable(),
    expiresAt: z.string().nullable(),
    login: z.string().nullable(),
  }),
  redact: {
    input: () => ({ deviceCode: "[redacted]" }),
    output: (o) => ({ ...o, token: o.token ? "[redacted]" : null }),
  },
  async handler(input, ctx) {
    requireDeviceActor(ctx);
    const none = { token: null, tokenId: null, scope: null, expiresAt: null, login: null };
    const row = await ctx.db
      .selectFrom("core_cli_device_codes")
      .selectAll()
      .where("device_code_hash", "=", await sha256Hex(input.deviceCode))
      .executeTakeFirst();
    if (!row || row.status === "consumed") return { status: "expired" as const, ...none };
    if (row.status === "denied") return { status: "denied" as const, ...none };
    if (row.status === "pending") {
      return { status: expired(ctx, row) ? ("expired" as const) : ("pending" as const), ...none };
    }
    // Approved, but not collected within the code's life: start again.
    if (!row.decided_by || !row.granted_scope || expired(ctx, row)) {
      return { status: "expired" as const, ...none };
    }
    const user = await ctx.db
      .selectFrom("core_user")
      .select(["id", "github_login"])
      .where("id", "=", row.decided_by)
      .executeTakeFirst();
    if (!user) return { status: "expired" as const, ...none };
    // Mint the token now, so it exists in one place only: this response.
    const token = `${CLI_TOKEN_PREFIX}${randomToken(32)}`;
    const tokenId = newId("cliToken");
    const expiresAt = new Date(Date.parse(ctx.now) + CLI_TOKEN_TTL_MS).toISOString();
    ctx.write(
      ctx.db
        .updateTable("core_cli_device_codes")
        .set({ status: "consumed", consumed_at: ctx.now, token_id: tokenId })
        .where("id", "=", row.id)
        .where("status", "=", "approved"),
    );
    ctx.guardChanged("hand the token over once");
    ctx.write(
      ctx.db.insertInto("core_cli_tokens").values({
        id: tokenId,
        token_hash: await sha256Hex(token),
        user_id: user.id,
        name: row.client_name,
        scope: row.granted_scope,
        created_at: ctx.now,
        expires_at: expiresAt,
        revoked_at: null,
        device_id: null,
      }),
    );
    ctx.change({
      entity: "cli_token",
      id: tokenId,
      after: { user: user.id, scope: row.granted_scope, name: row.client_name },
    });
    return {
      status: "approved" as const,
      token,
      tokenId,
      scope: row.granted_scope,
      expiresAt,
      login: user.github_login ?? null,
    };
  },
});

export const cliDeviceLookup = defineOperation({
  name: "cli.deviceLookup",
  description:
    "What an `sf login` code is waiting for, so the app can show it before a person approves: the name the CLI gave, the scope it asked for, its status and expiry.",
  risk: "read",
  actors: ["human"],
  permission: "signed-in",
  input: z.object({ userCode }),
  output: z.object({
    userCode: z.string(),
    clientName: z.string().nullable(),
    requestedScope: scope,
    grantedScope: scope.nullable(),
    status: z.enum(["pending", "approved", "denied", "consumed", "expired"]),
    expiresAt: z.string(),
    decidedByYou: z.boolean(),
  }),
  async handler(input, ctx) {
    const row = await byUserCode(ctx, input.userCode);
    return {
      userCode: row.user_code,
      clientName: row.client_name,
      requestedScope: row.requested_scope,
      grantedScope: row.decided_by === ctx.actor.id ? row.granted_scope : null,
      status: row.status === "pending" && expired(ctx, row) ? ("expired" as const) : row.status,
      expiresAt: row.expires_at,
      decidedByYou: row.decided_by === ctx.actor.id,
    };
  },
});

export const cliApproveDevice = defineOperation({
  name: "cli.approveDevice",
  description:
    "Approve an `sf login` code (ADR 0340) and choose its scope: `read` (see work; right for agent sessions) or `write` (also create, attach and cancel work). Either way the token can never decide a gate. The waiting CLI then collects a token that acts as you, once. Browser-only, for a pending, unexpired code.",
  risk: "write",
  actors: ["human"],
  permission: "signed-in",
  browserOnly: true,
  input: z.object({ userCode, scope }),
  output: z.object({ approved: z.boolean(), scope }),
  async handler(input, ctx) {
    const row = await byUserCode(ctx, input.userCode);
    if (row.status !== "pending") {
      throw new OperationError(
        "conflict",
        row.decided_by === ctx.actor.id
          ? `you already ${row.status === "denied" ? "denied" : "approved"} this code`
          : "this code was already used: run `sf login` again",
      );
    }
    if (expired(ctx, row)) {
      throw new OperationError("conflict", "this code expired: run `sf login` again");
    }
    ctx.write(
      ctx.db
        .updateTable("core_cli_device_codes")
        .set({
          status: "approved",
          granted_scope: input.scope,
          decided_by: ctx.actor.id,
          decided_at: ctx.now,
        })
        .where("id", "=", row.id)
        .where("status", "=", "pending"),
    );
    ctx.guardChanged("decide once");
    ctx.change({
      entity: "cli_device_code",
      id: row.id,
      after: { status: "approved", scope: input.scope, by: ctx.actor.id },
    });
    return { approved: true, scope: input.scope };
  },
});

export const cliDenyDevice = defineOperation({
  name: "cli.denyDevice",
  description: "Deny an `sf login` code: the waiting CLI stops. For a code you didn't start.",
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
        .updateTable("core_cli_device_codes")
        .set({ status: "denied", decided_by: ctx.actor.id, decided_at: ctx.now })
        .where("id", "=", row.id)
        .where("status", "=", "pending"),
    );
    ctx.guardChanged("decide once");
    return { denied: true };
  },
});

export const cliTokenList = defineOperation({
  name: "cliToken.list",
  description:
    "Your CLI tokens (ADR 0340): id, name, scope, when made and when they expire or were revoked. Never the tokens themselves. A desktop app's token isn't one: it belongs to its device (`desktopDevice.list`).",
  risk: "read",
  actors: ["human"],
  permission: "signed-in",
  input: z.object({}),
  output: z.object({
    tokens: z.array(
      z.object({
        id: z.string(),
        name: z.string().nullable(),
        scope,
        createdAt: z.string(),
        expiresAt: z.string(),
        revokedAt: z.string().nullable(),
      }),
    ),
  }),
  async handler(_input, ctx) {
    const rows = await ctx.db
      .selectFrom("core_cli_tokens")
      .select(["id", "name", "scope", "created_at", "expires_at", "revoked_at"])
      .where("user_id", "=", ctx.actor.id)
      // A desktop's token is its device's (ADR 0391): listed and revoked as the device, never here,
      // so revoking a "CLI token" can't sign a Mac out.
      .where("kind", "=", "cli")
      .orderBy("created_at", "desc")
      .limit(100)
      .execute();
    return {
      tokens: rows.map((r) => ({
        id: r.id,
        name: r.name,
        scope: r.scope,
        createdAt: r.created_at,
        expiresAt: r.expires_at,
        revokedAt: r.revoked_at,
      })),
    };
  },
});

export const cliTokenRevoke = defineOperation({
  name: "cliToken.revoke",
  description:
    "Revoke one of your CLI tokens (`sf logout`, or a token you no longer trust). It stops working at once. Only your own tokens, and only CLI ones: a desktop app's token is revoked with its device (`desktopDevice.revoke`).",
  risk: "write",
  actors: ["human"],
  permission: "signed-in",
  input: z.object({ tokenId: z.string().min(1).max(80) }),
  output: z.object({ revoked: z.boolean() }),
  async handler(input, ctx) {
    const row = await ctx.db
      .selectFrom("core_cli_tokens")
      .select(["id", "user_id", "kind", "revoked_at"])
      .where("id", "=", input.tokenId)
      .executeTakeFirst();
    if (!row || row.user_id !== ctx.actor.id)
      throw new OperationError("not_found", "no such token");
    if (row.kind !== "cli")
      throw new OperationError(
        "invalid_input",
        "That token belongs to a desktop app. Revoke the device instead (desktopDevice.revoke).",
      );
    if (row.revoked_at) return { revoked: false };
    ctx.write(
      ctx.db
        .updateTable("core_cli_tokens")
        .set({ revoked_at: ctx.now })
        .where("id", "=", row.id)
        .where("revoked_at", "is", null),
    );
    ctx.change({ entity: "cli_token", id: row.id, after: { revoked: true } });
    return { revoked: true };
  },
});
