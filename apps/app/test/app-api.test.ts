import { describe, expect, it } from "vitest";
import { runOp, sessionInfo, syncPolicyFromGitHub } from "#/server/app-api";
import { recordingEngine, signIn, testEnv, uid } from "./helpers.ts";

describe("calling operations from the app", () => {
  it("runs as the signed-in person, from the app surface, with the form's idempotency key", async () => {
    const login = uid("gh-");
    const { engine, calls } = recordingEngine(() => ({
      ok: true,
      result: {
        status: "ok",
        output: { workItemId: "wi_1", number: 1, branch: "b", outcome: "created" },
        auditId: "au_1",
      },
    }));
    const appEnv = testEnv(engine, login);
    const { user, headers } = await signIn(appEnv, login);
    const result = await runOp(appEnv, headers, {
      name: "workItem.create",
      input: { projectId: "prj_1", body: "Add dark mode", source: "app", eventId: "e1" },
      idempotencyKey: "app:key-123",
    });
    expect(result).toMatchObject({ ok: true, status: "ok", output: { workItemId: "wi_1" } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("workItem.create");
    expect(calls[0]?.options.actor).toEqual({ type: "human", id: user.id });
    expect(calls[0]?.options.origin.surface).toBe("app");
    expect(calls[0]?.options.idempotencyKey).toBe("app:key-123");
  });

  it("refuses without a session and never reaches the engine", async () => {
    const { engine, calls } = recordingEngine();
    const result = await runOp(testEnv(engine), new Headers(), { name: "inbox.list", input: {} });
    expect(result).toMatchObject({ ok: false, code: "unauthenticated" });
    expect(calls).toHaveLength(0);
  });

  it("forwards only the app's operations: agent and runner operations are refused", async () => {
    const login = uid("gh-");
    const { engine, calls } = recordingEngine();
    const appEnv = testEnv(engine, login);
    const { headers } = await signIn(appEnv, login);
    for (const name of ["job.claim", "pr.merge", "policy.sync", "reviewPacket.record"]) {
      expect(await runOp(appEnv, headers, { name, input: {} })).toMatchObject({
        ok: false,
        code: "invalid_input",
      });
    }
    expect(calls).toHaveLength(0);
  });

  it("passes refusals and pending gates through with their codes", async () => {
    const login = uid("gh-");
    let reply: "refuse" | "pending" = "refuse";
    const { engine } = recordingEngine(() =>
      reply === "refuse"
        ? { ok: false, error: { code: "forbidden", message: "only an approver can merge" } }
        : { ok: true, result: { status: "pending", pendingActionId: "pa_1", auditId: "au_1" } },
    );
    const appEnv = testEnv(engine, login);
    const { headers } = await signIn(appEnv, login);
    const call = { name: "review.merge", input: { workItemId: "wi_1", openedFullDiff: false } };
    expect(await runOp(appEnv, headers, call)).toEqual({
      ok: false,
      code: "forbidden",
      message: "only an approver can merge",
    });
    reply = "pending";
    expect(await runOp(appEnv, headers, call)).toEqual({
      ok: true,
      status: "pending",
      pendingActionId: "pa_1",
    });
  });

  it("returns the user and their Personal org", async () => {
    const login = uid("gh-");
    const appEnv = testEnv(recordingEngine().engine, login);
    const { headers } = await signIn(appEnv, login);
    const info = await sessionInfo(appEnv, headers);
    expect(info?.user.githubLogin).toBe(login);
    expect(info?.orgs).toEqual([
      expect.objectContaining({ name: "Personal", kind: "personal", role: "owner" }),
    ]);
    expect(info?.personalOrgId).toBe(info?.orgs[0]?.id);
    expect(await sessionInfo(appEnv, new Headers())).toBeNull();
  });
});

describe("syncing .factory/policy.json", () => {
  const project = {
    id: "prj_1",
    repo: { owner: "timoconnellaus", name: "software-factory", defaultBranch: "main" },
  };
  const sha = "a".repeat(40);

  function engineWithProject() {
    return recordingEngine((name) =>
      name === "project.list"
        ? { ok: true, result: { status: "ok", output: { projects: [project] }, auditId: null } }
        : {
            ok: true,
            result: {
              status: "ok",
              output: { applied: true, valid: true, error: null },
              auditId: "au",
            },
          },
    );
  }

  it("reads the file from GitHub at the default branch's head, never from the browser", async () => {
    const login = uid("gh-");
    const { engine, calls } = engineWithProject();
    const appEnv = testEnv(engine, login);
    const { headers } = await signIn(appEnv, login);
    const fetched: string[] = [];
    const fakeFetch = (async (url: string) => {
      fetched.push(url);
      if (url.includes("/commits/main")) return Response.json({ sha });
      return new Response('{"version":1}');
    }) as unknown as typeof fetch;
    const result = await syncPolicyFromGitHub(appEnv, headers, "prj_1", fakeFetch);
    expect(result).toMatchObject({ ok: true, status: "ok" });
    expect(fetched).toEqual([
      "https://api.github.com/repos/timoconnellaus/software-factory/commits/main",
      `https://raw.githubusercontent.com/timoconnellaus/software-factory/${sha}/.factory/policy.json`,
    ]);
    const sync = calls.find((c) => c.name === "policy.sync");
    expect(sync?.input).toEqual({
      projectId: "prj_1",
      ref: "refs/heads/main",
      sha,
      content: '{"version":1}',
    });
  });

  it("records a missing file as null content (the project then fails closed)", async () => {
    const login = uid("gh-");
    const { engine, calls } = engineWithProject();
    const appEnv = testEnv(engine, login);
    const { headers } = await signIn(appEnv, login);
    const fakeFetch = (async (url: string) =>
      url.includes("/commits/")
        ? Response.json({ sha })
        : new Response("404", { status: 404 })) as unknown as typeof fetch;
    await syncPolicyFromGitHub(appEnv, headers, "prj_1", fakeFetch);
    expect(calls.find((c) => c.name === "policy.sync")?.input).toMatchObject({ content: null });
  });

  it("refuses a project the user can't see", async () => {
    const login = uid("gh-");
    const { engine, calls } = engineWithProject();
    const appEnv = testEnv(engine, login);
    const { headers } = await signIn(appEnv, login);
    const result = await syncPolicyFromGitHub(appEnv, headers, "prj_other", (async () => {
      throw new Error("no fetch expected");
    }) as unknown as typeof fetch);
    expect(result).toMatchObject({ ok: false, code: "not_found" });
    expect(calls.some((c) => c.name === "policy.sync")).toBe(false);
  });
});

describe("finding the GitHub App installation", () => {
  it("uses the user's own GitHub token to find the installation covering the repo", async () => {
    const { env } = await import("cloudflare:workers");
    const { findInstallation } = await import("#/server/app-api");
    const login = uid("gh-");
    const appEnv = testEnv(recordingEngine().engine, login);
    const { user, headers } = await signIn(appEnv, login);
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO core_account (id, user_id, account_id, provider_id, access_token, created_at, updated_at) VALUES (?, ?, '1', 'github', 'ghu_token', ?, ?)",
    )
      .bind(uid("acc_"), user.id, now, now)
      .run();
    const seen: string[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seen.push(`${url} ${(init.headers as Record<string, string>).authorization}`);
      if (url.includes("/user/installations?"))
        return Response.json({
          installations: [
            { id: 7, account: { login: "other" } },
            { id: 42, account: { login: "TimOConnellAus" } },
          ],
        });
      return Response.json({ repositories: [{ name: "software-factory" }] });
    }) as unknown as typeof fetch;
    const found = await findInstallation(
      appEnv,
      headers,
      { owner: "timoconnellaus", name: "software-factory" },
      fakeFetch,
    );
    expect(found).toEqual({ installationId: "42", reason: null });
    expect(seen.every((s) => s.endsWith("Bearer ghu_token"))).toBe(true);
    expect(seen.some((s) => s.includes("/installations/7/"))).toBe(false);
  });
});
