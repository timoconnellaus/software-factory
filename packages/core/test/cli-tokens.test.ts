// CLI tokens and a desktop app's token (ADR 0340, 0391): both are rows in core_cli_tokens, but a
// desktop's token belongs to its device. `cliToken.list` shows only CLI tokens and `cliToken.revoke`
// refuses a desktop's, so revoking a "CLI token" can never sign a Mac out; that's
// `desktopDevice.revoke`, which revokes the device and its token together.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { first, ok, refusal, uid, world } from "./helpers.ts";

async function token(userId: string, kind: "cli" | "desktop", deviceId: string | null = null) {
  const id = uid("clt_");
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 86_400_000).toISOString();
  await env.DB.prepare(
    "INSERT INTO core_cli_tokens (id, token_hash, user_id, name, scope, kind, device_id, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, 'write', ?, ?, ?, ?, NULL)",
  )
    .bind(
      id,
      uid("hash_"),
      userId,
      kind === "cli" ? "sf CLI: M5" : "M5",
      kind,
      deviceId,
      now,
      expires,
    )
    .run();
  return id;
}

async function device(userId: string) {
  const id = `dsk_${crypto.randomUUID().replaceAll("-", "")}`;
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO core_desktop_devices (id, user_id, name, public_key, key_storage, created_at, last_seen_at, revoked_at) VALUES (?, ?, 'M5', 'key', 'secure-enclave', ?, NULL, NULL)",
  )
    .bind(id, userId, now)
    .run();
  return id;
}

describe("CLI tokens beside a desktop's token", () => {
  it("lists only CLI tokens", async () => {
    const w = await world();
    const cli = await token(w.userId, "cli");
    const dsk = await device(w.userId);
    await token(w.userId, "desktop", dsk);
    const listed = await ok<{ tokens: { id: string }[] }>("cliToken.list", {}, w.human);
    expect(listed.tokens.map((t) => t.id)).toEqual([cli]);
  });

  it("refuses to revoke a desktop's token, which stays working", async () => {
    const w = await world();
    const dsk = await device(w.userId);
    const desktopToken = await token(w.userId, "desktop", dsk);
    const e = await refusal(ok("cliToken.revoke", { tokenId: desktopToken }, w.human));
    expect(e.code).toBe("invalid_input");
    expect(e.message).toBe(
      "That token belongs to a desktop app. Revoke the device instead (desktopDevice.revoke).",
    );
    const row = await first<{ revoked_at: string | null }>(
      "SELECT revoked_at FROM core_cli_tokens WHERE id = ?",
      desktopToken,
    );
    expect(row.revoked_at).toBeNull();
  });

  it("still revokes a CLI token, and the device's revoke takes its token", async () => {
    const w = await world();
    const cli = await token(w.userId, "cli");
    expect(await ok("cliToken.revoke", { tokenId: cli }, w.human)).toEqual({ revoked: true });
    const dsk = await device(w.userId);
    const desktopToken = await token(w.userId, "desktop", dsk);
    expect(await ok("desktopDevice.revoke", { deviceId: dsk }, w.human)).toEqual({
      revoked: true,
    });
    const row = await first<{ revoked_at: string | null }>(
      "SELECT revoked_at FROM core_cli_tokens WHERE id = ?",
      desktopToken,
    );
    expect(row.revoked_at).not.toBeNull();
  });
});
