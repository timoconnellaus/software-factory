// Work starts in a backlog and is released (spec 50 part B, ADR 0491): creating no longer starts the
// pipeline, release is a person's call unless config lets agents, and the factory pulls queued work
// by priority under the active limit, respecting "waits for" links.
import { describe, expect, it } from "vitest";
import { parseFloor, parseProjectPolicy, policyImpact } from "../src/index.ts";
import { call, FOREMAN, first, ok, onboard, POLICY, refusal, rows, uid, world } from "./helpers.ts";

type World = Awaited<ReturnType<typeof world>>;
type Created = { workItemId: string; number: number; status: string };

const create = (w: World, title: string, extra: Record<string, unknown> = {}) =>
  ok<Created>("workItem.create", { projectId: w.projectId, title, ...extra }, w.human);
const statusOf = async (id: string) =>
  (await first<{ status: string }>("SELECT status FROM core_work_items WHERE id = ?", id)).status;
const starts = async (id: string) =>
  (
    await rows(
      "SELECT id FROM core_outbox WHERE kind = 'workflow.create' AND payload LIKE ?",
      `%${id}%`,
    )
  ).length;
const finish = (id: string, status = "done") =>
  ok("workItem.finish", { workItemId: id, status, reason: "test" }, FOREMAN);

describe("capture and release (ADR 0491)", () => {
  it("creates into the backlog by default: no Workflow, no stage beyond intake (criterion 4)", async () => {
    const w = await world();
    const item = await create(w, "Write it down");
    expect(item.status).toBe("backlog");
    expect(await statusOf(item.workItemId)).toBe("backlog");
    expect(await starts(item.workItemId)).toBe(0);
    expect(
      await rows("SELECT id FROM core_stages WHERE work_item_id = ?", item.workItemId),
    ).toHaveLength(0);
    // Shaping and moving don't start anything either.
    await ok(
      "workItem.update",
      { workItemId: item.workItemId, priority: "high", acceptanceCriteria: ["It works"] },
      w.human,
    );
    await ok("workItem.move", { workItemId: item.workItemId, to: "ready" }, w.human);
    expect(await statusOf(item.workItemId)).toBe("ready");
    expect(await starts(item.workItemId)).toBe(0);
  });

  it("create and release starts at once when there is room, pinning the config version", async () => {
    const w = await world();
    const item = await create(w, "Now please", { state: "queued" });
    expect(item.status).toBe("running");
    expect(await starts(item.workItemId)).toBe(1);
    const row = await first<{ policy_sha: string; pulled_at: string; released_by: string }>(
      "SELECT policy_sha, pulled_at, released_by FROM core_work_items WHERE id = ?",
      item.workItemId,
    );
    expect(row.policy_sha).toBe(w.policySha);
    expect(row.pulled_at).not.toBeNull();
    expect(row.released_by).toBe(w.userId);
  });

  it("releases from ready; refuses what isn't backlog or ready (criterion 5)", async () => {
    const w = await world();
    const item = await create(w, "Shaped", { state: "ready" });
    const released = await ok<{ status: string; started: string[] }>(
      "workItem.release",
      { workItemId: item.workItemId },
      w.human,
    );
    expect(released).toMatchObject({ status: "running", started: [item.workItemId] });
    const again = await refusal(call("workItem.release", { workItemId: item.workItemId }, w.human));
    expect(again.code).toBe("conflict");
  });

  it("refuses an agent unless the config lets agents release; a person always may (criterion 5)", async () => {
    const w = await world();
    const item = await create(w, "Agent wants it");
    const denied = await refusal(
      call("workItem.release", { workItemId: item.workItemId }, FOREMAN),
    );
    expect(denied.code).toBe("denied");
    const intake = await refusal(
      call(
        "workItem.create",
        { projectId: w.projectId, title: "x", state: "queued", requesterUserId: w.userId },
        { type: "intake", id: "github" },
      ),
    );
    expect(intake.code).toBe("denied");

    const open = await world({ ...POLICY, release: { agents: true } });
    const theirs = await create(open, "Agent may");
    const done = await ok<{ status: string }>(
      "workItem.release",
      { workItemId: theirs.workItemId },
      FOREMAN,
    );
    expect(done.status).toBe("running");
  });

  it("treats letting agents release as a loosening, a person's change", () => {
    const parse = (v: unknown) => {
      const p = parseProjectPolicy(JSON.stringify(v));
      if (!p.ok) throw new Error(p.error);
      return p.policy;
    };
    const before = parse(POLICY);
    const after = parse({ ...POLICY, release: { agents: true } });
    const impact = policyImpact(before, after, parseFloor(undefined));
    expect(impact.changes.find((c) => c.path === "release.agents")?.class).toBe("loosens");
    expect(
      policyImpact(after, before, parseFloor(undefined)).changes.find(
        (c) => c.path === "release.agents",
      )?.class,
    ).toBe("tightens");
  });

  it("un-releases a queued item back to ready, and cancels backlog work without a Workflow", async () => {
    const w = await world({ ...POLICY, activeLimit: 1 });
    await create(w, "Takes the slot", { state: "queued" });
    const waiting = await create(w, "Waits", { state: "queued" });
    expect(waiting.status).toBe("queued");
    await ok("workItem.move", { workItemId: waiting.workItemId, to: "ready" }, w.human);
    expect(await statusOf(waiting.workItemId)).toBe("ready");
    const cancelled = await ok<{ cancelled: boolean }>(
      "workItem.cancel",
      { workItemId: waiting.workItemId, reason: "not needed" },
      w.human,
    );
    expect(cancelled.cancelled).toBe(true);
    expect(await statusOf(waiting.workItemId)).toBe("cancelled");
    expect(
      await rows(
        "SELECT id FROM core_outbox WHERE kind = 'workflow.terminate' AND payload LIKE ?",
        `%${waiting.workItemId}%`,
      ),
    ).toHaveLength(0);
  });
});

describe("the pull (ADR 0491, criterion 6)", () => {
  it("takes queued work by priority, then rank, never past the active limit", async () => {
    const w = await world({ ...POLICY, activeLimit: 1 });
    const first_ = await create(w, "First", { state: "queued" });
    expect(first_.status).toBe("running");
    const normal = await create(w, "Normal", { state: "queued" });
    const low = await create(w, "Low", { state: "queued", priority: "low" });
    const urgent = await create(w, "Urgent", { state: "queued", priority: "urgent" });
    const normal2 = await create(w, "Normal too", { state: "queued" });
    for (const i of [normal, low, urgent, normal2]) expect(i.status).toBe("queued");

    await finish(first_.workItemId);
    expect(await statusOf(urgent.workItemId)).toBe("running");
    expect(await statusOf(normal.workItemId)).toBe("queued");

    // A manual reorder puts the second normal item ahead of the first.
    await ok(
      "workItem.reorder",
      { workItemId: normal2.workItemId, before: normal.workItemId },
      w.human,
    );
    await finish(urgent.workItemId, "failed");
    expect(await statusOf(normal2.workItemId)).toBe("running");
    expect(await statusOf(normal.workItemId)).toBe("queued");

    // Cancelling frees the slot too.
    await ok("workItem.cancel", { workItemId: normal2.workItemId, reason: "x" }, w.human);
    expect(await statusOf(normal.workItemId)).toBe("running");
    expect(await statusOf(low.workItemId)).toBe("queued");
    const active = await rows(
      "SELECT id FROM core_work_items WHERE project_id = ? AND status IN ('running', 'waiting', 'paused')",
      w.projectId,
    );
    expect(active).toHaveLength(1);
  });

  it("holds an item until what it waits for is done, across projects", async () => {
    const w = await world();
    const feature = await create(w, "The feature", { state: "queued" });
    expect(feature.status).toBe("running");
    // The launch post is in another project of the same org.
    const site = await ok<{ id: string }>(
      "project.create",
      { orgId: w.orgId, name: "Marketing" },
      w.human,
    );
    const post = await ok<Created>(
      "workItem.create",
      { projectId: site.id, title: "Launch post", waitsFor: [feature.workItemId] },
      w.human,
    );
    // Marketing has no repository, so the post can't be released yet (its workflow builds code).
    const refused = await refusal(
      call("workItem.release", { workItemId: post.workItemId }, w.human),
    );
    expect(refused.message).toMatch(/has none/);

    // Same project: a fix waits for the feature.
    const fix = await ok<{ status: string; workItemId: string }>(
      "workItem.create",
      {
        projectId: w.projectId,
        title: "Follow-up",
        waitsFor: [feature.workItemId],
        state: "queued",
      },
      w.human,
    );
    expect(fix.status).toBe("queued");
    const board = await ok<{
      items: { id: string; blockedBy: { id: string }[] }[];
    }>("workItem.board", { orgId: w.orgId, projectId: w.projectId }, w.human);
    expect(board.items.find((i) => i.id === fix.workItemId)?.blockedBy.map((b) => b.id)).toEqual([
      feature.workItemId,
    ]);
    // Nothing pulls it while the feature runs.
    await ok("queue.pull", { projectId: w.projectId }, FOREMAN);
    expect(await statusOf(fix.workItemId)).toBe("queued");
    await finish(feature.workItemId);
    // finish pulled in the same call.
    expect(await statusOf(fix.workItemId)).toBe("running");
  });

  it("starts a waiter in another project when its blocker is done; refuses links across orgs", async () => {
    const w = await world();
    const feature = await create(w, "The feature", { state: "queued" });
    const docs = await onboard(w.human, w.orgId, { owner: "timoconnellaus", name: uid("docs-") });
    const post = await ok<Created>(
      "workItem.create",
      {
        projectId: docs.project.id,
        title: "Launch post",
        waitsFor: [feature.workItemId],
        state: "queued",
      },
      w.human,
    );
    expect(post.status).toBe("queued");
    await finish(feature.workItemId);
    expect(await statusOf(post.workItemId)).toBe("running");

    const b = await world();
    const crossOrg = await refusal(
      call(
        "workItem.create",
        { projectId: b.projectId, title: "x", waitsFor: [feature.workItemId] },
        b.human,
      ),
    );
    expect(crossOrg.code).toBe("not_found");
  });

  it("leaves a waiter queued when its blocker fails, until the link is removed", async () => {
    const w = await world();
    const blocker = await create(w, "Blocker", { state: "queued" });
    const waiter = await create(w, "Waiter", { state: "queued", waitsFor: [blocker.workItemId] });
    await finish(blocker.workItemId, "failed");
    expect(await statusOf(waiter.workItemId)).toBe("queued");
    await ok(
      "workItem.unlink",
      { workItemId: waiter.workItemId, waitsFor: blocker.workItemId },
      w.human,
    );
    await ok("queue.pull", { projectId: w.projectId }, FOREMAN);
    expect(await statusOf(waiter.workItemId)).toBe("running");
  });
});

describe("waits-for links (criterion 7)", () => {
  it("refuses a cycle, itself, and an item already in its pipeline", async () => {
    const w = await world();
    const a = await create(w, "A");
    const b = await create(w, "B", { waitsFor: [a.workItemId] });
    const cycle = await refusal(
      call("workItem.link", { workItemId: a.workItemId, waitsFor: b.workItemId }, w.human),
    );
    expect(cycle.code).toBe("conflict");
    expect(cycle.message).toMatch(/cycle/);
    const self = await refusal(
      call("workItem.link", { workItemId: a.workItemId, waitsFor: a.workItemId }, w.human),
    );
    expect(self.code).toBe("conflict");
    const running = await create(w, "Running", { state: "queued" });
    const late = await refusal(
      call("workItem.link", { workItemId: running.workItemId, waitsFor: a.workItemId }, w.human),
    );
    expect(late.code).toBe("conflict");
    await ok("workItem.unlink", { workItemId: b.workItemId, waitsFor: a.workItemId }, w.human);
    await ok("workItem.link", { workItemId: a.workItemId, waitsFor: b.workItemId }, w.human);
  });
});

describe("the factory's own work skips the backlog (criterion 8)", () => {
  it("starts an incident's fix even when the project is at its active limit", async () => {
    const w = await world({ ...POLICY, activeLimit: 1 });
    const busy = await create(w, "Busy", { state: "queued" });
    const opened = await ok<{ fixWorkItemId: string | null }>(
      "incident.open",
      { workItemId: busy.workItemId, kind: "manual", reason: "needs a factory fix" },
      FOREMAN,
    );
    expect(opened.fixWorkItemId).toBeTruthy();
    expect(await statusOf(opened.fixWorkItemId as string)).toBe("running");
    expect(await starts(opened.fixWorkItemId as string)).toBe(1);
  });
});

describe("workItem.board (criterion 10)", () => {
  it("lists by state in pull order, with counts per project and state across the org", async () => {
    const w = await world({ ...POLICY, activeLimit: 1 });
    await create(w, "Running", { state: "queued" });
    const low = await create(w, "Low", { state: "queued", priority: "low" });
    const high = await create(w, "High", { state: "queued", priority: "high" });
    await create(w, "Idea");
    const other = await ok<{ id: string }>(
      "project.create",
      { orgId: w.orgId, name: "Marketing" },
      w.human,
    );
    await ok("workItem.create", { projectId: other.id, title: "Post" }, w.human);

    const board = await ok<{
      items: { id: string; status: string; priority: string }[];
      counts: { projectId: string; status: string; n: number }[];
    }>("workItem.board", { orgId: w.orgId, states: ["queued"] }, w.human);
    expect(board.items.map((i) => i.id)).toEqual([high.workItemId, low.workItemId]);
    const count = (projectId: string, status: string) =>
      board.counts.find((c) => c.projectId === projectId && c.status === status)?.n ?? 0;
    expect(count(w.projectId, "queued")).toBe(2);
    expect(count(w.projectId, "running")).toBe(1);
    expect(count(w.projectId, "backlog")).toBe(1);
    expect(count(other.id, "backlog")).toBe(1);

    const detail = await ok<{ item: { priority: string; status: string } }>(
      "workItem.get",
      { workItemId: high.workItemId },
      w.human,
    );
    expect(detail.item).toMatchObject({ priority: "high", status: "queued" });
  });
});
