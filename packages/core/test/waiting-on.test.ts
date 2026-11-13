// What a running or waiting item waits on (waiting-on.ts): `workItem.board` and `workItem.list`
// carry it from the same read as the items, and `delivery.status` / `mergeQueue.list` say which step
// the queue's head is on. Facts are written straight into the tables the engine writes.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { ok, POLICY, uid, world } from "./helpers.ts";

type World = Awaited<ReturnType<typeof world>>;
type WaitingOn = {
  kind: string;
  on?: string;
  position?: number;
  merging?: boolean;
  held?: boolean;
} | null;

const run = (sql: string, ...params: unknown[]) =>
  env.DB.prepare(sql)
    .bind(...params)
    .run();
const iso = (ms: number) => new Date(ms).toISOString();
const T0 = Date.parse("2026-11-13T00:00:00.000Z");

async function running(w: World, title: string) {
  const { workItemId } = await ok<{ workItemId: string }>(
    "workItem.create",
    { projectId: w.projectId, title, state: "queued" },
    w.human,
  );
  // The pull started it; nothing else (the Workflow doesn't run here).
  await run("DELETE FROM core_jobs WHERE work_item_id = ?", workItemId);
  return workItemId;
}

async function stage(id: string, name: string, at: number) {
  await run("UPDATE core_work_items SET stage = ?, status = 'running' WHERE id = ?", name, id);
  await run(
    "INSERT INTO core_stages (id, work_item_id, stage, attempt, started_at) VALUES (?, ?, ?, 1, ?)",
    uid("st_"),
    id,
    name,
    iso(at),
  );
}

async function job(w: World, id: string, s: string, status: string, at: number) {
  await run(
    `INSERT INTO core_jobs (id, work_item_id, project_id, org_id, stage, role, prompt, session_timeout_ms, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'review', 'p', 1000, ?, ?)`,
    uid("job_"),
    id,
    w.projectId,
    w.orgId,
    s,
    status,
    iso(at),
  );
}

async function packet(id: string, at: number) {
  await run(
    "INSERT INTO core_review_packets (id, work_item_id, head_sha, verdict, created_at) VALUES (?, ?, ?, 'pass', ?)",
    uid("rp_"),
    id,
    "a".repeat(40),
    iso(at),
  );
}

async function gate(w: World, id: string) {
  await run(
    `INSERT INTO core_pending_actions (id, org_id, project_id, work_item_id, kind, operation, risk, actor_type, actor_id, input, created_at)
     VALUES (?, ?, ?, ?, 'approval', 'workflow.gate', 'write', 'agent', 'foreman', '{}', ?)`,
    uid("pa_"),
    w.orgId,
    w.projectId,
    id,
    iso(T0),
  );
}

async function question(w: World, id: string) {
  await run(
    `INSERT INTO core_questions (id, work_item_id, project_id, org_id, prompt, planning_round, asked_by, created_at, blocking)
     VALUES (?, ?, ?, ?, 'No CI?', 0, 'foreman', ?, 1)`,
    uid("q_"),
    id,
    w.projectId,
    w.orgId,
    iso(T0),
  );
}

async function enqueue(w: World, id: string, at: number, extra: Record<string, unknown> = {}) {
  const cols = {
    id: uid("mq_"),
    project_id: w.projectId,
    work_item_id: id,
    approved_sha: "b".repeat(40),
    head_sha: "b".repeat(40),
    enqueued_at: iso(at),
    updated_at: iso(at),
    driver: "babysitter",
    ...extra,
  };
  await run(
    `INSERT INTO core_merge_queue (${Object.keys(cols).join(", ")}) VALUES (${Object.keys(cols)
      .map(() => "?")
      .join(", ")})`,
    ...Object.values(cols),
  );
}

async function board(w: World): Promise<Map<string, WaitingOn>> {
  const b = await ok<{ items: { id: string; waitingOn: WaitingOn }[] }>(
    "workItem.board",
    { orgId: w.orgId },
    w.human,
  );
  return new Map(b.items.map((i) => [i.id, i.waitingOn]));
}

async function list(w: World): Promise<Map<string, WaitingOn>> {
  const l = await ok<{ items: { id: string; waitingOn: WaitingOn }[] }>(
    "workItem.list",
    { orgId: w.orgId },
    w.human,
  );
  return new Map(l.items.map((i) => [i.id, i.waitingOn ?? null]));
}

describe("what an item waits on", () => {
  it("in verify: a runner, the agent, then CI until the packet; after it, never CI", async () => {
    const w = await world({ ...POLICY, activeLimit: 10 });
    const id = await running(w, "Verify me");
    await stage(id, "verify", T0);
    // The verify job is queued: no runner has it yet.
    await job(w, id, "verify", "queued", T0 + 1);
    expect((await board(w)).get(id)).toEqual({ kind: "runner" });
    // A runner claimed it.
    await run("UPDATE core_jobs SET status = 'claimed' WHERE work_item_id = ?", id);
    expect((await board(w)).get(id)).toEqual({ kind: "agent" });
    // It handed back; no packet yet: the engine is waiting on CI.
    await run("UPDATE core_jobs SET status = 'done' WHERE work_item_id = ?", id);
    expect((await board(w)).get(id)).toEqual({ kind: "ci" });
    expect((await list(w)).get(id)).toEqual({ kind: "ci" });
    // CI answered and the packet is recorded: an afterVerify slot agent (stage verify) runs next.
    await packet(id, T0 + 10);
    expect((await board(w)).get(id)).toBeNull();
    await job(w, id, "verify", "queued", T0 + 11);
    expect((await board(w)).get(id)).toEqual({ kind: "runner" });
    await run(
      "UPDATE core_jobs SET status = 'done' WHERE work_item_id = ? AND status = 'queued'",
      id,
    );
    // The slot step handed back too: nothing says CI any more.
    expect((await board(w)).get(id)).toBeNull();
    // A slot's gate: a person.
    await gate(w, id);
    expect((await board(w)).get(id)).toEqual({ kind: "person", on: "gate" });
    expect((await list(w)).get(id)).toEqual({ kind: "person", on: "gate" });
  });

  it("a packet from an earlier verify attempt doesn't count; a question (askNoCi) is a person", async () => {
    const w = await world({ ...POLICY, activeLimit: 10 });
    const id = await running(w, "Again");
    await packet(id, T0 - 100);
    await stage(id, "verify", T0);
    await job(w, id, "verify", "done", T0 + 1);
    expect((await board(w)).get(id)).toEqual({ kind: "ci" });
    // No CI on the head: the engine asks a person.
    await question(w, id);
    expect((await board(w)).get(id)).toEqual({ kind: "person", on: "question" });
  });

  it("says nothing for a paused item or one with no facts", async () => {
    const w = await world({ ...POLICY, activeLimit: 10 });
    const id = await running(w, "Paused");
    await stage(id, "verify", T0);
    expect((await board(w)).get(id)).toBeNull();
    await job(w, id, "verify", "claimed", T0 + 1);
    await run("UPDATE core_work_items SET status = 'paused' WHERE id = ?", id);
    expect((await board(w)).get(id)).toBeNull();
  });

  it("in merge: the queue's position, and the head's step", async () => {
    const w = await world({ ...POLICY, activeLimit: 10 });
    const head = await running(w, "Head");
    const second = await running(w, "Second");
    await stage(head, "merge", T0);
    await stage(second, "merge", T0);
    const sha = "b".repeat(40);
    // The head asked GitHub to merge main in; the new head isn't there yet.
    await enqueue(w, head, T0, { update_asked_at: iso(T0 + 1), update_from_sha: sha });
    await enqueue(w, second, T0 + 5);
    let b = await board(w);
    expect(b.get(head)).toEqual({ kind: "updating", position: 1 });
    expect(b.get(second)).toEqual({ kind: "queue", position: 2 });
    const status = await ok<{
      repositories: { deliveries: { workItemId: string; step: string | null }[] }[];
    }>("delivery.status", { projectId: w.projectId }, w.human);
    expect(status.repositories[0]?.deliveries.map((d) => d.step)).toEqual(["updating", null]);
    const queue = await ok<{ entries: { workItemId: string; step: string | null }[] }>(
      "mergeQueue.list",
      { projectId: w.projectId },
      w.human,
    );
    expect(queue.entries.map((e) => e.step)).toEqual(["updating", null]);
    // GitHub's merge landed (a new head): CI runs there.
    await run(
      "UPDATE core_merge_queue SET head_sha = ? WHERE work_item_id = ?",
      "c".repeat(40),
      head,
    );
    expect((await board(w)).get(head)).toEqual({ kind: "ci", position: 1 });
    await run("UPDATE core_merge_queue SET merging_at = ? WHERE work_item_id = ?", iso(T0), head);
    b = await board(w);
    expect(b.get(head)).toEqual({ kind: "queue", position: 1, merging: true });
    // The merge gate on the second (a person) comes before its place in the queue.
    await gate(w, second);
    expect((await board(w)).get(second)).toEqual({ kind: "person", on: "gate" });
  });
});
