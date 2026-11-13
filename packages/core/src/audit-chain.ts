// The audit archive's hash chain (ADR 0590, as built in ADR 0591). Routine machine rows of
// core_audit older than 90 days are archived to R2 one UTC day at a time, in (at, id) order, as
// NDJSON objects of at most ARCHIVE_CHUNK_ROWS rows. Each line is `{ hash, row }`:
//   hash = SHA-256(prev_hash ‖ canonical JSON of the row as stored)
// starting from the previous day's root (GENESIS for the first day archived). A day's root is the
// hash of its last row, or the previous day's root when it had none. The roots and every chunk's
// range, first and last hash are recorded in D1 (core_audit_archives, core_audit_archive_chunks),
// so a missing, altered, added or reordered row, or a missing object or day, breaks the chain.
// Shared by the archiver (sf-engine's cron), workItem.timeline and audit.verify.
import type { CoreAuditTable } from "@software-factory/db";
import { canonicalJson } from "./invoke.ts";

/** The root the first archived day chains from. */
export const GENESIS = "0".repeat(64);

/** Rows in one archived object at most (a day of machine rows is a few thousand). */
export const ARCHIVE_CHUNK_ROWS = 1_000;

/** Bytes in one archived object at most: the chunk is cut before a row would take it past this. */
export const ARCHIVE_CHUNK_BYTES = 1_000_000;

/** Machine rows are archived once they are this old. */
export const AUDIT_ARCHIVE_AFTER_DAYS = 90;

/**
 * The routine operations whose machine rows are archived: the list in migration 0366's delete
 * trigger, which a test keeps equal to this one. Leases, heartbeats, claims, steers, run events,
 * artifacts, hand-backs, stage moves, merge-queue moves short of merging, the first push of a branch,
 * deliveries of news, and the intake's observations. Never anything that issues a credential (a
 * job token, a runner key or CLI token from a device login, a sign-in), records what reached main
 * (`mergeQueue.merging`, `branch.advance`, a merge), a PR, a spec, a triage, a question, planning
 * content, a gate, an incident, a config or policy change, or an item created or released:
 * NEVER_ARCHIVED names the ones that would otherwise look routine.
 */
export const AUDIT_ARCHIVE_OPERATIONS = [
  "runner.heartbeat",
  "job.claim",
  "job.enqueue",
  "run.takeSteers",
  "run.reportEvents",
  "run.addArtifact",
  "run.handBack",
  "run.release",
  "run.expire",
  "lease.claim",
  "lease.heartbeat",
  "lease.release",
  "planning.wait",
  "planning.news",
  "planning.yield",
  "planning.requestYield",
  "branch.ensure",
  "workItem.enterStage",
  "workItem.awaitHead",
  "workItem.awaitQuestions",
  "mergeQueue.enter",
  "mergeQueue.leave",
  "mergeQueue.update",
  "mergeQueue.hold",
  "queue.pull",
  "connector.receive",
  "push.observe",
  "main.observe",
  "verify.refresh",
] as const;

/**
 * Routine-looking operations that stay in D1 forever (review of #170): the record that a credential
 * was issued (device logins settle into a runner key or a CLI token; `run.issueToken` mints a
 * GitHub token, ADR 0033), and the record of what reached main. A test keeps them off both lists.
 */
export const NEVER_ARCHIVED = [
  "runner.deviceStart",
  "runner.devicePoll",
  "cli.deviceStart",
  "cli.devicePoll",
  "run.issueToken",
  "mergeQueue.merging",
  "branch.advance",
  "pr.merge",
  "pr.autoMerge",
  "desktop.authExchange",
  "mobile.authExchange",
] as const;

const ARCHIVED_OPS: ReadonlySet<string> = new Set(AUDIT_ARCHIVE_OPERATIONS);

/** An audit row as stored (every column), the unit the chain hashes. */
export type AuditRow = Omit<CoreAuditTable, "diff"> & { diff: string };

/**
 * Whether a row is a machine row (migration 0366): a runner's, the scheduler's, an intake
 * connector's or the foreman's call to one of AUDIT_ARCHIVE_OPERATIONS, allowed and successful,
 * tied to no gate or approval. Only these are ever archived and deleted; the trigger refuses any
 * other delete.
 */
export function isMachineRow(
  r: Pick<
    AuditRow,
    | "operation"
    | "actor_type"
    | "actor_id"
    | "decision"
    | "outcome"
    | "pending_action_id"
    | "approval_id"
  >,
): boolean {
  const machine =
    r.actor_type === "runner" ||
    r.actor_type === "scheduler" ||
    r.actor_type === "intake" ||
    (r.actor_type === "agent" && r.actor_id === "foreman");
  return (
    machine &&
    r.decision === "allow" &&
    r.outcome === "ok" &&
    r.pending_action_id === null &&
    r.approval_id === null &&
    ARCHIVED_OPS.has(r.operation)
  );
}

/** The SQL form of isMachineRow over core_audit's own columns (for the archiver's reads). */
export const MACHINE_ROW_SQL = `decision = 'allow' AND outcome = 'ok'
  AND pending_action_id IS NULL AND approval_id IS NULL
  AND (actor_type IN ('runner', 'scheduler', 'intake') OR (actor_type = 'agent' AND actor_id = 'foreman'))
  AND operation IN (${AUDIT_ARCHIVE_OPERATIONS.map((o) => `'${o}'`).join(", ")})`;

/** The UTC day (YYYY-MM-DD) a row belongs to. */
export const dayOf = (at: string) => at.slice(0, 10);

/** The day after `day`. */
export function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);
}

/** The day before `day`. */
export function prevDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10);
}

/** The object holding chunk `seq` of `day`: named by its day, seq and (at, id) range. */
export function auditChunkKey(
  day: string,
  seq: number,
  first: { at: string; id: string },
  last: { at: string; id: string },
): string {
  const [y, m, d] = day.split("-");
  return `audit/${y}/${m}/${d}/${String(seq).padStart(5, "0")}_${first.at}_${first.id}__${last.at}_${last.id}.ndjson`;
}

async function sha256Hex(text: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A row's place in the chain: SHA-256 of the previous hash and the row's canonical JSON. */
export function rowHash(prev: string, row: AuditRow): Promise<string> {
  return sha256Hex(prev + canonicalJson(row));
}

/** The lines of an object for `rows` (in (at, id) order) chained from `prev`, and the last hash. */
export async function chainLines(
  prev: string,
  rows: AuditRow[],
): Promise<{ lines: { hash: string; row: AuditRow }[]; last: string }> {
  const lines: { hash: string; row: AuditRow }[] = [];
  let hash = prev;
  for (const row of rows) {
    hash = await rowHash(hash, row);
    lines.push({ hash, row });
  }
  return { lines, last: hash };
}

/** (at, id) order, the archive's and the chain's. */
export const byAtId = (a: { at: string; id: string }, b: { at: string; id: string }) =>
  a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** Parses an archived object's body into its lines; throws on a line that isn't one. */
export function parseChunk(body: string): { hash: string; row: AuditRow }[] {
  return body
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => {
      const line = JSON.parse(l) as { hash?: unknown; row?: unknown };
      if (typeof line.hash !== "string" || typeof line.row !== "object" || line.row === null) {
        throw new Error("not an audit archive line");
      }
      return line as { hash: string; row: AuditRow };
    });
}

/** What re-hashing one archived object found. */
export type ChunkCheck = { ok: true; last: string; rows: number } | { ok: false; why: string };

/**
 * Re-hashes an object's rows from `prev` and checks them against the chunk's record: every line's
 * hash, the order, the range, the row count, the last hash, and that each row is a machine row of
 * that day. Says what is wrong when anything is.
 */
export async function checkChunk(
  record: {
    day: string;
    first_at: string;
    first_id: string;
    last_at: string;
    last_id: string;
    rows: number;
    prev_hash: string;
    last_hash: string;
  },
  prev: string,
  body: string,
): Promise<ChunkCheck> {
  if (record.prev_hash !== prev) {
    return {
      ok: false,
      why: `chains from ${record.prev_hash.slice(0, 12)}, not ${prev.slice(0, 12)}`,
    };
  }
  let lines: { hash: string; row: AuditRow }[];
  try {
    lines = parseChunk(body);
  } catch {
    return { ok: false, why: "the object isn't an audit archive" };
  }
  if (lines.length !== record.rows) {
    return { ok: false, why: `${lines.length} rows in the object, ${record.rows} recorded` };
  }
  let hash = prev;
  let before: { at: string; id: string } | null = null;
  for (const [i, line] of lines.entries()) {
    const r = line.row;
    if (before && byAtId(before, r) >= 0) return { ok: false, why: `row ${i + 1} is out of order` };
    if (dayOf(r.at) !== record.day || !isMachineRow(r)) {
      return { ok: false, why: `row ${i + 1} isn't a machine row of ${record.day}` };
    }
    hash = await rowHash(hash, r);
    if (hash !== line.hash) return { ok: false, why: `row ${i + 1}'s hash doesn't match` };
    before = r;
  }
  const first = lines[0]?.row;
  const last = lines.at(-1)?.row;
  if (
    first?.at !== record.first_at ||
    first.id !== record.first_id ||
    last?.at !== record.last_at ||
    last.id !== record.last_id
  ) {
    return { ok: false, why: "the rows don't span the recorded range" };
  }
  if (hash !== record.last_hash)
    return { ok: false, why: "the last hash doesn't match the record" };
  return { ok: true, last: hash, rows: lines.length };
}
