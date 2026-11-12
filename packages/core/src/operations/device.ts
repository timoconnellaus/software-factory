// A person's devices, Macs and phones alike (ADR 0391, 0541): list them, revoke one, rename one or
// turn its approvals on or off. `desktopDevice.list` and `desktopDevice.revoke` are these under
// their first names (desktop.ts).
//
// Revoking a device revokes its tokens at once: the next call with one is `unauthenticated`, and
// its live socket is closed after commit (the outbox's `device.revoked`).
// Turning approvals *on* is itself a decision: only that device, with a presence proof for this
// exact call, can do it (a lost, unlocked phone can't turn its own approvals back on).
import { z } from "zod";
import { OperationError } from "../errors.ts";
import { defineOperation, type HandlerContext } from "../operation.ts";

const deviceId = z.string().regex(/^dsk_[0-9a-f]{32}$/);
const keyStorage = z.enum(["secure-enclave", "strongbox", "tee", "software"]);
const platform = z.enum(["macos", "android"]);
const name = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[\w .@:'’()-]+$/, "letters, digits, spaces and . _ @ : ' ( ) - only");

/** What the approval page, the devices list and You show of a phone's attestation. */
export const attestationSummary = z
  .object({
    securityLevel: z.string(),
    keyMintSecurityLevel: z.string(),
    verifiedBootState: z.string().nullable(),
    deviceLocked: z.boolean().nullable(),
    osVersion: z.number().nullable(),
    osPatchLevel: z.number().nullable(),
    downgraded: z.string().nullable(),
  })
  .nullable();

export function parseAttestation(text: string | null): z.infer<typeof attestationSummary> {
  if (!text) return null;
  try {
    const a = JSON.parse(text) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" ? v : null);
    const num = (v: unknown) => (typeof v === "number" ? v : null);
    return {
      securityLevel: str(a.securityLevel) ?? "unknown",
      keyMintSecurityLevel: str(a.keyMintSecurityLevel) ?? "unknown",
      verifiedBootState: str(a.verifiedBootState),
      deviceLocked: typeof a.deviceLocked === "boolean" ? a.deviceLocked : null,
      osVersion: num(a.osVersion),
      osPatchLevel: num(a.osPatchLevel),
      downgraded: str(a.downgraded),
    };
  } catch {
    return null;
  }
}

async function ownDevice(ctx: HandlerContext, id: string) {
  const row = await ctx.db
    .selectFrom("core_desktop_devices")
    .select(["id", "user_id", "name", "decides", "revoked_at", "platform"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row || row.user_id !== ctx.actor.id) throw new OperationError("not_found", "no such device");
  return row;
}

export const deviceList = defineOperation({
  name: "device.list",
  description:
    "Your devices, Macs and phones (ADR 0391, 0541): name, platform, where the key lives, whether it may approve, a phone's attested security level and patch level, when added, last seen and revoked, and which one is calling. Never a token or a key.",
  risk: "read",
  actors: ["human"],
  permission: "signed-in",
  input: z.object({}),
  output: z.object({
    devices: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        platform,
        keyStorage,
        decides: z.boolean(),
        attestation: attestationSummary,
        createdAt: z.string(),
        lastSeenAt: z.string().nullable(),
        revokedAt: z.string().nullable(),
        current: z.boolean(),
      }),
    ),
  }),
  async handler(_input, ctx) {
    const rows = await ctx.db
      .selectFrom("core_desktop_devices")
      .select([
        "id",
        "name",
        "platform",
        "key_storage",
        "decides",
        "attestation",
        "created_at",
        "last_seen_at",
        "revoked_at",
      ])
      .where("user_id", "=", ctx.actor.id)
      .orderBy("created_at", "desc")
      .limit(100)
      .execute();
    return {
      devices: rows.map((r) => ({
        id: r.id,
        name: r.name,
        platform: r.platform,
        keyStorage: r.key_storage,
        decides: r.decides === 1,
        attestation: parseAttestation(r.attestation),
        createdAt: r.created_at,
        lastSeenAt: r.last_seen_at,
        revokedAt: r.revoked_at,
        current: r.id === ctx.origin.deviceId,
      })),
    };
  },
});

export const deviceRevoke = defineOperation({
  name: "device.revoke",
  description:
    "Revoke one of your devices, a Mac or a phone (signing out, a lost phone, a Mac you no longer trust): its tokens stop working at once, it can't decide anything, and a phone's push registration goes (ADR 0541). Only your own devices; a device may revoke itself.",
  risk: "write",
  actors: ["human"],
  permission: "signed-in",
  input: z.object({ deviceId }),
  output: z.object({ revoked: z.boolean() }),
  async handler(input, ctx) {
    const row = await ownDevice(ctx, input.deviceId);
    if (row.revoked_at) return { revoked: false };
    ctx.write(
      ctx.db
        .updateTable("core_desktop_devices")
        .set({ revoked_at: ctx.now })
        .where("id", "=", row.id)
        .where("revoked_at", "is", null),
    );
    ctx.write(
      ctx.db
        .updateTable("core_cli_tokens")
        .set({ revoked_at: ctx.now })
        .where("device_id", "=", row.id)
        .where("revoked_at", "is", null),
    );
    ctx.emit({ kind: "device.revoked", payload: { userId: row.user_id, deviceId: row.id } });
    ctx.change({ entity: "desktop_device", id: row.id, after: { revoked: true } });
    return { revoked: true };
  },
});

export const deviceUpdate = defineOperation({
  name: "device.update",
  description:
    "Rename one of your devices, or turn its approvals off or on (ADR 0541). Off: the device can still do everything one tap does, but can't decide a gate. On: only that device itself, with a presence proof for this exact call (a fingerprint on the phone, Touch ID on the Mac). Defaults to the calling device.",
  risk: "write",
  actors: ["human"],
  permission: "signed-in",
  // Turning approvals on takes a proof from the device itself (checked in the handler).
  presenceSurfaces: ["desktop", "mobile"],
  input: z.object({
    deviceId: deviceId.optional(),
    name: name.optional(),
    decides: z.boolean().optional(),
  }),
  output: z.object({ deviceId: z.string(), name: z.string(), decides: z.boolean() }),
  async handler(input, ctx) {
    const id = input.deviceId ?? ctx.origin.deviceId;
    if (!id) throw new OperationError("invalid_input", "name the device (deviceId)");
    const row = await ownDevice(ctx, id);
    if (row.revoked_at) throw new OperationError("conflict", "this device was revoked");
    const turningOn = input.decides === true && row.decides === 0;
    if (turningOn && (ctx.origin.deviceId !== row.id || !ctx.presence)) {
      throw new OperationError(
        "forbidden",
        "approvals are turned on only from that device, with its fingerprint or Touch ID",
        { presenceRequired: true },
      );
    }
    const next = {
      name: input.name ?? row.name,
      decides: input.decides === undefined ? row.decides === 1 : input.decides,
    };
    ctx.write(
      ctx.db
        .updateTable("core_desktop_devices")
        .set({ name: next.name, decides: next.decides ? 1 : 0 })
        .where("id", "=", row.id)
        .where("revoked_at", "is", null),
    );
    ctx.guardChanged("the device is live");
    ctx.change({
      entity: "desktop_device",
      id: row.id,
      before: { name: row.name, decides: row.decides === 1 },
      after: next,
    });
    return { deviceId: row.id, ...next };
  },
});
