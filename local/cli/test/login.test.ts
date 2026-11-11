// `sf login` against a fake engine speaking the device-login wire (spec 07).
import { readFile, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { deviceLogin } from "../src/device-login.ts";
import { CliError } from "../src/errors.ts";
import { configPath, scratchHome, sf } from "./helpers.ts";

const START = {
  deviceCode: "dc_secret_secret_secret_secret",
  userCode: "BCDF-GHJK",
  verificationUrl: "/cli/connect?code=BCDF-GHJK",
  expiresAt: new Date(60_000).toISOString(),
  interval: 5,
};
// For runs through `sf`, whose clock is helpers' NOW.
const LATER = { ...START, expiresAt: "2026-11-12T12:10:00Z" };
const pending = {
  status: "pending",
  token: null,
  tokenId: null,
  scope: null,
  expiresAt: null,
  login: null,
};
const approved = (scope: "read" | "write") => ({
  status: "approved",
  token: "sfc_the_token_itself",
  tokenId: "clt_1",
  scope,
  expiresAt: "2026-12-12T00:00:00.000Z",
  login: "tim",
});

function fakeEngine(answers: unknown[], start = START) {
  const seen: { path: string; body: unknown }[] = [];
  const fetch = (async (input: string, init?: RequestInit) => {
    const path = new URL(input).pathname;
    const body = JSON.parse(String(init?.body ?? "{}"));
    seen.push({ path, body });
    if (path === "/cli/v1/device/start") return Response.json(start);
    const next = answers.shift();
    if (next instanceof Response) return next;
    return Response.json(next);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, seen };
}

function run(answers: unknown[], scope: "read" | "write" = "read") {
  const { fetch, seen } = fakeEngine(answers);
  const lines: string[] = [];
  const opened: string[] = [];
  let clock = 0;
  const result = deviceLogin({
    baseUrl: "https://engine.test/",
    appUrl: "https://app.test",
    name: "laptop",
    scope,
    fetch,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    print: (l) => lines.push(l),
    open: (u) => opened.push(u),
  });
  return { result, seen, lines, opened };
}

describe("sf login: the device flow", () => {
  it("shows the code and link, polls until approved, and returns the token", async () => {
    const { result, seen, lines, opened } = run([pending, pending, approved("write")], "write");
    await expect(result).resolves.toEqual({
      token: "sfc_the_token_itself",
      tokenId: "clt_1",
      scope: "write",
      expiresAt: "2026-12-12T00:00:00.000Z",
      login: "tim",
    });
    expect(lines).toContain("  https://app.test/cli/connect?code=BCDF-GHJK");
    expect(lines).toContain("and check the code: BCDF-GHJK");
    expect(opened).toEqual(["https://app.test/cli/connect?code=BCDF-GHJK"]);
    expect(seen[0]).toEqual({
      path: "/cli/v1/device/start",
      body: { scope: "write", name: "laptop" },
    });
    expect(seen.slice(1).map((s) => s.body)).toEqual(
      Array(3).fill({ deviceCode: START.deviceCode }),
    );
    expect(lines.join("\n")).not.toContain("sfc_the_token_itself");
  });

  it("stops on a denial, and when the code expires", async () => {
    await expect(run([{ ...pending, status: "denied" }]).result).rejects.toThrow(/denied/);
    await expect(run([{ ...pending, status: "expired" }]).result).rejects.toThrow(
      /BCDF-GHJK expired/,
    );
    const forever = run(Array(100).fill(pending));
    await expect(forever.result).rejects.toBeInstanceOf(CliError);
    await expect(forever.result).rejects.toMatchObject({ code: "expired" });
  });

  it("keeps polling through a 5xx, and stops on a 4xx", async () => {
    const blip = run([new Response("oops", { status: 503 }), approved("read")]);
    await expect(blip.result).resolves.toMatchObject({ scope: "read" });
    const refused = run([
      Response.json({ error: "unknown code", code: "not_found" }, { status: 404 }),
    ]);
    await expect(refused.result).rejects.toMatchObject({ code: "not_found" });
  });

  it("saves the token 0600, says which scope the person granted, and never prints the token", async () => {
    const home = await scratchHome();
    const { fetch } = fakeEngine([pending, approved("read")], LATER);
    const r = await sf(["login", "--write", "--url", "https://engine.test", "--no-open"], {
      home,
      fetch,
      env: { SF_APP_URL: "https://app.test" },
    });
    expect(r.code).toBe(0);
    expect(r.opened).toEqual([]);
    expect(r.stdout).toContain("Logged in as tim with a read token, until 2026-12-12.");
    expect(r.stdout).toContain("You asked for write; the app granted read.");
    expect(r.stdout).not.toContain("sfc_the_token_itself");
    const file = configPath(home);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({
      url: "https://engine.test",
      appUrl: "https://app.test",
      token: "sfc_the_token_itself",
      tokenId: "clt_1",
      scope: "read",
      login: "tim",
      expiresAt: "2026-12-12T00:00:00.000Z",
    });
  });

  it("ends a denied login with a non-zero exit and saves nothing", async () => {
    const home = await scratchHome();
    const { fetch } = fakeEngine([{ ...pending, status: "denied" }], LATER);
    const r = await sf(["login", "--url", "https://engine.test", "--no-open"], { home, fetch });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^denied: the login was denied/);
    await expect(stat(configPath(home))).rejects.toThrow();
  });
});
