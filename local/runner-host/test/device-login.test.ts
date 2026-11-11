// `sf-runner login` against a fake engine speaking the device-login wire (ADR 0056).
import { DEVICE_PATHS } from "@software-factory/runner-contract";
import { describe, expect, it } from "vitest";
import { DeviceLoginError, deviceLogin } from "../src/device-login.ts";

const START = {
  deviceCode: "dc_secret_secret_secret_secret",
  userCode: "BCDF-GHJK",
  verificationUrl: "/runners/connect?code=BCDF-GHJK",
  expiresAt: new Date(60_000).toISOString(),
  interval: 5,
};

function engine(answers: unknown[]) {
  const seen: { path: string; body: unknown }[] = [];
  const fetch = (async (input: string, init?: RequestInit) => {
    const path = new URL(input).pathname;
    const body = JSON.parse(String(init?.body ?? "{}"));
    seen.push({ path, body });
    if (path === DEVICE_PATHS.start) return Response.json(START);
    const next = answers.shift();
    if (next instanceof Response) return next;
    return Response.json(next);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, seen };
}

const pending = { status: "pending", runnerId: null, name: null, keyVersion: null, key: null };

function run(answers: unknown[], extra: { now?: () => number } = {}) {
  const { fetch, seen } = engine(answers);
  const lines: string[] = [];
  const opened: string[] = [];
  let clock = 0;
  const result = deviceLogin({
    baseUrl: "https://sf-engine.example/",
    appUrl: "https://app.example",
    name: "m5",
    fetch,
    sleep: async (ms) => {
      clock += ms;
    },
    now: extra.now ?? (() => clock),
    print: (l) => lines.push(l),
    open: (u) => opened.push(u),
  });
  return { result, seen, lines, opened };
}

describe("sf-runner login", () => {
  it("shows the code and link, polls until approved, and returns the key", async () => {
    const { result, seen, lines, opened } = run([
      pending,
      pending,
      { status: "approved", runnerId: "r_abc123", name: "M5", keyVersion: 1, key: "k".repeat(40) },
    ]);
    await expect(result).resolves.toEqual({
      runnerId: "r_abc123",
      name: "M5",
      key: "k".repeat(40),
    });
    expect(lines).toContain("  https://app.example/runners/connect?code=BCDF-GHJK");
    expect(lines).toContain("and check the code: BCDF-GHJK");
    expect(opened).toEqual(["https://app.example/runners/connect?code=BCDF-GHJK"]);
    expect(seen[0]).toEqual({ path: DEVICE_PATHS.start, body: { name: "m5" } });
    expect(seen.slice(1).map((s) => s.body)).toEqual(
      Array(3).fill({ deviceCode: START.deviceCode }),
    );
    // The key is never printed.
    expect(lines.join("\n")).not.toContain("kkkk");
  });

  it("stops on a denial, and when the code expires", async () => {
    await expect(run([{ ...pending, status: "denied" }]).result).rejects.toThrow(/denied/);
    await expect(run([{ ...pending, status: "expired" }]).result).rejects.toThrow(
      /BCDF-GHJK expired/,
    );
    const forever = run(Array(100).fill(pending));
    await expect(forever.result).rejects.toBeInstanceOf(DeviceLoginError);
  });

  it("rides out a 5xx while waiting, but not a refusal", async () => {
    const ok = run([
      new Response("bad gateway", { status: 502 }),
      { status: "approved", runnerId: "r_abc123", name: null, keyVersion: 1, key: "k".repeat(40) },
    ]);
    await expect(ok.result).resolves.toMatchObject({ runnerId: "r_abc123" });
    const refused = run([Response.json({ error: "invalid input" }, { status: 400 })]);
    await expect(refused.result).rejects.toThrow(/answered 400/);
  });
});
