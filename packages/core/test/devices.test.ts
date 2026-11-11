// Runner device login (ADR 0056): start → a person approves in the app → one poll gets the key.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { DEVICE_LOGIN_ACTOR, normalizeUserCode } from "../src/index.ts";
import { call, first, ok, refusal, rows, world } from "./helpers.ts";

type Started = { deviceCode: string; userCode: string; expiresAt: string; interval: number };
type Polled = {
  status: string;
  runnerId: string | null;
  name: string | null;
  keyVersion: number | null;
  key: string | null;
};

const startLogin = (name = "m5") => ok<Started>("runner.deviceStart", { name }, DEVICE_LOGIN_ACTOR);
const poll = (deviceCode: string) =>
  ok<Polled>("runner.devicePoll", { deviceCode }, DEVICE_LOGIN_ACTOR);

describe("runner device login", () => {
  it("hands the approved runner's key to the CLI once", async () => {
    const w = await world();
    const s = await startLogin("tims-m5");
    expect(s.userCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(s.interval).toBe(5);
    expect((s as Started & { verificationUrl: string }).verificationUrl).toBe(
      `/runners/connect?code=${s.userCode}`,
    );
    expect((await poll(s.deviceCode)).status).toBe("pending");

    const seen = await ok<{ suggestedName: string; status: string }>(
      "runner.deviceLookup",
      { userCode: s.userCode.toLowerCase().replace("-", " ") },
      w.human,
    );
    expect(seen).toMatchObject({ suggestedName: "tims-m5", status: "pending" });

    const approved = await ok<{ runnerId: string; name: string }>(
      "runner.approveDevice",
      { userCode: s.userCode, name: "M5 studio" },
      w.human,
    );
    const got = await poll(s.deviceCode);
    expect(got).toEqual({
      status: "approved",
      runnerId: approved.runnerId,
      name: "M5 studio",
      keyVersion: 1,
      key: `test-key:${approved.runnerId}:v1`,
    });
    const owner = await first<{ owner_user_id: string }>(
      "SELECT owner_user_id FROM core_runners WHERE id = ?",
      approved.runnerId,
    );
    expect(owner.owner_user_id).toBe(w.userId);

    // Single use: the key isn't handed out again.
    expect(await poll(s.deviceCode)).toMatchObject({ status: "expired", key: null });

    // Neither the device code nor the key reaches the audit journal.
    const audit = await rows<{ input: string; result: string | null }>(
      "SELECT input, result FROM core_audit WHERE operation IN ('runner.deviceStart', 'runner.devicePoll')",
    );
    for (const a of audit) {
      expect(a.input).not.toContain(s.deviceCode);
      expect(a.result ?? "").not.toContain(s.deviceCode);
      expect(a.result ?? "").not.toContain("test-key:");
    }
  });

  it("expires codes nobody approved in time", async () => {
    const w = await world();
    const s = await startLogin();
    await env.DB.prepare(
      "UPDATE core_runner_device_codes SET expires_at = '2000-01-01T00:00:00.000Z' WHERE user_code = ?",
    )
      .bind(s.userCode)
      .run();
    expect((await poll(s.deviceCode)).status).toBe("expired");
    const r = await refusal(
      call("runner.approveDevice", { userCode: s.userCode, name: "late" }, w.human),
    );
    expect(r.code).toBe("conflict");
    expect(r.message).toMatch(/expired/);
    expect(await rows("SELECT 1 FROM core_runners WHERE owner_user_id = ?", w.userId)).toHaveLength(
      0,
    );
  });

  it("can't be approved twice or taken over by another person", async () => {
    const tim = await world();
    const mallory = await world();
    const s = await startLogin();
    await ok("runner.approveDevice", { userCode: s.userCode, name: "m5" }, tim.human);
    const r = await refusal(
      call("runner.approveDevice", { userCode: s.userCode, name: "mine now" }, mallory.human),
    );
    expect(r.code).toBe("conflict");
    expect(r.message).toMatch(/already used/);
    const deny = await refusal(call("runner.denyDevice", { userCode: s.userCode }, mallory.human));
    expect(deny.code).toBe("conflict");
    // Another person's lookup doesn't learn the runner.
    const peek = await ok<{ status: string; runnerId: string | null; decidedByYou: boolean }>(
      "runner.deviceLookup",
      { userCode: s.userCode },
      mallory.human,
    );
    expect(peek).toMatchObject({ status: "approved", runnerId: null, decidedByYou: false });
    const got = await poll(s.deviceCode);
    const owner = await first<{ owner_user_id: string }>(
      "SELECT owner_user_id FROM core_runners WHERE id = ?",
      got.runnerId,
    );
    expect(owner.owner_user_id).toBe(tim.userId);
  });

  it("stops a denied login", async () => {
    const w = await world();
    const s = await startLogin();
    await ok("runner.denyDevice", { userCode: s.userCode }, w.human);
    expect((await poll(s.deviceCode)).status).toBe("denied");
  });

  it("approval is human only; start and poll are the unsigned channel's only", async () => {
    const w = await world();
    const s = await startLogin();
    const byRunner = await refusal(
      call(
        "runner.approveDevice",
        { userCode: s.userCode, name: "x" },
        { type: "runner", id: "r_abc123" },
      ),
    );
    expect(byRunner.code).toBe("forbidden");
    const byAgent = await refusal(
      call(
        "runner.approveDevice",
        { userCode: s.userCode, name: "x" },
        { type: "agent", id: "foreman" },
      ),
    );
    expect(byAgent.code).toBe("forbidden");
    const byHuman = await refusal(call("runner.deviceStart", {}, w.human));
    expect(byHuman.code).toBe("forbidden");
    const paired = await refusal(
      call("runner.devicePoll", { deviceCode: s.deviceCode }, { type: "runner", id: "r_abc123" }),
    );
    expect(paired.code).toBe("forbidden");
    expect((await poll("not-a-real-device-code-at-all")).status).toBe("expired");
  });

  it("normalizes what people type", () => {
    expect(normalizeUserCode("bcdf ghjk")).toBe("BCDF-GHJK");
    expect(normalizeUserCode("BCDFGHJK")).toBe("BCDF-GHJK");
  });
});
