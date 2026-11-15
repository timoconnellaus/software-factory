// `sf call`, `sf ops` and how refusals read: log in again, use the app, or ask for write.
import { describe, expect, it } from "vitest";
import { APP, engine, loggedIn, Reply, scratchHome, sf } from "./helpers.ts";

const BROWSER_ONLY = {
  name: "cli.approveDevice",
  risk: "write",
  browserOnly: true,
  description: "Approve a CLI login. Browser-only.",
};

describe("sf call", () => {
  it("sends the op and its JSON input with the token and prints the result", async () => {
    const home = await scratchHome();
    await loggedIn(home);
    const e = engine({ "flow.item.get": (input) => ({ echo: input }) });
    const r = await sf(["call", "flow.item.get", `{"itemId":"fit_1"}`], {
      home,
      fetch: e.fetch,
    });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ echo: { itemId: "fit_1" } });
    expect(e.calls).toEqual([
      { op: "flow.item.get", input: { itemId: "fit_1" }, token: "sfc_token" },
    ]);
  });

  it("reads the input from stdin, and SF_TOKEN beats the stored token", async () => {
    const home = await scratchHome();
    await loggedIn(home);
    const e = engine({ "org.list": () => ({ ok: true }) });
    const r = await sf(["call", "org.list", "-"], {
      home,
      fetch: e.fetch,
      stdin: '{"orgId":"org_1"}',
      env: { SF_TOKEN: "sfc_agent" },
    });
    expect(r.code).toBe(0);
    expect(e.calls[0]).toEqual({ op: "org.list", input: { orgId: "org_1" }, token: "sfc_agent" });
  });

  it("rejects input that isn't JSON as a usage error", async () => {
    const home = await scratchHome();
    await loggedIn(home);
    const r = await sf(["call", "x.y", "{nope"], { home, fetch: engine({}).fetch });
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/^usage: the input isn't JSON/);
  });
});

describe("errors", () => {
  it("says to log in on a 401, and when there is no token at all", async () => {
    const home = await scratchHome();
    await loggedIn(home);
    const e = engine({
      "org.list": () => {
        throw new Reply(401, { error: "token revoked", code: "unauthenticated" });
      },
    });
    const r = await sf(["call", "org.list"], { home, fetch: e.fetch });
    expect(r.code).toBe(1);
    expect(r.err).toEqual(["unauthenticated: token revoked", "Run `sf login`."]);

    const env = await sf(["call", "org.list"], {
      home,
      fetch: e.fetch,
      env: { SF_TOKEN: "sfc_old" },
    });
    expect(env.err[1]).toMatch(/SF_TOKEN was refused/);

    const nobody = await sf(["call", "org.list"], { home: await scratchHome(), fetch: e.fetch });
    expect(nobody.code).toBe(1);
    expect(nobody.err).toEqual([
      "unauthenticated: not logged in (no stored token and no SF_TOKEN)",
      "Run `sf login`.",
    ]);
  });

  it("points a browser-only refusal at the app page where it's decided", async () => {
    const home = await scratchHome();
    await loggedIn(home, { scope: "write" });
    const e = engine(
      {
        "cli.approveDevice": () => {
          throw new Reply(403, {
            error: "cli.approveDevice is a decision you make in the app, not from cli (ADR 0340)",
            code: "forbidden",
          });
        },
      },
      [BROWSER_ONLY],
    );
    const r = await sf(["call", "cli.approveDevice", `{"userCode":"ABCD-EFGH"}`], {
      home,
      fetch: e.fetch,
    });
    expect(r.code).toBe(1);
    expect(r.err[0]).toBe(
      "forbidden: cli.approveDevice is a decision you make in the app, not from cli (ADR 0340)",
    );
    expect(r.err[1]).toBe(
      `cli.approveDevice is decided in the app, not from the CLI. Do it there: ${APP}`,
    );
  });

  it("explains a scope refusal for a read token", async () => {
    const home = await scratchHome();
    await loggedIn(home, { scope: "read" });
    const e = engine(
      {
        "flow.item.create": () => {
          throw new Reply(403, { error: "not for this token", code: "forbidden" });
        },
      },
      [{ name: "flow.item.create", risk: "write" }],
    );
    const r = await sf(["call", "flow.item.create", `{"orgId":"org_1"}`], {
      home,
      fetch: e.fetch,
    });
    expect(r.code).toBe(1);
    expect(r.err[1]).toMatch(/this token is read-only\. `sf login --write`/);
  });

  it("prints other engine errors as code: message", async () => {
    const home = await scratchHome();
    await loggedIn(home);
    const e = engine({
      "flow.item.get": () => {
        throw new Reply(404, { error: "no such item", code: "not_found" });
      },
    });
    const r = await sf(["call", "flow.item.get", `{"itemId":"fit_3"}`], { home, fetch: e.fetch });
    expect(r.code).toBe(1);
    expect(r.err).toEqual(["not_found: no such item"]);
  });
});

describe("sf ops", () => {
  it("lists operations with their risk and marks the browser-only ones", async () => {
    const home = await scratchHome();
    await loggedIn(home);
    const e = engine({}, [
      BROWSER_ONLY,
      { name: "org.list", risk: "read", description: "Your orgs. More text." },
    ]);
    const r = await sf(["ops"], { home, fetch: e.fetch });
    expect(r.code).toBe(0);
    expect(r.out).toEqual([
      "cli.approveDevice  write  browser-only  Approve a CLI login.",
      "org.list           read                 Your orgs.",
    ]);
  });
});

describe("sf logout", () => {
  it("revokes the token, then deletes it", async () => {
    const home = await scratchHome();
    await loggedIn(home);
    const e = engine({ "cliToken.revoke": () => ({ revoked: true }) });
    const r = await sf(["logout"], { home, fetch: e.fetch });
    expect(r.code).toBe(0);
    expect(e.calls).toEqual([
      { op: "cliToken.revoke", input: { tokenId: "clt_1" }, token: "sfc_token" },
    ]);
    const after = await sf(["status", "--json"], { home, fetch: e.fetch });
    expect(JSON.parse(after.stdout)).toMatchObject({ token: null, url: "https://engine.test" });
  });

  it("deletes the token even when revoking fails, and says so", async () => {
    const home = await scratchHome();
    await loggedIn(home);
    const e = engine({
      "cliToken.revoke": () => {
        throw new Reply(503, { error: "down", code: "unavailable" });
      },
    });
    const r = await sf(["logout"], { home, fetch: e.fetch });
    expect(r.code).toBe(1);
    expect(r.err[0]).toBe("Couldn't revoke the token on the factory (unavailable: down).");
    expect(r.err[1]).toMatch(/^Deleted it here anyway/);
    const after = await sf(["status"], { home, fetch: e.fetch });
    expect(after.code).toBe(1);
    expect(after.stdout).toContain("none: run `sf login`");
  });
});
