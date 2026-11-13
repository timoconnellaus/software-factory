// Work starts in a backlog and is released (spec 50 part B, ADR 0491): creating no longer starts the
// pipeline, release is a person's call unless config lets agents, and the factory pulls queued work
// by priority under the active limit, respecting "waits for" links.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { parseFloor, parseProjectPolicy, policyImpact, SCHEDULER } from "../src/index.ts";
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
    expect(await statusOf(item.workItemId)).toBe("running");
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
    const released = await ok<{ status: string; blockedBy: unknown[] }>(
      "workItem.release",
      { workItemId: item.workItemId },
      w.human,
    );
    expect(released).toMatchObject({ status: "queued", blockedBy: [] });
    // The pull ran right after the release committed, in its own batch.
    expect(await statusOf(item.workItemId)).toBe("running");
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
    const theirs = await create(open, "Agent may", {
      body: "Agents may release work. When the config allows it, an agent's release should queue the item.",
    });
    const done = await ok<{ status: string }>(
      "workItem.release",
      { workItemId: theirs.workItemId },
      FOREMAN,
    );
    expect(done.status).toBe("queued");
    expect(await statusOf(theirs.workItemId)).toBe("running");
    // A thin request an agent releases is parked, not queued (spec 23): no person released it.
    const thin = await create(open, "Agent thin");
    const parked = await ok<{ status: string; needsInfo?: unknown }>(
      "workItem.release",
      { workItemId: thin.workItemId },
      FOREMAN,
    );
    expect(parked).toMatchObject({ status: "backlog", needsInfo: expect.any(Object) });
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
    expect(await statusOf(waiting.workItemId)).toBe("queued");
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
    expect(await statusOf(first_.workItemId)).toBe("running");
    const normal = await create(w, "Normal", { state: "queued" });
    const low = await create(w, "Low", { state: "queued", priority: "low" });
    const urgent = await create(w, "Urgent", { state: "queued", priority: "urgent" });
    const normal2 = await create(w, "Normal too", { state: "queued" });
    for (const i of [normal, low, urgent, normal2]) {
      expect(await statusOf(i.workItemId)).toBe("queued");
    }

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
    expect(await statusOf(feature.workItemId)).toBe("running");
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
    expect(await statusOf(fix.workItemId)).toBe("queued");
    const board = await ok<{
      items: { id: string; blockedBy: { id: string }[] }[];
    }>("workItem.board", { orgId: w.orgId, projectId: w.projectId }, w.human);
    expect(board.items.find((i) => i.id === fix.workItemId)?.blockedBy.map((b) => b.id)).toEqual([
      feature.workItemId,
    ]);
    // Nothing pulls it while the feature runs.
    await ok("queue.pull", { projectId: w.projectId }, SCHEDULER);
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
    expect(await statusOf(post.workItemId)).toBe("queued");
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
    await ok("queue.pull", { projectId: w.projectId }, SCHEDULER);
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

  it("gives each item its phase: shaping before release, delivery from release on, whatever its stage", async () => {
    const w = await world();
    const idea = await create(w, "Idea");
    const released = await create(w, "Small, released", { state: "queued" });
    const board = await ok<{ items: { id: string; stage: string; phase: string }[] }>(
      "workItem.board",
      { orgId: w.orgId, projectId: w.projectId },
      w.human,
    );
    const of = (id: string) => board.items.find((i) => i.id === id);
    expect(of(idea.workItemId)?.phase).toBe("shaping");
    // Released and pulled, it starts at intake (a shaping stage) yet is delivering.
    expect(of(released.workItemId)?.phase).toBe("delivery");
  });
});

describe("the pull under races and policy (review of #69)", () => {
  /** Queued items written straight to the table, so no pull has run for them yet. */
  async function queuedDirectly(w: World, n: number) {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) ids.push((await create(w, `Queued ${i}`)).workItemId);
    for (const id of ids) {
      await env.DB.prepare(
        "UPDATE core_work_items SET status = 'queued', released_at = ? WHERE id = ?",
      )
        .bind(new Date().toISOString(), id)
        .run();
    }
    return ids;
  }
  const active = async (w: World) =>
    (
      await rows(
        "SELECT id FROM core_work_items WHERE project_id = ? AND status IN ('running', 'waiting', 'paused')",
        w.projectId,
      )
    ).length;

  it("never passes the active limit when pulls run at once", async () => {
    const w = await world({ ...POLICY, activeLimit: 2 });
    await queuedDirectly(w, 5);
    const pulls = await Promise.allSettled(
      [1, 2, 3, 4].map(() => call("queue.pull", { projectId: w.projectId }, SCHEDULER)),
    );
    expect(pulls.some((p) => p.status === "fulfilled")).toBe(true);
    expect(await active(w)).toBe(2);
  });

  it("never fails a finish because a pull ran at the same time", async () => {
    const w = await world({ ...POLICY, activeLimit: 1 });
    const running = await create(w, "Running", { state: "queued" });
    await queuedDirectly(w, 2);
    const [finished] = await Promise.all([
      call(
        "workItem.finish",
        { workItemId: running.workItemId, status: "done", reason: "x" },
        FOREMAN,
      ),
      call("queue.pull", { projectId: w.projectId }, SCHEDULER).catch(() => null),
    ]);
    expect(finished.status).toBe("ok");
    expect(await statusOf(running.workItemId)).toBe("done");
    expect(await active(w)).toBe(1);
  });

  it("pulls under the cautious policy without asking anyone", async () => {
    const w = await world({ ...POLICY, autonomyPolicy: "cautious", overrides: {} });
    const [id] = await queuedDirectly(w, 1);
    const pulled = await call("queue.pull", { projectId: w.projectId }, SCHEDULER);
    expect(pulled.status).toBe("ok");
    expect(await statusOf(id as string)).toBe("running");
    expect(
      await rows(
        "SELECT id FROM core_pending_actions WHERE project_id = ? AND operation = 'queue.pull'",
        w.projectId,
      ),
    ).toHaveLength(0);
  });

  it("refuses release when the config is missing or malformed", async () => {
    const w = await world();
    const item = await create(w, "Waiting for config");
    await env.DB.prepare("UPDATE core_projects SET policy_sha = NULL WHERE id = ?")
      .bind(w.projectId)
      .run();
    const e = await refusal(call("workItem.release", { workItemId: item.workItemId }, w.human));
    expect(e.code).toBe("unavailable");
  });

  it("holds the pull while a kill switch is on", async () => {
    const w = await world();
    await ok("killSwitch.set", { scope: "project", id: w.projectId, on: true }, w.human);
    const held = await create(w, "Held", { state: "queued" });
    expect(await statusOf(held.workItemId)).toBe("queued");
    await ok("killSwitch.set", { scope: "project", id: w.projectId, on: false, epoch: 1 }, w.human);
    await ok("queue.pull", { projectId: w.projectId }, SCHEDULER);
    expect(await statusOf(held.workItemId)).toBe("running");
  });

  it("refuses changing a released item's repository", async () => {
    const w = await world({ ...POLICY, activeLimit: 1 });
    await create(w, "Running", { state: "queued" });
    const queued = await create(w, "Queued", { state: "queued" });
    const e = await refusal(
      call("workItem.update", { workItemId: queued.workItemId, repositoryId: null }, w.human),
    );
    expect(e.code).toBe("conflict");
  });

  it("never lets two links made at once close a cycle", async () => {
    const w = await world();
    const a = await create(w, "A");
    const b = await create(w, "B");
    const both = await Promise.allSettled([
      call("workItem.link", { workItemId: a.workItemId, waitsFor: b.workItemId }, w.human),
      call("workItem.link", { workItemId: b.workItemId, waitsFor: a.workItemId }, w.human),
    ]);
    expect(both.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      await rows(
        "SELECT work_item_id FROM core_work_item_links WHERE work_item_id IN (?, ?)",
        a.workItemId,
        b.workItemId,
      ),
    ).toHaveLength(1);
  });

  it("keeps the order through many moves between the same two items", async () => {
    const w = await world();
    const a = await create(w, "A");
    const b = await create(w, "B");
    const movers = [];
    for (let i = 0; i < 60; i++) movers.push((await create(w, `M${i}`)).workItemId);
    // Each new one goes just after A, so the gap between A and the last one halves every time.
    for (const m of movers) {
      await ok("workItem.reorder", { workItemId: m, after: a.workItemId }, w.human);
    }
    const board = await ok<{ items: { id: string }[] }>(
      "workItem.board",
      { orgId: w.orgId, projectId: w.projectId, states: ["backlog"] },
      w.human,
    );
    const order = board.items.map((i) => i.id);
    expect(order[0]).toBe(a.workItemId);
    expect(order[1]).toBe(movers[movers.length - 1]);
    expect(order.at(-1)).toBe(b.workItemId);
  });
});

describe("shaping before release (ADR 0493)", () => {
  it("starts the Workflow without a slot, and cancelling stops it", async () => {
    const w = await world({ ...POLICY, activeLimit: 1 });
    const shaping = await create(w, "Shape me");
    const out = await ok<{ status: string }>(
      "workItem.shape",
      { workItemId: shaping.workItemId },
      w.human,
    );
    expect(out.status).toBe("shaping");
    expect(await starts(shaping.workItemId)).toBe(1);
    // Shaping isn't delivery: the only slot is still free for released work.
    const next = await create(w, "Released", { state: "queued" });
    expect(await statusOf(next.workItemId)).toBe("running");
    // A shaping item has a Workflow: cancelling it terminates that, unlike backlog work.
    await ok("workItem.cancel", { workItemId: shaping.workItemId, reason: "no" }, w.human);
    expect(await statusOf(shaping.workItemId)).toBe("cancelled");
    expect(
      await rows(
        "SELECT id FROM core_outbox WHERE kind = 'workflow.terminate' AND payload LIKE ?",
        `%${shaping.workItemId}%`,
      ),
    ).toHaveLength(1);
  });

  it("wakes a shaped item's Workflow at the pull instead of creating one", async () => {
    const w = await world();
    const item = await create(w, "Shaped");
    await ok("workItem.shape", { workItemId: item.workItemId }, w.human);
    const shaped = await ok<{ released: boolean; event: string }>(
      "workItem.shaped",
      { workItemId: item.workItemId },
      FOREMAN,
    );
    expect(shaped.released).toBe(false);
    expect(await statusOf(item.workItemId)).toBe("ready");
    await ok("workItem.release", { workItemId: item.workItemId }, w.human);
    expect(await statusOf(item.workItemId)).toBe("running");
    expect(await starts(item.workItemId)).toBe(1); // only the shaping one
    expect(
      await rows(
        "SELECT id FROM core_outbox WHERE kind = 'workflow.event' AND payload LIKE ?",
        `%release-${item.workItemId}%`,
      ),
    ).toHaveLength(1);
  });

  it("refuses shaping what isn't backlog or ready, and finishes a spec rejected while shaping", async () => {
    const w = await world();
    const running = await create(w, "Running", { state: "queued" });
    const e = await refusal(call("workItem.shape", { workItemId: running.workItemId }, w.human));
    expect(e.code).toBe("conflict");
    const item = await create(w, "Rejected while shaping");
    await ok("workItem.shape", { workItemId: item.workItemId }, w.human);
    await finish(item.workItemId, "rejected");
    expect(await statusOf(item.workItemId)).toBe("rejected");
  });

  it("caps shaping per project, and refuses it under a kill switch", async () => {
    const w = await world({ ...POLICY, shapingLimit: 1 });
    const one = await create(w, "One");
    const two = await create(w, "Two");
    await ok("workItem.shape", { workItemId: one.workItemId }, w.human);
    const capped = await refusal(call("workItem.shape", { workItemId: two.workItemId }, w.human));
    expect(capped.message).toMatch(/shaping limit is 1/);
    const k = await world();
    const held = await create(k, "Held");
    await ok("killSwitch.set", { scope: "project", id: k.projectId, on: true }, k.human);
    const killed = await refusal(call("workItem.shape", { workItemId: held.workItemId }, k.human));
    expect(killed.code).toBe("killed");
  });

  it("refuses releasing a plan the config in force no longer accepts", async () => {
    const w = await world();
    const item = await create(w, "Shaped small");
    await ok("workItem.shape", { workItemId: item.workItemId }, w.human);
    // Triage sized it small: no plan needed then.
    await env.DB.prepare(
      "UPDATE core_work_items SET size = 'small', spec_required = 0 WHERE id = ?",
    )
      .bind(item.workItemId)
      .run();
    await ok("workItem.shaped", { workItemId: item.workItemId }, FOREMAN);
    // The config now wants a plan from small work up.
    await ok(
      "policy.sync",
      {
        projectId: w.projectId,
        ref: "refs/heads/main",
        sha: "f".repeat(40),
        content: JSON.stringify({ ...POLICY, spec: { requiredFrom: "small" } }),
      },
      w.human,
    );
    const e = await refusal(call("workItem.release", { workItemId: item.workItemId }, w.human));
    expect(e.code).toBe("conflict");
    expect(e.message).toMatch(/now requires one for small work/);
  });

  it("tells a Workflow reaching the wait after its release was pulled to go on (an early event)", async () => {
    const w = await world();
    const item = await create(w, "Early");
    await ok("workItem.shape", { workItemId: item.workItemId }, w.human);
    // The pull ran before the Workflow reached `release: wait` (its event may have come first).
    await env.DB.prepare("UPDATE core_work_items SET pulled_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), item.workItemId)
      .run();
    const shaped = await ok<{ released: boolean }>(
      "workItem.shaped",
      { workItemId: item.workItemId },
      FOREMAN,
    );
    expect(shaped.released).toBe(true);
  });
});

describe("project.workflow", () => {
  type Read = {
    workflow: { name: string; label: string; builtIn: boolean } | null;
    unavailable: string | null;
    stages: { stage: string; label: string; phase: string }[];
  };
  const read = (w: World) => ok<Read>("project.workflow", { projectId: w.projectId }, w.human);

  it("is the built-in workflow, with its stages in order and their phases, when the config defines none", async () => {
    const r = await read(await world());
    expect(r.workflow).toMatchObject({
      name: "software",
      label: "Software (built in)",
      builtIn: true,
    });
    expect(r.unavailable).toBeNull();
    expect(r.stages.map((s) => s.stage)).toEqual(["triage", "spec", "build", "verify", "merge"]);
    expect(r.stages.filter((s) => s.phase === "shaping").map((s) => s.label)).toEqual([
      "Triage",
      "Spec",
    ]);
  });

  const agents = [{ name: "Builder", role: "implement" }];
  const feature = { name: "feature", description: "A feature" };

  it("is the workflow the config names", async () => {
    const r = await read(
      await world({ ...POLICY, agents, workflows: [feature], workflow: "feature" }),
    );
    expect(r.workflow).toMatchObject({ name: "feature", label: "Feature", builtIn: false });
  });

  it("is none, with the reason, when the config defines workflows and names none (fails closed)", async () => {
    const r = await read(await world({ ...POLICY, agents, workflows: [feature] }));
    expect(r.workflow).toBeNull();
    expect(r.unavailable).toMatch(/names none/);
  });
});
