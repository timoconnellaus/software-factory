// The sf CLI's door (ADR 0340, spec 07) end to end through sf-engine's /cli/v1: the device login,
// read and write tokens, browser-only decisions refused whatever the scope, the audit's `cli`
// surface, and revocation.
import { env } from "cloudflare:workers";
import { describeOperations, getOperation } from "@software-factory/core";
import { describe, expect, it } from "vitest";
import worker from "../src/index.ts";
import { all, first, ok, world } from "./helpers.ts";

type World = Awaited<ReturnType<typeof world>>;

const post = (path: string, body: unknown, token?: string) =>
  worker.fetch(
    new Request(`https://sf-engine.example/cli/v1/${path}`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    }),
    env,
  );

const json = async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T;

/** `sf login` against the endpoint, with the person approving in the app (`test` surface). */
async function login(w: World, scope: "read" | "write", ask: "read" | "write" = scope) {
  const started = await json<{ deviceCode: string; userCode: string; verificationUrl: string }>(
    await post("device/start", { name: "tim@m5", scope: ask }),
  );
  expect(started.verificationUrl).toContain(`/cli/connect?code=${started.userCode}`);
  const pending = await json<{ status: string }>(
    await post("device/poll", { deviceCode: started.deviceCode }),
  );
  expect(pending.status).toBe("pending");
  const looked = await ok<{ requestedScope: string; clientName: string }>(
    "cli.deviceLookup",
    { userCode: started.userCode },
    w.human,
  );
  expect(looked).toMatchObject({ requestedScope: ask, clientName: "tim@m5" });
  await ok("cli.approveDevice", { userCode: started.userCode, scope }, w.human);
  const res = await post("device/poll", { deviceCode: started.deviceCode });
  const got = await json<{ status: string; token: string; tokenId: string; scope: string }>(res);
  expect(got).toMatchObject({ status: "approved", scope });
  expect(got.token).toMatch(/^sfc_/);
  // Handed over once.
  const again = await json<{ status: string; token: string | null }>(
    await post("device/poll", { deviceCode: started.deviceCode }),
  );
  expect(again).toMatchObject({ status: "expired", token: null });
  return got;
}

const callOp = (token: string, op: string, input: unknown) => post("call", { op, input }, token);

describe("the sf CLI door (/cli/v1)", () => {
  it("logs in by device code, and a read token reads but can't write (criteria 1, 2, 4)", async () => {
    const w = await world();
    const { token } = await login(w, "read", "write"); // asked for write, granted read
    const inbox = await callOp(token, "inbox.list", {});
    expect(inbox.status).toBe(200);
    expect(await json(inbox)).toHaveProperty("result");
    const projects = await callOp(token, "project.list", { orgId: w.orgId });
    expect(projects.status).toBe(200);

    const create = await callOp(token, "workItem.create", {
      projectId: w.projectId,
      title: "From the terminal",
      body: "x",
      source: "cli",
      eventId: "e1",
    });
    expect(create.status).toBe(403);
    expect(await json(create)).toMatchObject({ code: "forbidden" });
  });

  it("a write token acts but can never decide a gate (criterion 3)", async () => {
    const w = await world();
    const { token } = await login(w, "write");
    const ops = await worker.fetch(
      new Request("https://sf-engine.example/cli/v1/ops", {
        headers: { authorization: `Bearer ${token}` },
      }),
      env,
    );
    const listed = await json<{ operations: { name: string; browserOnly: unknown }[] }>(ops);
    expect(listed.operations.find((o) => o.name === "review.merge")?.browserOnly).toBe(true);

    const created = await callOp(token, "workItem.create", {
      projectId: w.projectId,
      title: "From the terminal",
      source: "app",
      eventId: crypto.randomUUID(),
    });
    expect(created.status).toBe(200);
    const { result } = await json<{ result: { workItemId: string } }>(created);
    // Audited as the person, on the cli surface (criterion 4).
    const audited = await first<{ origin: string; actor_type: string; actor_id: string }>(
      "SELECT origin, actor_type, actor_id FROM core_audit WHERE operation = 'workItem.create' AND work_item_id = ?",
      result.workItemId,
    );
    expect(JSON.parse(String(audited?.origin)).surface).toBe("cli");
    expect(audited).toMatchObject({ actor_type: "human", actor_id: w.userId });

    for (const [op, input] of [
      ["review.merge", { workItemId: result.workItemId, openedFullDiff: true }],
      ["spec.approve", { workItemId: result.workItemId }],
      ["cli.approveDevice", { userCode: "BCDF-GHJK", scope: "write" }],
      ["killSwitch.set", { scope: "project", id: w.projectId, on: false }],
    ] as const) {
      const res = await callOp(token, op, input);
      const body = await json<{ code: string; error: string }>(res);
      expect([op, res.status, body.code]).toEqual([op, 403, "forbidden"]);
      expect(body.error).toMatch(/in the app/);
    }
    // Stopping things from a terminal is fine.
    const on = await callOp(token, "killSwitch.set", {
      scope: "project",
      id: w.projectId,
      on: true,
    });
    expect(on.status).toBe(200);
    await ok("killSwitch.set", { scope: "project", id: w.projectId, on: false }, w.human);

    const cancelled = await callOp(token, "workItem.cancel", {
      workItemId: result.workItemId,
      reason: "from the terminal",
    });
    expect(cancelled.status).toBe(200);
  });

  it("refuses unknown, revoked and other people's tokens (criterion 5)", async () => {
    const w = await world();
    const { token, tokenId } = await login(w, "read");
    expect((await callOp("sfc_nope", "inbox.list", {})).status).toBe(401);
    expect((await post("call", { op: "inbox.list", input: {} })).status).toBe(401);

    const other = await world();
    const otherLogin = await login(other, "write");
    const stolen = await callOp(otherLogin.token, "cliToken.revoke", { tokenId });
    expect(stolen.status).toBe(404);

    const listed = await ok<{ tokens: { id: string }[] }>("cliToken.list", {}, w.human);
    expect(listed.tokens.map((t) => t.id)).toContain(tokenId);
    await ok("cliToken.revoke", { tokenId }, w.human);
    expect((await callOp(token, "inbox.list", {})).status).toBe(401);
    // The token itself is never stored.
    const rows = await all<{ token_hash: string }>(
      "SELECT token_hash FROM core_cli_tokens WHERE id = ?",
      tokenId,
    );
    expect(rows[0]?.token_hash).not.toContain(token);
  });

  it("a denied code ends the login", async () => {
    const w = await world();
    const started = await json<{ deviceCode: string; userCode: string }>(
      await post("device/start", {}),
    );
    await ok("cli.denyDevice", { userCode: started.userCode }, w.human);
    const polled = await json<{ status: string }>(
      await post("device/poll", { deviceCode: started.deviceCode }),
    );
    expect(polled.status).toBe("denied");
  });

  it("marks every decision a person makes at a gate as browser-only", () => {
    for (const name of [
      "spec.approve",
      "spec.requestChanges",
      "review.merge",
      "review.sendBack",
      "approval.decide",
      "question.answer",
      "question.acceptDefaults",
      "runner.approveDevice",
      "runner.register",
      "runner.rotateKey",
      "cli.approveDevice",
    ]) {
      expect(getOperation(name)?.browserOnly, name).toBe(true);
    }
    // Any human-only operation that decides a pending action must be marked too.
    const unmarked = describeOperations().filter(
      (o) =>
        /^(spec|review|approval|question)\.(approve|requestChanges|merge|sendBack|decide|answer|acceptDefaults)$/.test(
          o.name,
        ) && o.browserOnly !== true,
    );
    expect(unmarked).toEqual([]);
  });
});
