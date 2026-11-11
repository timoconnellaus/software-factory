// Number → id resolution and the friendly views, against a fake engine.
import { describe, expect, it } from "vitest";
import { APP, engine, item, loggedIn, prj, project, scratchHome, sf, wi } from "./helpers.ts";

describe("resolving <n>", () => {
  it("finds a number in the person's only project, finding their org with org.list", async () => {
    const home = await scratchHome();
    await loggedIn(home);
    const e = engine({
      "org.list": () => ({
        orgs: [{ id: "org_1", name: "Personal", kind: "personal", role: "owner" }],
      }),
      "project.list": () => ({ projects: [project(1, "Web")] }),
      "workItem.list": () => ({ items: [item(11), item(12)] }),
      "workItem.cancel": () => ({ cancelled: true }),
    });
    const r = await sf(["cancel", "12", "--reason", "not needed"], { home, fetch: e.fetch });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("Cancelled 12.");
    expect(e.calls.map((c) => [c.op, c.input])).toEqual([
      ["org.list", {}],
      ["project.list", { orgId: "org_1" }],
      ["workItem.list", { projectId: prj(1), number: 12, limit: 1 }],
      ["workItem.cancel", { workItemId: wi(12), reason: "not needed" }],
    ]);
  });

  it("asks for --project when there are several, and matches it by name", async () => {
    const home = await scratchHome();
    await loggedIn(home);
    const handlers = {
      "project.list": () => ({ projects: [project(1, "Web"), project(2, "Api")] }),
      "workItem.list": (input: Record<string, unknown>) => ({
        items: input.projectId === prj(2) ? [item(4, { projectId: prj(2) })] : [],
      }),
    };
    const e = engine(handlers);
    const many = await sf(["open", "4", "--org", "org_1"], { home, fetch: e.fetch });
    expect(many.code).toBe(1);
    expect(many.stderr).toBe("ambiguous: you have 2 projects; pass --project <name>: Web, Api");

    const r = await sf(["open", "#4", "--project", "api", "--org", "org_1"], {
      home,
      fetch: e.fetch,
    });
    expect(r.code).toBe(0);
    expect(r.out).toEqual([`${APP}/work/${wi(4)}`]);
    expect(r.opened).toEqual([`${APP}/work/${wi(4)}`]);
    // --org skips the org lookup.
    expect(e.calls.some((c) => c.op === "org.list")).toBe(false);
  });

  it("passes a wi_ id through, and says when a number isn't there", async () => {
    const home = await scratchHome();
    await loggedIn(home);
    const e = engine({
      "workItem.list": () => ({ items: [item(1)] }),
    });
    const direct = await sf(["open", wi(9), "--review", "--no-open"], { home, fetch: e.fetch });
    expect(direct.out).toEqual([`${APP}/work/${wi(9)}/review`]);
    expect(direct.opened).toEqual([]);
    expect(e.calls).toEqual([]);

    const missing = await sf(["open", "99", "--project", prj(1)], { home, fetch: e.fetch });
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(/^not_found: no work item #99 in prj_/);
  });

  it("says so when the person isn't in any org", async () => {
    const home = await scratchHome();
    await loggedIn(home);
    const e = engine({ "org.list": () => ({ orgs: [] }) });
    const r = await sf(["show", "3"], { home, fetch: e.fetch });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^no_org: you aren't in any org yet/);
  });
});

describe("views", () => {
  it("sf ls prints one aligned line per item", async () => {
    const home = await scratchHome();
    await loggedIn(home);
    const e = engine({
      "workItem.list": () => ({
        items: [
          item(12, { stage: "merge", status: "waiting", statusReason: "merge gate" }),
          item(3, { title: "Add the CLI", updatedAt: "2026-11-10T12:00:00Z" }),
        ],
      }),
    });
    const r = await sf(["ls", "--org", "org_1"], { home, fetch: e.fetch });
    expect(r.code).toBe(0);
    expect(r.out).toEqual([
      "#12  merge  waiting: merge gate  Item 12      1h ago",
      "#3   build  running              Add the CLI  2d ago",
    ]);
    expect(e.calls[0]?.input).toEqual({
      orgId: "org_1",
      status: ["running", "waiting", "paused"],
      limit: 50,
    });
  });

  it("sf show prints stage, status, queue place, open gates with links, runs and the packet", async () => {
    const home = await scratchHome();
    await loggedIn(home);
    const e = engine({
      "workItem.get": () => ({
        item: {
          ...item(12, { stage: "merge", status: "waiting", statusReason: "merge gate" }),
          prUrl: "https://github.com/o/web/pull/34",
          prNumber: 34,
          headSha: "abcdef1234",
        },
        stages: [],
        questions: [],
        gates: [
          {
            id: "pa_1",
            kind: "merge",
            operation: "review.merge",
            status: "pending",
            decision: null,
            assigneeUserId: null,
            createdAt: "2026-11-12T11:30:00Z",
          },
          {
            id: "pa_0",
            kind: "spec",
            operation: "spec.approve",
            status: "applied",
            decision: "approved",
            assigneeUserId: null,
            createdAt: "2026-11-11T11:30:00Z",
          },
        ],
        runs: [
          {
            id: "run_1",
            runNo: 1,
            stage: "build",
            runnerId: "r_1",
            status: "done",
            outcome: "success",
            summary: "Built it",
            takeover: null,
            startedAt: "2026-11-12T09:00:00Z",
            endedAt: "2026-11-12T10:00:00Z",
          },
        ],
        reviewPacket: {
          headSha: "abcdef1234",
          verdict: "pass",
          summary: "All criteria met",
          riskFlags: [],
          createdAt: "2026-11-12T11:00:00Z",
        },
        mergeQueue: { position: 2, ahead: [10] },
      }),
    });
    const r = await sf(["show", wi(12)], { home, fetch: e.fetch });
    expect(r.code).toBe(0);
    expect(r.out).toEqual([
      "#12 Item 12",
      `  id      ${wi(12)}`,
      "  kind    change (small)",
      "  stage   merge",
      "  status  waiting: merge gate",
      "  PR      https://github.com/o/web/pull/34",
      "  queue   2nd in the merge queue, after #10",
      `  link    ${APP}/work/${wi(12)}`,
      "",
      "Open gates (decide them in the app)",
      `  merge gate  review.merge  30m ago  ${APP}/work/${wi(12)}/review`,
      "",
      "Runs",
      "  #1  build  done  success  2h ago  Built it",
      "",
      "Review packet: pass on abcdef1, 1h ago",
      "  All criteria met",
      `  ${APP}/work/${wi(12)}/review`,
    ]);
  });

  it("sf new files work with source cli and a fresh event id", async () => {
    const home = await scratchHome();
    await loggedIn(home, { scope: "write" });
    const e = engine({
      "workItem.create": () => ({
        workItemId: wi(13),
        number: 13,
        branch: "factory/13-x",
        outcome: "created",
      }),
    });
    const r = await sf(["new", "Fix the login", "--body", "It loops.", "--project", prj(1)], {
      home,
      fetch: e.fetch,
    });
    expect(r.code).toBe(0);
    expect(r.out).toEqual(["Created #13: Fix the login", `  ${APP}/work/${wi(13)}`]);
    const input = e.calls[0]?.input ?? {};
    expect(input).toMatchObject({
      projectId: prj(1),
      title: "Fix the login",
      body: "It loops.",
      source: "cli",
    });
    expect(input.eventId).toMatch(/^cli:[0-9a-f-]{36}$/);
  });

  it("sf queue lists the queue head first", async () => {
    const home = await scratchHome();
    await loggedIn(home);
    const e = engine({
      "mergeQueue.list": () => ({
        entries: [
          {
            workItemId: wi(10),
            number: 10,
            title: "First",
            headSha: "1111111aaa",
            enqueuedAt: "2026-11-12T11:00:00Z",
          },
          {
            workItemId: wi(12),
            number: 12,
            title: "Second",
            headSha: "2222222bbb",
            enqueuedAt: "2026-11-12T11:50:00Z",
          },
        ],
      }),
    });
    const r = await sf(["queue", "--project", prj(1)], { home, fetch: e.fetch });
    expect(r.out).toEqual([
      "1.  #10  First   1111111  queued 1h ago",
      "2.  #12  Second  2222222  queued 10m ago",
    ]);
  });
});
