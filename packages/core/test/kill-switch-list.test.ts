// killSwitch.list and turning a switch off against what was seen (ADR 0610, review of #165).
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { inputDigest, invoke } from "../src/index.ts";
import { call, deps, newItem, ok, world } from "./helpers.ts";

type Listed = {
  org: { on: boolean } | null;
  projects: { projectId: string; on: boolean; reason: string | null; epoch: number }[];
  more: boolean;
};

async function device(userId: string) {
  const id = `dsk_${crypto.randomUUID().replaceAll("-", "")}`;
  await env.DB.prepare(
    "INSERT INTO core_desktop_devices (id, user_id, name, public_key, key_storage, created_at, last_seen_at, revoked_at) VALUES (?, ?, 'M5', 'key', 'secure-enclave', ?, NULL, NULL)",
  )
    .bind(id, userId, new Date().toISOString())
    .run();
  return id;
}

describe("killSwitch.list", () => {
  it("lists the org's and its projects' switches, with their epochs", async () => {
    const w = await world();
    expect(await ok<Listed>("killSwitch.list", { orgId: w.orgId }, w.human)).toEqual({
      org: null,
      projects: [],
      more: false,
    });
    await ok(
      "killSwitch.set",
      { scope: "project", id: w.projectId, on: true, reason: "flaky deploys" },
      w.human,
    );
    const got = await ok<Listed>("killSwitch.list", { orgId: w.orgId }, w.human);
    expect(got.projects).toEqual([
      expect.objectContaining({
        projectId: w.projectId,
        on: true,
        reason: "flaky deploys",
        epoch: 1,
      }),
    ]);
  });

  it("refuses someone outside the org, and never lists another org's switches", async () => {
    const w = await world();
    const other = await world();
    await ok("killSwitch.set", { scope: "project", id: other.projectId, on: true }, other.human);
    const refused = await call("killSwitch.list", { orgId: other.orgId }, w.human).catch(
      (e: { code: string }) => e,
    );
    expect((refused as { code: string }).code).toBe("forbidden");
    const mine = await ok<Listed>("killSwitch.list", { orgId: w.orgId }, w.human);
    expect(mine.projects.map((p) => p.projectId)).not.toContain(other.projectId);
  });
});

describe("turning a switch off against the switch seen", () => {
  it("refuses an off for an epoch that was turned on again since", async () => {
    const w = await world();
    await newItem(w);
    await ok("killSwitch.set", { scope: "project", id: w.projectId, on: true }, w.human);
    await ok("killSwitch.set", { scope: "project", id: w.projectId, on: false, epoch: 1 }, w.human);
    await ok(
      "killSwitch.set",
      { scope: "project", id: w.projectId, on: true, reason: "again" },
      w.human,
    );
    const stale = await call(
      "killSwitch.set",
      { scope: "project", id: w.projectId, on: false, epoch: 1 },
      w.human,
    ).catch((e: { code: string }) => e);
    expect((stale as { code: string }).code).toBe("conflict");
  });

  it("asks every surface to say which switch it saw", async () => {
    const w = await world();
    await ok("killSwitch.set", { scope: "project", id: w.projectId, on: true }, w.human);
    const blind = await call(
      "killSwitch.set",
      { scope: "project", id: w.projectId, on: false },
      w.human,
    ).catch((e: { code: string }) => e);
    expect((blind as { code: string }).code).toBe("invalid_input");
  });

  it("asks the desktop to say which switch it saw", async () => {
    const w = await world();
    await ok("killSwitch.set", { scope: "project", id: w.projectId, on: true }, w.human);
    const deviceId = await device(w.userId);
    const r = await invoke(
      deps,
      "killSwitch.set",
      { scope: "project", id: w.projectId, on: false },
      { actor: w.human, origin: { surface: "desktop", deviceId, presence: undefined } },
    ).catch((e: { code: string }) => e);
    // Without a proof it's refused as browser-only first.
    expect((r as { code: string }).code).toBe("forbidden");
    // With a proof for exactly this call (as the door sets it), the handler asks for the epoch.
    const input = { scope: "project", id: w.projectId, on: false };
    const proven = await invoke(deps, "killSwitch.set", input, {
      actor: w.human,
      origin: {
        surface: "desktop",
        deviceId,
        presence: {
          op: "killSwitch.set",
          inputDigest: await inputDigest(input),
          challengeId: "pch_test",
        },
      },
    }).catch((e: { code: string }) => e);
    expect((proven as { code: string }).code).toBe("invalid_input");
  });
});
