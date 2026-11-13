// The audit archive (ADR 0590, 0591): machine rows older than 90 days go to R2 as a hash chain, a
// day at a time, and only they are deleted from D1. Old rows are seeded first, so they are the
// table's earliest by rowid, as they are in production.
import { env } from "cloudflare:workers";
import { invoke } from "@software-factory/core";
import {
  AUDIT_ARCHIVE_OPERATIONS,
  type AuditRow,
  auditChunkKey,
  byAtId,
  chainLines,
  checkChunk,
  GENESIS,
  parseChunk,
} from "@software-factory/core/audit-chain";
import { beforeAll, describe, expect, it } from "vitest";
import { AUDIT_ARCHIVE, archiveAudit } from "../src/audit-archive.ts";
import { invokeDeps } from "../src/deps.ts";
import { ok, type World, world } from "./helpers.ts";
import { growingScans, type Recorded, recordingEnv } from "./query-plans.ts";

const DAY = 86_400_000;
const ago = (days: number, ms = 0) => new Date(Date.now() - days * DAY + ms).toISOString();
const dayAgo = (days: number) => ago(days).slice(0, 10);
const midday = (days: number, ms = 0) =>
  new Date(Date.parse(`${dayAgo(days)}T12:00:00.000Z`) + ms).toISOString();

const COLUMNS = `id, at, operation, risk, actor_type, actor_id, origin, decision, outcome, reason,
  org_id, project_id, work_item_id, policy_sha, input, result, diff, pending_action_id, approval_id,
  idempotency_key`;

let n = 0;
async function row(
  at: string,
  over: Partial<{
    op: string;
    actor: string;
    actorId: string;
    outcome: string;
    decision: string;
    item: string | null;
    input: string;
  }> = {},
): Promise<string> {
  const id = `au_${String(++n).padStart(6, "0")}`;
  await env.DB.prepare(
    `INSERT INTO core_audit (id, at, operation, risk, actor_type, actor_id, origin, decision, outcome,
       work_item_id, input, result, diff)
     VALUES (?, ?, ?, 'write', ?, ?, '{"surface":"runner-channel"}', ?, ?, ?, ?, '{"ok":true}', '[]')`,
  )
    .bind(
      id,
      at,
      over.op ?? "runner.heartbeat",
      over.actor ?? "runner",
      over.actorId ?? "rnr_1",
      over.decision ?? "allow",
      over.outcome ?? "ok",
      over.item ?? null,
      over.input ?? '{"sha256":"x","bytes":1}',
    )
    .run();
  return id;
}

const ids = async (where = "1 = 1") =>
  (
    await env.DB.prepare(`SELECT id FROM core_audit WHERE ${where} ORDER BY id`).all<{
      id: string;
    }>()
  ).results.map((r) => r.id);

/** Ticks until the archiver has nothing left to do. */
async function drainAll(
  opts: { rows?: number; scanRows?: number } = { rows: 1_000_000 },
  e: Env = env,
) {
  const ticks = [];
  for (let i = 0; i < 50; i++) {
    const t = await archiveAudit(e, new Date(), opts);
    ticks.push(t);
    if (t.mode === "idle" || (t.archived === 0 && t.days.length === 0)) break;
  }
  return ticks;
}

const machine: string[] = [];
const kept: string[] = [];

beforeAll(async () => {
  // Day 100: machine rows, kept rows of every kind, and a row whose `at` is earlier than the row
  // written before it (a slow call): still archived, in (at, id) order.
  machine.push(await row(midday(100, 0)));
  machine.push(
    await row(midday(100, 1000), {
      op: "workItem.enterStage",
      actor: "agent",
      actorId: "foreman",
      item: "wi_a",
    }),
  );
  kept.push(
    await row(midday(100, 2000), {
      actor: "human",
      actorId: "usr_1",
      op: "review.merge",
      item: "wi_a",
    }),
  );
  kept.push(
    await row(midday(100, 3000), {
      op: "pr.merge",
      actor: "agent",
      actorId: "foreman",
      item: "wi_a",
    }),
  );
  kept.push(await row(midday(100, 4000), { outcome: "fenced" }));
  kept.push(
    await row(midday(100, 5000), { op: "workItem.enterStage", actor: "agent", actorId: "builder" }),
  );
  kept.push(
    await row(midday(100, 6000), { op: "config.save", actor: "scheduler", actorId: "cron" }),
  );
  machine.push(await row(midday(100, 8000), { op: "job.claim", item: "wi_a" }));
  machine.push(await row(midday(100, 7000))); // committed after the row above, stamped before it
  // Day 99: none. Day 98: a few, one per item.
  for (let i = 0; i < 5; i++) {
    machine.push(
      await row(midday(98, i * 1000), { op: "run.reportEvents", item: i % 2 ? "wi_a" : "wi_b" }),
    );
  }
  // Day 89 and today: too recent.
  kept.push(await row(midday(89)));
  kept.push(await row(ago(0)));
  // An org and a person (their own rows come after the old ones, as in production).
  w = await world();
  kept.push(...(await ids(`at > '${ago(1)}'`)).filter((id) => !kept.includes(id)));
});

let w: World;

describe("the audit archive", () => {
  it("lists exactly the operations the delete trigger allows", () => {
    const trigger = env.TEST_MIGRATIONS.flatMap((m) => m.queries).find((q) =>
      q.includes("CREATE TRIGGER core_audit_delete_archived_only"),
    );
    const listed = [...(trigger ?? "").matchAll(/'([a-zA-Z]+\.[a-zA-Z]+)'/g)].map((x) => x[1]);
    expect(new Set(listed)).toEqual(new Set(AUDIT_ARCHIVE_OPERATIONS));
  });

  it("a stray object at the chunk's key stops the tick and deletes nothing; the exact one is used", async () => {
    // Day 100's first chunk: its machine rows in (at, id) order, chained from genesis.
    const { results } = await env.DB.prepare(
      `SELECT ${COLUMNS} FROM core_audit WHERE id IN (SELECT value FROM json_each(?))`,
    )
      .bind(JSON.stringify(machine.slice(0, 4)))
      .all<AuditRow>();
    const rows = results.sort(byAtId);
    const key = auditChunkKey(dayAgo(100), 1, rows[0] as AuditRow, rows.at(-1) as AuditRow);
    await env.ARCHIVE.put(key, "not this chunk\n");
    const stopped = await archiveAudit(env, new Date(), { rows: 1_000_000 });
    expect(stopped.archived).toBe(0);
    expect(await ids()).toEqual(expect.arrayContaining(machine));
    expect((await env.DB.prepare("SELECT * FROM core_audit_archive_leases").all()).results).toEqual(
      [],
    );
    // As a tick that died after its put would leave it: exactly the chunk. The next tick uses it.
    const { lines } = await chainLines(GENESIS, rows);
    await env.ARCHIVE.delete(key);
    await env.ARCHIVE.put(key, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    const t = await archiveAudit(env, new Date(), { rows: 4 });
    expect(t.archived).toBe(4);
    expect(await ids()).not.toContain(machine[0]);
  });

  it("archives the machine rows of each due day as a verified chain and deletes only them", async () => {
    // Under the query-plan guard's check: no scan of a growing table in any statement it ran.
    const seen: Recorded[] = [];
    const ticks = await drainAll({ rows: 1_000_000 }, recordingEnv(env, seen));
    expect(await growingScans(env.DB, seen)).toEqual([]);
    // Day 100's four went in the test before.
    expect(ticks.reduce((s, t) => s + t.archived, 0)).toBe(machine.length - 4);
    // Only kept rows are left.
    expect(await ids()).toEqual([...kept].sort());
    // Every day from the first up to the cutoff is recorded, chained root to root.
    const days = (
      await env.DB.prepare("SELECT * FROM core_audit_archives ORDER BY day").all<{
        day: string;
        rows: number;
        chunks: number;
        root: string;
        prev_root: string;
      }>()
    ).results;
    expect(days[0]?.prev_root).toBe(GENESIS);
    for (let i = 1; i < days.length; i++) {
      expect(days[i]?.prev_root).toBe(days[i - 1]?.root);
      expect(Date.parse(days[i]?.day ?? "") - Date.parse(days[i - 1]?.day ?? "")).toBe(DAY);
    }
    const byDay = new Map(days.map((d) => [d.day, d]));
    expect(byDay.get(dayAgo(100))?.rows).toBe(4);
    expect(byDay.get(dayAgo(99))).toMatchObject({ rows: 0, chunks: 0 });
    expect(byDay.get(dayAgo(98))?.rows).toBe(5);
    expect((days.at(-1)?.day ?? "") < dayAgo(90)).toBe(true);
    // Each object re-hashes to its record, from the chunk before.
    let prev = GENESIS;
    for (const d of days) {
      const chunks = (
        await env.DB.prepare("SELECT * FROM core_audit_archive_chunks WHERE day = ? ORDER BY seq")
          .bind(d.day)
          .all<Parameters<typeof checkChunk>[0] & { r2_key: string }>()
      ).results;
      for (const c of chunks) {
        const body = await (await env.ARCHIVE.get(c.r2_key))?.text();
        const check = await checkChunk(c, prev, body ?? "");
        expect(check).toMatchObject({ ok: true });
        if (check.ok) prev = check.last;
      }
      expect(d.root).toBe(prev);
    }
    // The slow call's row is in (at, id) order in its object.
    const first = (await env.DB.prepare(
      "SELECT r2_key FROM core_audit_archive_chunks WHERE day = ?",
    )
      .bind(dayAgo(100))
      .first<string>("r2_key")) as string;
    const lines = parseChunk((await (await env.ARCHIVE.get(first))?.text()) ?? "");
    expect(lines.map((l) => l.row.id)).toEqual([machine[0], machine[1], machine[3], machine[2]]);
    // Indexed by work item for the timeline.
    const items = (
      await env.DB.prepare(
        "SELECT work_item_id, sum(rows) AS n FROM core_audit_archive_items GROUP BY work_item_id ORDER BY 1",
      ).all()
    ).results;
    expect(items).toEqual([
      { work_item_id: "wi_a", n: 4 },
      { work_item_id: "wi_b", n: 3 },
    ]);
  });

  it("is idempotent: another tick changes nothing, and no lease is left", async () => {
    const before = await env.DB.prepare(
      "SELECT count(*) AS n FROM core_audit_archives",
    ).first<number>("n");
    const t = await archiveAudit(env, new Date(), { rows: 1_000_000 });
    expect(t.archived).toBe(0);
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM core_audit_archives").first<number>("n"),
    ).toBe(before);
    expect((await env.DB.prepare("SELECT * FROM core_audit_archive_leases").all()).results).toEqual(
      [],
    );
  });

  it("another tick holding the day's lease is skipped, not raced", async () => {
    const next = await env.DB.prepare(
      "SELECT day FROM core_audit_archives ORDER BY day DESC LIMIT 1",
    ).first<string>("day");
    const day = new Date(Date.parse(`${next}T00:00:00.000Z`) + DAY).toISOString().slice(0, 10);
    await env.DB.prepare(
      "INSERT INTO core_audit_archive_leases (day, holder, expires_at) VALUES (?, 'other', ?)",
    )
      .bind(day, new Date(Date.now() + 60_000).toISOString())
      .run();
    const t = await archiveAudit(env, new Date(Date.now() + 10 * DAY), { rows: 1_000_000 });
    expect(t.archived).toBe(0);
    expect(t.days).toEqual([]);
    await env.DB.prepare("DELETE FROM core_audit_archive_leases WHERE day = ?").bind(day).run();
  });

  it("the drain stops once its month's write budget is spent", async () => {
    await env.DB.prepare(
      "INSERT INTO core_meta (key, value) VALUES ('audit-archive:state', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    )
      .bind(
        JSON.stringify({
          month: new Date(Date.now() + 120 * DAY).toISOString().slice(0, 7),
          drainWrites: AUDIT_ARCHIVE.drainWritesPerMonth,
          credit: 0,
        }),
      )
      .run();
    // Far enough ahead that today's rows are due and the archiver is draining.
    const t = await archiveAudit(env, new Date(Date.now() + 120 * DAY));
    expect(t.mode).toBe("drain");
    expect(t.archived).toBe(0);
  });

  it("audit.verify proves the chain, and names a day whose object was altered or lost", async () => {
    const from = dayAgo(100);
    const to = dayAgo(92);
    type Verdict = { ok: boolean; days: { day: string; ok: boolean; why: string | null }[] };
    const verify = () => ok<Verdict>("audit.verify", { orgId: w.orgId, from, to }, w.human);
    const good = await verify();
    expect(good.ok).toBe(true);
    expect(good.days).toHaveLength(9);
    const key = (await env.DB.prepare(
      "SELECT r2_key FROM core_audit_archive_chunks WHERE day = ? AND seq = 1",
    )
      .bind(dayAgo(98))
      .first<string>("r2_key")) as string;
    const body = (await (await env.ARCHIVE.get(key))?.text()) ?? "";
    // One row's input changed in the object: its hash no longer follows.
    const lines = body
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    lines[1].row.input = '{"sha256":"y","bytes":1}';
    await env.ARCHIVE.put(key, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    const altered = await verify();
    expect(altered.ok).toBe(false);
    expect(altered.days.find((d) => d.day === dayAgo(98))).toMatchObject({
      ok: false,
      why: "object 1: row 2's hash doesn't match",
    });
    // Lost.
    await env.ARCHIVE.delete(key);
    expect((await verify()).days.find((d) => d.day === dayAgo(98))?.why).toBe(
      "object 1 is missing from the archive",
    );
    await env.ARCHIVE.put(key, body);
    expect((await verify()).ok).toBe(true);
    // A person who isn't an admin of the org can't run it.
    await expect(
      ok("audit.verify", { orgId: w.orgId, from, to }, { type: "human", id: "usr_nobody" }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("workItem.timeline says what is archived and reads it back on demand", async () => {
    const item = await ok<{ workItemId: string }>(
      "workItem.create",
      { state: "backlog", projectId: w.projectId, title: "Old" },
      w.human,
    );
    // An archived chunk holding two of the item's rows (the read path doesn't re-check the chain).
    const day = dayAgo(150);
    const old = (id: string, at: string, op: string): AuditRow => ({
      id,
      at,
      operation: op,
      risk: "write",
      actor_type: "runner",
      actor_id: "rnr_1",
      origin: "{}",
      decision: "allow",
      outcome: "ok",
      reason: null,
      org_id: w.orgId,
      project_id: w.projectId,
      work_item_id: item.workItemId,
      policy_sha: null,
      input: "{}",
      result: '{"ok":true}',
      diff: "[]",
      pending_action_id: null,
      approval_id: null,
      idempotency_key: null,
    });
    const rows = [
      old("au_old1", `${day}T01:00:00.000Z`, "job.claim"),
      old("au_old2", `${day}T02:00:00.000Z`, "run.handBack"),
      { ...old("au_other", `${day}T03:00:00.000Z`, "job.claim"), work_item_id: "wi_other" },
    ];
    const { lines, last } = await chainLines(GENESIS, rows);
    const key = `audit/test/${day}.ndjson`;
    await env.ARCHIVE.put(key, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO core_audit_archive_chunks (day, seq, r2_key, first_at, first_id, last_at, last_id, rows, bytes, sha256, prev_hash, last_hash, archived_at)
         VALUES (?, 1, ?, ?, 'au_old1', ?, 'au_other', 3, 1, 's', ?, ?, ?)`,
      ).bind(day, key, rows[0]?.at, rows[2]?.at, GENESIS, last, ago(0)),
      env.DB.prepare(
        "INSERT INTO core_audit_archive_items (work_item_id, day, seq, rows) VALUES (?, ?, 1, 2)",
      ).bind(item.workItemId, day),
    ]);
    type Timeline = {
      entries: { id: string; archived?: boolean }[];
      archive: { rows: number; state: string };
    };
    const polled = await ok<Timeline>(
      "workItem.timeline",
      { workItemId: item.workItemId },
      w.human,
    );
    expect(polled.archive).toMatchObject({ rows: 2, state: "available" });
    expect(polled.entries.some((e) => e.archived)).toBe(false);
    const read = await ok<Timeline>(
      "workItem.timeline",
      { workItemId: item.workItemId, archived: true },
      w.human,
    );
    expect(read.archive.state).toBe("read");
    // The item's two, oldest first, before its D1 entries; never another item's.
    expect(read.entries.slice(0, 2)).toEqual([
      expect.objectContaining({ id: "au_old1", archived: true }),
      expect.objectContaining({ id: "au_old2", archived: true }),
    ]);
    expect(read.entries.map((e) => e.id)).not.toContain("au_other");
    expect(read.entries.length).toBe(polled.entries.length + 2);
    // Lost from the bucket: said so, never shown as an empty past (read past the isolate's cache).
    await env.ARCHIVE.delete(key);
    const deps = invokeDeps(env);
    const uncached = {
      ...deps,
      services: {
        ...deps.services,
        runArchive: {
          get: async (k: string) => (await env.ARCHIVE.get(k))?.text() ?? null,
          exists: async (k: string) => (await env.ARCHIVE.head(k)) !== null,
        },
      },
    };
    const lost = await invoke<Timeline>(
      uncached,
      "workItem.timeline",
      { workItemId: item.workItemId, archived: true },
      { actor: w.human, origin: { surface: "test" } },
    );
    expect(lost.status === "ok" && lost.output.archive.state).toBe("missing");
  });
});
