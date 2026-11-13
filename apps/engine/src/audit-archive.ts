// The audit archive (ADR 0590, as built in ADR 0591): routine machine rows of core_audit older than
// 90 days go to R2 (sf-archive) as a hash chain, one UTC day at a time, and are then deleted from
// D1. Decisions, refusals, approvals, gates, config changes and everything a person did stay in D1
// forever (migration 0366 states exactly which rows are "machine rows"; its trigger refuses any
// other delete). Nothing is added to the hot write path: the chain is computed here, at archive
// time, by the one writer that touches old rows.
//
// How it finds a day's rows without an index on `at` (an index would cost a write on every audited
// call): by rowid, which grows with commit order. A row's `at` is stamped when its call starts and
// the row commits within COMMIT_SKEW_MS of it. So for any row z, every row before it (by rowid)
// has `at` < z.at + skew, and every row after it has `at` > z.at − skew. A page reads a bounded
// rowid window and keeps only the rows whose `at` that window provably covers; the rest wait for
// the next window. A row missed because a call ran longer than the skew is never deleted (deletes
// name the archived ids), it only stays in D1.
//
// The guarantees are #118's: range-named create-only objects, a per-day lease, the object verified
// (R2 checks the SHA-256 we computed) before the batch that records it deletes its rows, crash-safe
// and idempotent (a tick that dies leaves an object at most; the next one reads it back and uses it
// only if it is byte-for-byte what it would write), and a backlog drain under a monthly write
// budget that yields to live traffic.
import {
  ARCHIVE_CHUNK_BYTES,
  ARCHIVE_CHUNK_ROWS,
  AUDIT_ARCHIVE_AFTER_DAYS,
  type AuditRow,
  auditChunkKey,
  byAtId,
  chainLines,
  dayOf,
  GENESIS,
  MACHINE_ROW_SQL,
  nextDay,
  prevDay,
} from "@software-factory/core/audit-chain";
import { ARCHIVE, archiveBudget } from "./retention.ts";

const DAY = 86_400_000;

export const AUDIT_ARCHIVE = {
  afterDays: AUDIT_ARCHIVE_AFTER_DAYS,
  /**
   * How long after its `at` a row is taken to have committed at most: `at` is stamped when the call
   * starts and the row is written in the call's last batch. Generous (calls finish in seconds); a
   * call slower than this leaves its row in D1, never loses it.
   */
  commitSkewMs: 60 * 60_000,
  /** Rows a page's rowid window spans at first; doubled while a window is too narrow to progress. */
  scanRows: 5_000,
  maxScanRows: 200_000,
  /** The archiver's lease on a day; every chunk renews it. A tick runs well under a minute. */
  leaseMs: 5 * 60_000,
  /** D1 queries one tick may make (it runs every five minutes, beside the run archive). */
  maxQueriesPerTick: 60,
  /**
   * D1 rows written for each archived row: its delete touches the table, its two unique
   * autoindexes (`id`, `idempotency_key`) and core_audit_item_idx.
   */
  writesPerRow: 4,
  /** Ticks a day (every five minutes). */
  ticksPerDay: 288,
  /**
   * Within this many days of the cutoff the archiver is keeping up (a day of machine rows is a few
   * thousand) and archives what is due; further behind it is draining the backlog, paced.
   */
  keepUpDays: 3,
  /** The backlog drain's own budget of D1 rows written in a calendar month (UTC). */
  drainWritesPerMonth: 5_000_000,
} as const;

const STATE_KEY = "audit-archive:state";

/** The drain's month so far and its carried credit (rows), between ticks. */
type DrainState = { month: string; drainWrites: number; credit: number };

/** Why a tick stopped: the lease went elsewhere, or D1 and the object disagree. */
class AuditArchiveStop extends Error {}

export type AuditArchiveTick = {
  /** Machine rows archived (and deleted from D1) this tick. */
  archived: number;
  /** Days recorded this tick. */
  days: string[];
  /** The day being archived when the tick ended, or null when nothing is due. */
  day: string | null;
  /** `drain` while more than keepUpDays behind, else `keepUp`; `idle` when nothing is due. */
  mode: "idle" | "keepUp" | "drain";
  queries: number;
  /** D1 rows this tick read, as D1 reported them. */
  rowsRead: number;
  /** D1 rows this tick wrote, as D1 reported them. */
  rowsWritten: number;
};

type Meter = { queries: number; rowsRead: number; rowsWritten: number };

function count(m: Meter, r: { meta: { rows_read?: number; rows_written?: number } }) {
  m.queries++;
  m.rowsRead += r.meta.rows_read ?? 0;
  m.rowsWritten += r.meta.rows_written ?? 0;
}

const COLUMNS = `id, at, operation, risk, actor_type, actor_id, origin, decision, outcome, reason,
  org_id, project_id, work_item_id, policy_sha, input, result, diff, pending_action_id, approval_id,
  idempotency_key`;

type ScannedRow = AuditRow & { rid: number };

/**
 * One tick: archives due days in order (the day after the last one recorded), a chunk at a time,
 * until the row budget or the query budget is spent. Returns what it did and what it cost.
 */
export async function archiveAudit(
  env: Pick<Env, "DB" | "ARCHIVE">,
  now = new Date(),
  opts: { rows?: number; scanRows?: number } = {},
): Promise<AuditArchiveTick> {
  const m: Meter = { queries: 0, rowsRead: 0, rowsWritten: 0 };
  const tick: AuditArchiveTick = {
    archived: 0,
    days: [],
    day: null,
    mode: "idle",
    queries: 0,
    rowsRead: 0,
    rowsWritten: 0,
  };
  const cutoff = now.getTime() - AUDIT_ARCHIVE.afterDays * DAY;
  const holder = crypto.randomUUID();
  const leaseUntil = () => new Date(Date.now() + AUDIT_ARCHIVE.leaseMs).toISOString();
  let held: string | null = null;
  let drain: { state: DrainState; rows: number } | null = null;
  let budget = opts.rows ?? Number.POSITIVE_INFINITY;
  let scan = opts.scanRows ?? AUDIT_ARCHIVE.scanRows;
  const room = () => m.queries + 6 <= AUDIT_ARCHIVE.maxQueriesPerTick;
  try {
    while (budget > 0 && room()) {
      // The next day: the one after the last recorded, or the first row's (by rowid) less the skew.
      const lastDay = await env.DB.prepare(
        "SELECT day, root FROM core_audit_archives WHERE day = (SELECT max(day) FROM core_audit_archives)",
      ).all<{ day: string; root: string }>();
      count(m, lastDay);
      const last = lastDay.results[0] ?? null;
      let day: string;
      if (last) day = nextDay(last.day);
      else {
        const first = await env.DB.prepare("SELECT at FROM core_audit WHERE rowid = (SELECT min(rowid) FROM core_audit)").all<{
          at: string;
        }>();
        count(m, first);
        const at = first.results[0]?.at;
        if (!at) break;
        day = dayOf(new Date(Date.parse(at) - AUDIT_ARCHIVE.commitSkewMs).toISOString());
      }
      const dayEnd = Date.parse(`${nextDay(day)}T00:00:00.000Z`);
      if (dayEnd > cutoff) break;
      tick.day = day;
      const behindDays = (cutoff - dayEnd) / DAY;
      tick.mode = behindDays > AUDIT_ARCHIVE.keepUpDays ? "drain" : "keepUp";
      if (tick.mode === "drain" && opts.rows === undefined && !drain) {
        drain = await drainBudget(env.DB, now, m);
        budget = drain.rows;
        if (budget <= 0) break;
      }
      // The day's lease: taken when free or expired. Another tick holds it: skip, don't race.
      if (held !== day) {
        const lease = await env.DB.prepare(
          `INSERT INTO core_audit_archive_leases (day, holder, expires_at) VALUES (?, ?, ?)
           ON CONFLICT (day) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at
           WHERE core_audit_archive_leases.expires_at <= ?`,
        )
          .bind(day, holder, leaseUntil(), new Date().toISOString())
          .run();
        count(m, lease);
        if ((lease.meta.changes ?? 0) === 0) break;
        held = day;
      }
      const prevChunk = await env.DB.prepare(
        `SELECT seq, last_at, last_id, last_hash FROM core_audit_archive_chunks
         WHERE day = ? ORDER BY seq DESC LIMIT 1`,
      )
        .bind(day)
        .all<{ seq: number; last_at: string; last_id: string; last_hash: string }>();
      count(m, prevChunk);
      const pc = prevChunk.results[0];
      const prevRoot = last ? last.root : GENESIS;
      const done = await archiveDay(env, m, {
        day,
        dayEnd: new Date(dayEnd).toISOString(),
        seq: pc?.seq ?? 0,
        cont: pc ? { at: pc.last_at, id: pc.last_id } : { at: `${day}T00:00:00.000Z`, id: "" },
        prevHash: pc?.last_hash ?? prevRoot,
        prevRoot,
        holder,
        leaseUntil,
        budget: () => budget,
        spend: (n) => {
          budget -= n;
          tick.archived += n;
        },
        room,
        scan: () => scan,
        widen: () => {
          scan = Math.min(scan * 2, AUDIT_ARCHIVE.maxScanRows);
        },
      });
      if (!done) break;
      tick.days.push(day);
      held = null;
    }
  } catch (error) {
    if (!(error instanceof AuditArchiveStop)) throw error;
    console.warn(`audit archive stopped: ${error.message}`);
  } finally {
    if (held) {
      const r = await env.DB.prepare(
        "DELETE FROM core_audit_archive_leases WHERE day = ? AND holder = ?",
      )
        .bind(held, holder)
        .run();
      count(m, r);
    }
    if (drain && tick.archived > 0) {
      const spent = Math.min(drain.rows, tick.archived);
      const state: DrainState = {
        ...drain.state,
        credit: Math.max(0, drain.state.credit - spent),
        drainWrites: drain.state.drainWrites + spent * AUDIT_ARCHIVE.writesPerRow,
      };
      const r = await env.DB.prepare(
        "INSERT INTO core_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      )
        .bind(STATE_KEY, JSON.stringify(state))
        .run();
      count(m, r);
    }
  }
  tick.queries = m.queries;
  tick.rowsRead = m.rowsRead;
  tick.rowsWritten = m.rowsWritten;
  if (tick.archived > 0 || tick.days.length > 0) {
    console.log(`audit archive ${JSON.stringify(tick)}`);
  }
  return tick;
}

/**
 * The drain's rows for this tick: its monthly budget (5M rows written) spread over the days left in
 * the month, and only what keeps live traffic, the run archive and this drain under the run
 * archive's monthly ceiling (40M rows written). Whatever a tick doesn't spend carries to the next,
 * up to a few chunks, so a chunk isn't cut small.
 */
async function drainBudget(
  db: D1Database,
  now: Date,
  m: Meter,
): Promise<{ state: DrainState; rows: number }> {
  const month = now.toISOString().slice(0, 7);
  const [runs, stateRow] = await Promise.all([
    archiveBudget(db, now),
    db
      .prepare("SELECT value FROM core_meta WHERE key = ?")
      .bind(STATE_KEY)
      .all<{ value: string }>(),
  ]);
  m.queries += 1; // archiveBudget's one batch
  count(m, stateRow);
  let state: DrainState = { month, drainWrites: 0, credit: 0 };
  try {
    const raw = stateRow.results[0]?.value;
    if (raw) state = { ...state, ...(JSON.parse(raw) as Partial<DrainState>) };
  } catch {
    // A state we can't read starts the month's count again: the ceiling below still holds.
  }
  if (state.month !== month) state = { ...state, month, drainWrites: 0 };
  const monthEnd = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  const daysLeft = Math.max(1, (monthEnd - now.getTime()) / DAY);
  const paced = Math.max(0, AUDIT_ARCHIVE.drainWritesPerMonth - state.drainWrites) / daysLeft;
  const runArchiveWrites =
    (runs.drainRowsPerDay + runs.inflowRowsPerDay) * ARCHIVE.writesPerRow + runs.liveWritesPerDay;
  const headroom = Math.max(0, ARCHIVE.monthlyWriteCeiling / 30 - runArchiveWrites);
  const rowsPerTick =
    Math.min(paced, headroom) / AUDIT_ARCHIVE.writesPerRow / AUDIT_ARCHIVE.ticksPerDay;
  const credit = Math.min(state.credit + rowsPerTick, ARCHIVE_CHUNK_ROWS * 5);
  return { state: { ...state, credit }, rows: Math.floor(credit) };
}

type DayRun = {
  day: string;
  dayEnd: string;
  seq: number;
  cont: { at: string; id: string };
  prevHash: string;
  prevRoot: string;
  holder: string;
  leaseUntil: () => string;
  budget: () => number;
  spend: (n: number) => void;
  room: () => boolean;
  scan: () => number;
  widen: () => void;
};

/**
 * Archives one day from where its last chunk ended. Returns true once the day is recorded, false
 * when the tick ran out of rows or queries part-way (the next tick carries on from D1's records).
 */
async function archiveDay(env: Pick<Env, "DB" | "ARCHIVE">, m: Meter, d: DayRun): Promise<boolean> {
  const skew = AUDIT_ARCHIVE.commitSkewMs;
  let { seq, prevHash } = d;
  let cont = d.cont;
  let floor = await findFloor(env.DB, m, new Date(Date.parse(cont.at) - skew).toISOString());
  let stalled = 0;
  while (d.room()) {
    const ceil = floor + d.scan();
    // The first row past the window bounds what the window provably holds: every later row has
    // `at` > its `at` − skew.
    const next = await env.DB.prepare(
      "SELECT at FROM core_audit WHERE rowid > ? ORDER BY rowid LIMIT 1",
    )
      .bind(ceil)
      .all<{ at: string }>();
    count(m, next);
    const nextAt = next.results[0]?.at;
    const safe = nextAt ? new Date(Date.parse(nextAt) - skew).toISOString() : d.dayEnd;
    const until = safe < d.dayEnd ? safe : d.dayEnd;
    if (until <= cont.at && nextAt) {
      // The window is too narrow for the rows the skew spans: widen it.
      if (d.scan() >= AUDIT_ARCHIVE.maxScanRows) {
        throw new AuditArchiveStop(`${d.day}: no progress at the widest window`);
      }
      d.widen();
      continue;
    }
    const want = Math.min(ARCHIVE_CHUNK_ROWS, d.budget());
    if (want <= 0) return false;
    const page = await env.DB.prepare(
      `SELECT rowid AS rid, ${COLUMNS} FROM core_audit
       WHERE rowid > ? AND rowid <= ? AND at < ?
         AND (at > ? OR (at = ? AND id > ?))
         AND ${MACHINE_ROW_SQL}
       ORDER BY at, id LIMIT ?`,
    )
      .bind(floor, ceil, until, cont.at, cont.at, cont.id, want)
      .all<ScannedRow>();
    count(m, page);
    const rows = cut(page.results);
    if (rows.length > 0) {
      stalled = 0;
      seq += 1;
      const lastHash = await archiveChunk(env, m, d, seq, prevHash, rows);
      d.spend(rows.length);
      prevHash = lastHash;
      const end = rows.at(-1) as ScannedRow;
      cont = { at: end.at, id: end.id };
      // A row of this page whose `at` is a skew before the new continuation: every row before it
      // (by rowid) is done, so the next window starts there.
      const lower = Date.parse(cont.at) - skew;
      for (const r of rows) if (Date.parse(r.at) < lower && r.rid > floor) floor = r.rid;
      continue;
    }
    if (until >= d.dayEnd) {
      await recordDay(env, m, d);
      return true;
    }
    // Nothing more before `until`: carry on from there.
    cont = { at: until, id: "" };
    const moved = await findFloor(env.DB, m, new Date(Date.parse(until) - skew).toISOString());
    if (moved <= floor) {
      stalled++;
      if (stalled > 2) d.widen();
    }
    floor = Math.max(floor, moved);
  }
  return false;
}

/** A page cut to ARCHIVE_CHUNK_BYTES (one row at least). */
function cut(rows: ScannedRow[]): ScannedRow[] {
  let bytes = 0;
  let take = 0;
  for (const r of rows) {
    const size = (r.input?.length ?? 0) + (r.result?.length ?? 0) + (r.diff?.length ?? 0) + 400;
    if (take > 0 && bytes + size > ARCHIVE_CHUNK_BYTES) break;
    bytes += size;
    take++;
  }
  return rows.slice(0, take);
}

/**
 * The largest rowid found whose row has `at` before `before`, by a few rounds of probes (each round
 * one query: 31 rowid seeks through json_each). Every row before it has `at` < before + skew. 0
 * when no row is found before `before`.
 */
async function findFloor(db: D1Database, m: Meter, before: string): Promise<number> {
  const top = await db.prepare("SELECT max(rowid) AS top FROM core_audit").all<{ top: number }>();
  count(m, top);
  let lo = 0;
  let hi = (top.results[0]?.top ?? 0) + 1;
  for (let round = 0; round < 4 && hi - lo > 1; round++) {
    const step = Math.max(1, Math.floor((hi - lo) / 32));
    const probes: number[] = [];
    for (let p = lo + step; p < hi && probes.length < 31; p += step) probes.push(p);
    if (probes.length === 0) break;
    const r = await db
      .prepare(
        `SELECT j.value AS p, a.rowid AS rid, a.at FROM json_each(?) j
         JOIN core_audit a ON a.rowid = (
           SELECT rowid FROM core_audit WHERE rowid >= j.value ORDER BY rowid LIMIT 1)`,
      )
      .bind(JSON.stringify(probes))
      .all<{ p: number; rid: number; at: string }>();
    count(m, r);
    let nextHi = hi;
    for (const x of r.results.sort((a, b) => a.p - b.p)) {
      if (x.at < before) lo = Math.max(lo, x.rid);
      else if (x.p > lo) {
        nextHi = Math.min(nextHi, x.p);
        break;
      }
    }
    hi = nextHi;
  }
  return lo;
}

/**
 * Puts one chunk create-only, verifies it, and in one D1 batch records it (only while this tick
 * holds the day's lease, the chain continues from the chunk before, and every row is still there),
 * indexes it by work item, and deletes its rows (only where the record names this object). Returns
 * the chunk's last hash; throws AuditArchiveStop when D1 and the object disagree.
 */
async function archiveChunk(
  env: Pick<Env, "DB" | "ARCHIVE">,
  m: Meter,
  d: DayRun,
  seq: number,
  prevHash: string,
  scanned: ScannedRow[],
): Promise<string> {
  const rows: AuditRow[] = scanned.map(({ rid: _rid, ...row }) => row);
  rows.sort(byAtId);
  const first = rows[0] as AuditRow;
  const last = rows.at(-1) as AuditRow;
  const key = auditChunkKey(d.day, seq, first, last);
  const { lines, last: lastHash } = await chainLines(prevHash, rows);
  const body = new TextEncoder().encode(`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  const sha256 = await sha256Hex(body);
  const put = await env.ARCHIVE.put(key, body, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "application/x-ndjson" },
    customMetadata: { rows: String(rows.length), sha256, prevHash, lastHash },
    sha256,
  });
  if (put) {
    const returned = put.checksums.sha256 ? hex(new Uint8Array(put.checksums.sha256)) : null;
    if (returned !== null && returned !== sha256) {
      throw new AuditArchiveStop(`${key}: R2 holds ${returned}, we wrote ${sha256}`);
    }
    if (returned === null) {
      const head = await env.ARCHIVE.head(key);
      if (head?.customMetadata?.sha256 !== sha256 || head.size !== body.length) {
        throw new AuditArchiveStop(`${key}: the object written doesn't match`);
      }
    }
  } else {
    // Already there (a tick that died after its put): used only if it is exactly this chunk.
    const existing = await env.ARCHIVE.get(key);
    if (!existing) throw new AuditArchiveStop(`${key}: refused as existing, then not found`);
    const held = await sha256Hex(new Uint8Array(await existing.arrayBuffer()));
    if (held !== sha256) throw new AuditArchiveStop(`${key}: the existing object differs`);
  }
  const nowIso = new Date().toISOString();
  const ids = JSON.stringify(rows.map((r) => r.id));
  const perItem = new Map<string, number>();
  for (const r of rows) {
    if (r.work_item_id) perItem.set(r.work_item_id, (perItem.get(r.work_item_id) ?? 0) + 1);
  }
  // The chain continues from the chunk before (or the previous day's root, or genesis).
  const chained =
    seq === 1
      ? d.prevRoot === GENESIS
        ? "(SELECT max(day) FROM core_audit_archives) IS NULL"
        : "EXISTS (SELECT 1 FROM core_audit_archives WHERE day = ? AND root = ?)"
      : "EXISTS (SELECT 1 FROM core_audit_archive_chunks WHERE day = ? AND seq = ? AND last_hash = ?)";
  const chainArgs =
    seq === 1
      ? d.prevRoot === GENESIS
        ? []
        : [prevDay(d.day), d.prevRoot]
      : [d.day, seq - 1, prevHash];
  const recorded = `EXISTS (SELECT 1 FROM core_audit_archive_chunks WHERE day = ? AND seq = ? AND r2_key = ?)`;
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO core_audit_archive_chunks (day, seq, r2_key, first_at, first_id, last_at, last_id,
         rows, bytes, sha256, prev_hash, last_hash, archived_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM core_audit_archive_leases WHERE day = ? AND holder = ? AND expires_at > ?)
         AND ${chained}
         AND (SELECT count(*) FROM core_audit WHERE id IN (SELECT value FROM json_each(?))) = ?`,
    ).bind(
      d.day,
      seq,
      key,
      first.at,
      first.id,
      last.at,
      last.id,
      rows.length,
      body.length,
      sha256,
      prevHash,
      lastHash,
      nowIso,
      d.day,
      d.holder,
      nowIso,
      ...chainArgs,
      ids,
      rows.length,
    ),
    env.DB.prepare(
      `INSERT INTO core_audit_archive_items (work_item_id, day, seq, rows)
       SELECT j.key, ?, ?, j.value FROM json_each(?) j WHERE ${recorded}`,
    ).bind(d.day, seq, JSON.stringify(Object.fromEntries(perItem)), d.day, seq, key),
    env.DB.prepare(
      `DELETE FROM core_audit WHERE id IN (SELECT value FROM json_each(?)) AND ${recorded}`,
    ).bind(ids, d.day, seq, key),
    env.DB.prepare(
      "UPDATE core_audit_archive_leases SET expires_at = ? WHERE day = ? AND holder = ?",
    ).bind(d.leaseUntil(), d.day, d.holder),
  ]);
  for (const r of results) count(m, r);
  m.queries -= results.length - 1; // one batch is one request
  if ((results[0]?.meta.changes ?? 0) === 0) {
    throw new AuditArchiveStop(`${key}: not recorded (lease lost, chain moved, or rows changed)`);
  }
  const deleted = results[2]?.meta.changes ?? 0;
  if (deleted !== rows.length) {
    throw new AuditArchiveStop(
      `${key}: ${rows.length} rows in the object, ${deleted} deleted from D1; left for a person`,
    );
  }
  return lastHash;
}

/** Records the day (root, chunks, rows) once its last chunk is in, and drops the lease. */
async function recordDay(env: Pick<Env, "DB">, m: Meter, d: DayRun): Promise<void> {
  const nowIso = new Date().toISOString();
  const linked =
    d.prevRoot === GENESIS
      ? "(SELECT max(day) FROM core_audit_archives) IS NULL"
      : "EXISTS (SELECT 1 FROM core_audit_archives WHERE day = ? AND root = ?)";
  const linkArgs = d.prevRoot === GENESIS ? [] : [prevDay(d.day), d.prevRoot];
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO core_audit_archives (day, chunks, rows, root, prev_root, archived_at)
       SELECT ?, count(*), coalesce(sum(rows), 0),
         coalesce((SELECT last_hash FROM core_audit_archive_chunks WHERE day = ? ORDER BY seq DESC LIMIT 1), ?),
         ?, ?
       FROM core_audit_archive_chunks WHERE day = ?
       HAVING EXISTS (SELECT 1 FROM core_audit_archive_leases WHERE day = ? AND holder = ? AND expires_at > ?)
         AND ${linked}`,
    ).bind(
      d.day,
      d.day,
      d.prevRoot,
      d.prevRoot,
      nowIso,
      d.day,
      d.day,
      d.holder,
      nowIso,
      ...linkArgs,
    ),
    env.DB.prepare("DELETE FROM core_audit_archive_leases WHERE day = ? AND holder = ?").bind(
      d.day,
      d.holder,
    ),
  ]);
  for (const r of results) count(m, r);
  m.queries -= results.length - 1;
  if ((results[0]?.meta.changes ?? 0) === 0) {
    throw new AuditArchiveStop(`${d.day}: not recorded (lease lost or the chain moved)`);
  }
}

async function sha256Hex(body: Uint8Array): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", body)));
}

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
