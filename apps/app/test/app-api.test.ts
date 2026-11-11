import { describe, expect, it } from "vitest";
import { runOp, sessionInfo } from "#/server/app-api";
import { handleGitHubSetup } from "#/server/github-setup";
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

describe("the GitHub App's Setup URL (/integrations/github/setup)", () => {
  const setup = (query: string) =>
    new Request(`https://software-factory.example/integrations/github/setup?${query}`);

  it("sends a signed-out person to sign in, then back with GitHub's parameters", async () => {
    const { engine, calls } = recordingEngine();
    const r = await handleGitHubSetup(
      testEnv(engine),
      setup("installation_id=7&setup_action=install&state=abc"),
    );
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe(
      `/sign-in?redirect=${encodeURIComponent("/integrations/github/setup?installation_id=7&setup_action=install&state=abc")}`,
    );
    expect(calls).toHaveLength(0);
  });

  it("hands GitHub's installation and state to the engine as the signed-in person", async () => {
    const login = uid("gh-");
    const { engine, calls } = recordingEngine(() => ({
      ok: true,
      result: {
        status: "ok",
        output: {
          outcome: "connected",
          orgId: "org_1",
          installation: { account: login },
          linkedProjects: [],
        },
        auditId: "au",
      },
    }));
    const appEnv = testEnv(engine, login);
    const { user, headers } = await signIn(appEnv, login);
    const request = new Request(setup("installation_id=7&setup_action=install&state=s-123"), {
      headers,
    });
    const r = await handleGitHubSetup(appEnv, request);
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe(`/setup?github=connected&account=${login}`);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("github.connectInstallation");
    expect(calls[0]?.input).toEqual({
      installationId: "7",
      setupAction: "install",
      state: "s-123",
    });
    expect(calls[0]?.options.actor).toEqual({ type: "human", id: user.id });
  });

  it("shows the engine's refusal on Setup, and refuses a missing installation without calling it", async () => {
    const login = uid("gh-");
    const { engine, calls } = recordingEngine(() => ({
      ok: false,
      error: { code: "forbidden", message: "this GitHub connection was started by someone else" },
    }));
    const appEnv = testEnv(engine, login);
    const { headers } = await signIn(appEnv, login);
    const refused = await handleGitHubSetup(
      appEnv,
      new Request(setup("installation_id=7&state=stolen"), { headers }),
    );
    expect(
      new URL(refused.headers.get("location") ?? "", "http://x").searchParams.get("github_error"),
    ).toBe("this GitHub connection was started by someone else");
    const missing = await handleGitHubSetup(
      appEnv,
      new Request(setup("installation_id=abc&state=x"), { headers }),
    );
    expect(missing.headers.get("location")).toMatch(/github_error=/);
    expect(calls).toHaveLength(1);
  });

  it("is not an operation the browser can call", async () => {
    const login = uid("gh-");
    const { engine, calls } = recordingEngine();
    const appEnv = testEnv(engine, login);
    const { headers } = await signIn(appEnv, login);
    expect(
      await runOp(appEnv, headers, { name: "github.connectInstallation", input: {} }),
    ).toMatchObject({ ok: false, code: "invalid_input" });
    expect(calls).toHaveLength(0);
  });
});
