// The reconciler in shadow (spec 52 PR (c), ADR 0511 §7). It is off the Workflow's path: nothing in
// a Workflow step waits on it or can fail because of it. Every five minutes the cron's shadow pass
// reads the work items that reached an end (done, failed, rejected, cancelled) since its cursor,
// replays each one's stage history through the reconciler, and writes one verdict row per item. It
// drives nothing.
//
// Cost (D1 bills rows scanned), per tick:
// - reads: the cursor (one row, by primary key); the ended items after it, by the partial index
//   core_work_items_ended_idx (updated_at, id) WHERE status is an end (migration 0281), LIMIT 25:
//   at most 25 rows; then one batch with, per item, its row by primary key with its pinned policy by
//   primary key and, for an item on an org workflow, the org config version it pinned by primary key
//   and its project's override approvals for that version by core_override_approvals' primary-key
//   prefix (spec 52 PR (d); a few rows), its stage rows by core_stages_item_idx (LIMIT 500, a handful in
//   practice), its jobs by core_jobs_item_idx each with its run by primary key (LIMIT 200), its
//   gates by core_pending_actions_item_idx each with its decider's user row by primary key (LIMIT
//   200), and whether the merge queue carried a review packet to a new head, by
//   core_review_packets_item_idx (the item's packets, one per verify round, LIMIT 1 hit). Five
//   statements per item, 125 per page, in one batch.
//   With nothing new: one row and one empty index probe.
// - writes: one `core_reconcile_items` row per ended item (at most 25) and the cursor (one row).
// The audit table is never read: it is the hottest write table and has no index to find ends by.
// Pruning: `pruneReconcileShadow`, hourly from the minute cron.

import { has, onOrgWorkflow, type ProjectPolicy, parseProjectPolicy } from "@software-factory/core";
import {
  compileItemWorkflow,
  effectivePolicy,
  type GateRow,
  type ItemEnd,
  type JobRow,
  parseOrgConfig,
  type ShadowHistory,
  type ShadowObserved,
  SIZE_RANK,
  type Size,
  type StageRow,
  shadowVerdict,
} from "@software-factory/core/stages";

interface ItemRow {
  id: string;
  org_id: string;
  kind: "change" | "incident" | "attached";
  status: string;
  size: Size | null;
  domains: string | null;
  spec_required: number | null;
  workflow: string | null;
  pulled_at: string | null;
  raw: string | null;
  /** The org config the item pinned (spec 52 PR (d)): only read for an item that pinned one. */
  org_raw: string | null;
  /** The org admins' approvals of its looser overrides for that version, as a JSON array. */
  approvals: string | null;
  /** The Workflow version it ran on (ADR 0053). */
  workflow_version: number | null;
}

/** Where the last pass stopped: `<updated_at> <id>` of the last ended item it read. */
export const SHADOW_CURSOR = "reconcile_shadow_cursor";
const PAGE = 25;
/**
 * Items whose last write is this recent wait for the next pass: an operation stamps `updated_at`
 * when it starts and commits after, so a write in flight may land behind a cursor already past it.
 */
export const SHADOW_LAG_MS = 2 * 60_000;
const ENDS: readonly string[] = ["done", "failed", "rejected", "cancelled"];

/** Verdicts are kept this long (they measure the reconciler before the switch-over). */
export const VERDICT_KEEP_MS = 90 * 24 * 3_600_000;

/** One page of ended items. Returns how many it read, so a caller can drain a backlog. */
export async function shadowPass(env: Env, now = new Date()): Promise<number> {
  const raw =
    (
      await env.DB.prepare("SELECT value FROM core_meta WHERE key = ?")
        .bind(SHADOW_CURSOR)
        .first<{ value: string }>()
    )?.value ?? "";
  const [cursorAt = "", cursorId = ""] = raw.split(" ");
  // INDEXED BY: the planner, with no statistics, would read every ended item by status and sort
  // them; the partial index walks only the ends after the cursor, in order, and stops at the LIMIT.
  // The status list must match the index's WHERE exactly for SQLite to use it.
  const { results: ended } = await env.DB.prepare(
    `SELECT id, updated_at FROM core_work_items INDEXED BY core_work_items_ended_idx
     WHERE status IN ('done', 'failed', 'rejected', 'cancelled')
       AND (updated_at, id) > (?, ?) AND updated_at < ?
     ORDER BY updated_at, id LIMIT ?`,
  )
    .bind(cursorAt, cursorId, new Date(now.getTime() - SHADOW_LAG_MS).toISOString(), PAGE)
    .all<{ id: string; updated_at: string }>();
  if (ended.length === 0) return 0;
  const ids = ended.map((e) => e.id);
  const reads = await env.DB.batch(
    ids.flatMap((id) => [
      env.DB.prepare(
        `SELECT w.id, w.org_id, w.kind, w.status, w.size, w.domains, w.spec_required, w.workflow, w.pulled_at, w.workflow_version, p.raw,
           c.raw AS org_raw,
           (SELECT json_group_array(json_object('stage', a.stage_id, 'setting', a.setting, 'value', a.value))
            FROM core_override_approvals a
            WHERE a.project_id = w.project_id AND a.org_version = w.org_config_version) AS approvals
         FROM core_work_items w
         LEFT JOIN core_project_policies p ON p.project_id = w.project_id
           AND p.sha = COALESCE(w.policy_sha, (SELECT policy_sha FROM core_projects WHERE id = w.project_id))
         LEFT JOIN core_org_configs c ON c.org_id = w.org_id AND c.version = w.org_config_version
         WHERE w.id = ?`,
      ).bind(id),
      env.DB.prepare(
        "SELECT stage, status, started_at AS at, ended_at AS endedAt FROM core_stages WHERE work_item_id = ? ORDER BY started_at, rowid LIMIT 500",
      ).bind(id),
      // Its jobs (core_jobs_item_idx) with what each run reported (core_runs by primary key): the
      // steps the reconciler is compared on. A handful per item; LIMIT 200 bounds a runaway one.
      // Unsorted: the replay orders everything by time itself (no temp B-tree here).
      env.DB.prepare(
        `SELECT j.stage, j.role, j.status, j.created_at AS at, j.finished_at AS endedAt,
           json_extract(j.context, '$.step.id') AS step,
           json_extract(j.context, '$.specId') IS NOT NULL AS critic,
           json_extract(j.context, '$.adjudicate') IS NOT NULL AS adjudicate,
           json_extract(r.result, '$.verdict') AS verdict, json_extract(r.result, '$.notes') AS note
         FROM core_jobs j LEFT JOIN core_runs r ON r.id = j.run_id
         WHERE j.work_item_id = ? LIMIT 200`,
      ).bind(id),
      // Its gates (core_pending_actions_item_idx), and whether a person decided each one (the
      // decider's user row by primary key). LIMIT 200.
      env.DB.prepare(
        `SELECT pa.kind, pa.operation, pa.status, pa.decision, pa.created_at AS at,
           pa.decided_at AS decidedAt, pa.note,
           json_extract(pa.input, '$.stepId') AS step, json_extract(pa.input, '$.headSha') AS headSha,
           EXISTS (SELECT 1 FROM core_user u WHERE u.id = pa.decided_by) AS byPerson
         FROM core_pending_actions pa
         WHERE pa.work_item_id = ? LIMIT 200`,
      ).bind(id),
      // The merge queue merged the default branch in and carried the packet to the new head
      // (carryReviewPacket, ADR 0330).
      env.DB.prepare(
        "SELECT 1 AS moved FROM core_review_packets WHERE work_item_id = ? AND json_extract(sections, '$.carriedFrom') IS NOT NULL LIMIT 1",
      ).bind(id),
    ]),
  );
  const last = ended.at(-1) as { id: string; updated_at: string };
  const writes = [
    env.DB.prepare(
      "INSERT INTO core_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    ).bind(SHADOW_CURSOR, `${last.updated_at} ${last.id}`),
  ];
  ended.forEach((e, i) => {
    const at = PER_ITEM * i;
    const row = (reads[at]?.results as ItemRow[] | undefined)?.[0];
    const stages = (reads[at + 1]?.results ?? []) as StageRow[];
    const queueHeadMoved = (reads[at + 4]?.results ?? []).length > 0;
    const jobs = ((reads[at + 2]?.results ?? []) as RawJob[]).map(jobOf);
    const gates = ((reads[at + 3]?.results ?? []) as RawGate[]).map(gateOf);
    const verdict = row
      ? verdictOf(
          row,
          { stages, jobs, gates },
          { queueHeadMoved, babysitter: has(row.workflow_version, "babysitter-delivery") },
        )
      : null;
    if (!row || !verdict) return;
    writes.push(
      env.DB.prepare(
        "INSERT OR REPLACE INTO core_reconcile_items (work_item_id, org_id, ended, transitions, divergences, report, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        row.id,
        row.org_id,
        row.status,
        verdict.transitions.length,
        verdict.divergences,
        JSON.stringify(verdict),
        e.updated_at,
      ),
    );
  });
  await env.DB.batch(writes);
  return ended.length;
}
/** Per ended item, the batch reads: the item, its stages, its jobs, its gates, a moved head. */
const PER_ITEM = 5;

interface RawJob {
  stage: JobRow["stage"];
  role: string;
  status: JobRow["status"];
  at: string;
  endedAt: string | null;
  step: string | null;
  critic: number;
  adjudicate: number;
  verdict: string | null;
  note: string | null;
}
interface RawGate {
  kind: GateRow["kind"];
  operation: string;
  status: string;
  decision: string | null;
  at: string;
  decidedAt: string | null;
  note: string | null;
  step: string | null;
  headSha: string | null;
  byPerson: number;
}
const jobOf = (j: RawJob): JobRow => ({
  ...j,
  critic: j.critic === 1,
  adjudicate: j.adjudicate === 1,
  // `notes` is a list in a run's result; one line is enough for a send-back's note.
  note: typeof j.note === "string" ? j.note.slice(0, 500) : null,
});
const gateOf = (g: RawGate): GateRow => ({ ...g, byPerson: g.byPerson === 1 });

function verdictOf(row: ItemRow, history: ShadowHistory, observed: ShadowObserved) {
  const stages = history.stages;
  if (!ENDS.includes(row.status) || !row.raw) return null; // not ended, or no pinned config
  // Cancelled before its pipeline started: nothing ran, so there is nothing to compare.
  if (stages.every((s) => s.stage === "intake")) return null;
  const parsed = parseProjectPolicy(row.raw);
  if (!parsed.ok) return null;
  const policy = resolved(parsed.policy, row.org_raw, row.approvals);
  if (!policy) return null; // an org workflow that can't be resolved: not comparable
  let definition: ReturnType<typeof compileItemWorkflow>;
  try {
    definition = compileItemWorkflow(policy, row.workflow, row.kind);
  } catch {
    return null; // a slot workflow that doesn't compile (spec 52 PR (a)): not comparable
  }
  let domains: string[] = [];
  try {
    domains = row.domains ? (JSON.parse(row.domains) as string[]) : [];
  } catch {
    domains = [];
  }
  const size = row.size;
  // Triage recorded whether the spec is required; below the threshold that was the foreman asking.
  const belowThreshold =
    size !== null &&
    size !== "large" &&
    SIZE_RANK[size] < SIZE_RANK[policy.spec.requiredFrom as Size];
  return shadowVerdict(
    definition,
    {
      kind: row.kind,
      size,
      domains,
      hasRepository: true,
      released: row.pulled_at !== null || row.kind !== "change",
      retryLimit: policy.retryLimit,
      ...(row.spec_required === 1 && belowThreshold ? { specRequested: "require" as const } : {}),
    },
    history,
    row.status as ItemEnd,
    observed,
  );
}

/**
 * The config the item ran (spec 52 PR (d)): on an org workflow, the org workflow it pinned, with the
 * project's overrides, resolved as today's engine ran it (`effectivePolicy`); otherwise the project's
 * own. Null when it can't be resolved (no pinned org version, or one that doesn't apply).
 */
function resolved(
  policy: ProjectPolicy,
  orgRaw: string | null,
  approvalsRaw: string | null,
): ProjectPolicy | null {
  if (!onOrgWorkflow(policy)) return policy;
  if (!orgRaw) return null;
  let org: ReturnType<typeof parseOrgConfig>;
  try {
    org = parseOrgConfig(JSON.parse(orgRaw));
  } catch {
    return null;
  }
  if (!org.ok) return null;
  const approvals: Record<string, Record<string, unknown>> = {};
  try {
    for (const a of JSON.parse(approvalsRaw ?? "[]") as {
      stage: string;
      setting: string;
      value: string;
    }[])
      approvals[a.stage] = { ...approvals[a.stage], [a.setting]: JSON.parse(a.value) };
  } catch {
    // Unreadable approvals approve nothing: the stricter values apply.
  }
  const effective = effectivePolicy(policy, org.config, approvals);
  return effective.ok ? effective.value : null;
}

/** Hourly: verdicts past 90 days, a bounded batch, oldest first. */
export async function pruneReconcileShadow(env: Env, now: Date): Promise<void> {
  await env.DB.prepare(
    "DELETE FROM core_reconcile_items WHERE work_item_id IN (SELECT work_item_id FROM core_reconcile_items WHERE finished_at < ? ORDER BY finished_at LIMIT 1000)",
  )
    .bind(new Date(now.getTime() - VERDICT_KEEP_MS).toISOString())
    .run();
}
