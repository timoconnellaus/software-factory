// `sf call`, `sf ops` and how refusals read: log in again, use the app, or ask for write.
import { describe, expect, it } from "vitest";
import { APP, engine, loggedIn, Reply, scratchHome, sf, wi } from "./helpers.ts";

const BROWSER_ONLY = {
  name: "review.merge",
  risk: "write",
  browserOnly: true,
  gateKind: "merge",
  description: "Approve the merge gate. Browser-only.",
};

describe("sf call", () => {
  it("sends the op and its JSON input with the token and prints the result", async () => {
    const home = await scratchHome();
    await loggedIn(home);
    const e = engine({ "workItem.get": (input) => ({ echo: input }) });
    const r = await sf(["call", "workItem.get", `{"workItemId":"${wi(1)}"}`], {
      home,
      fetch: e.fetch,
    });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ echo: { workItemId: wi(1) } });
    expect(e.calls).toEqual([
      { op: "workItem.get", input: { workItemId: wi(1) }, token: "sfc_token" },
    ]);
  });

  it("reads the input from stdin, and SF_TOKEN beats the stored token", async () => {
    const home = await scratchHome();
    await loggedIn(home);
    const e = engine({ "inbox.list": () => ({ ok: true }) });
    const r = await sf(["call", "inbox.list", "-"], {
      home,
      fetch: e.fetch,
      stdin: '{"orgId":"org_1"}',
      env: { SF_TOKEN: "sfc_agent" },
    });
    expect(r.code).toBe(0);
    expect(e.calls[0]).toEqual({ op: "inbox.list", input: { orgId: "org_1" }, token: "sfc_agent" });
  });

  it("prints a gate it opened as pending", async () => {
    const home = await scratchHome();
    await loggedIn(home);
    const e = engine({ "x.y": () => new Reply(202, { pending: true, pendingActionId: "pa_1" }) });
    const r = await sf(["call", "x.y"], { home, fetch: e.fetch });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ pending: true, pendingActionId: "pa_1" });
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
      "inbox.list": () => {
        throw new Reply(401, { error: "token revoked", code: "unauthenticated" });
      },
    });
    const r = await sf(["call", "inbox.list"], { home, fetch: e.fetch });
    expect(r.code).toBe(1);
    expect(r.err).toEqual(["unauthenticated: token revoked", "Run `sf login`."]);

    const env = await sf(["call", "inbox.list"], {
      home,
      fetch: e.fetch,
      env: { SF_TOKEN: "sfc_old" },
    });
    expect(env.err[1]).toMatch(/SF_TOKEN was refused/);

    const nobody = await sf(["inbox"], { home: await scratchHome(), fetch: e.fetch });
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
        "review.merge": () => {
          throw new Reply(403, {
            error: "review.merge is a decision you make in the app, not from cli (ADR 0340)",
            code: "forbidden",
          });
        },
      },
      [BROWSER_ONLY],
    );
    const r = await sf(["call", "review.merge", `{"workItemId":"${wi(7)}"}`], {
      home,
      fetch: e.fetch,
    });
    expect(r.code).toBe(1);
    expect(r.err[0]).toBe(
      "forbidden: review.merge is a decision you make in the app, not from cli (ADR 0340)",
    );
    expect(r.err[1]).toBe(
      `review.merge is decided in the app, not from the CLI. Do it there: ${APP}/work/${wi(7)}/review (or \`sf open ${wi(7)}\`)`,
    );
  });

  it("explains a scope refusal for a read token", async () => {
    const home = await scratchHome();
    await loggedIn(home, { scope: "read" });
    const e = engine(
      {
        "workItem.cancel": () => {
          throw new Reply(403, { error: "not for this token", code: "forbidden" });
        },
      },
      [{ name: "workItem.cancel", risk: "write" }],
    );
    const r = await sf(["call", "workItem.cancel", `{"workItemId":"${wi(1)}"}`], {
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
      "workItem.get": () => {
        throw new Reply(404, { error: "no such work item", code: "not_found" });
      },
    });
    const r = await sf(["show", wi(3)], { home, fetch: e.fetch });
    expect(r.code).toBe(1);
    expect(r.err).toEqual(["not_found: no such work item"]);
  });
});

describe("sf ops", () => {
  it("lists operations with their risk and marks the browser-only ones", async () => {
    const home = await scratchHome();
    await loggedIn(home);
    const e = engine({}, [
      BROWSER_ONLY,
      { name: "inbox.list", risk: "read", description: "What is waiting. More text." },
    ]);
    const r = await sf(["ops"], { home, fetch: e.fetch });
    expect(r.code).toBe(0);
    expect(r.out).toEqual([
      "inbox.list    read                 What is waiting.",
      "review.merge  write  browser-only  Approve the merge gate.",
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
