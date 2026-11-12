// The reconciler in shadow (spec 52 PR (c), ADR 0511 §7). It is off the Workflow's path: nothing in
// a Workflow step waits on it or can fail because of it. Every five minutes the cron's shadow pass
// reads the items that ended since its cursor (from the `workItem.finish` and `workItem.cancel` audit
// rows the operations already write), replays each one's stage history through the reconciler, and
// writes one verdict row per item. It drives nothing.
//
// Cost (D1 bills rows scanned): the cursor (a point read) and the ended items after it by
// core_audit_operation_idx (operation, at), LIMIT 25; then one batch with, per item, its row by
// primary key with its pinned policy by primary key and its stage rows by core_stages_item_idx
// (LIMIT 500); then one batch of writes: one `core_reconcile_items` row per ended item, and the
// cursor. Rows written per item: one. Pruning: `pruneReconcileShadow`, hourly from the minute cron.

import { parseProjectPolicy } from "@software-factory/core";
import {
  compileItemWorkflow,
  type ItemEnd,
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
}

/** Where the last pass stopped: the `at` of the last ended item it read. */
export const SHADOW_CURSOR = "reconcile_shadow_cursor";
const PAGE = 25;
const ENDS: readonly string[] = ["done", "failed", "rejected", "cancelled"];

/** Verdicts are kept this long (they measure the reconciler before the switch-over). */
export const VERDICT_KEEP_MS = 90 * 24 * 3_600_000;

/** One page of ended items. Returns how many it read, so a caller can drain a backlog. */
export async function shadowPass(env: Env): Promise<number> {
  const cursor =
    (
      await env.DB.prepare("SELECT value FROM core_meta WHERE key = ?")
        .bind(SHADOW_CURSOR)
        .first<{ value: string }>()
    )?.value ?? "";
  const { results: ended } = await env.DB.prepare(
    `SELECT work_item_id, at FROM core_audit
     WHERE operation IN ('workItem.finish', 'workItem.cancel') AND outcome = 'ok' AND at > ?
       AND work_item_id IS NOT NULL
     ORDER BY at LIMIT ?`,
  )
    .bind(cursor, PAGE)
    .all<{ work_item_id: string; at: string }>();
  if (ended.length === 0) return 0;
  const ids = [...new Set(ended.map((e) => e.work_item_id))];
  const reads = await env.DB.batch(
    ids.flatMap((id) => [
      env.DB.prepare(
        `SELECT w.id, w.org_id, w.kind, w.status, w.size, w.domains, w.spec_required, w.workflow, w.pulled_at, p.raw
         FROM core_work_items w
         LEFT JOIN core_project_policies p ON p.project_id = w.project_id
           AND p.sha = COALESCE(w.policy_sha, (SELECT policy_sha FROM core_projects WHERE id = w.project_id))
         WHERE w.id = ?`,
      ).bind(id),
      env.DB.prepare(
        "SELECT stage, status FROM core_stages WHERE work_item_id = ? ORDER BY started_at, rowid LIMIT 500",
      ).bind(id),
    ]),
  );
  const at = (ended.at(-1) as { at: string }).at;
  const writes = [
    env.DB.prepare(
      "INSERT INTO core_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    ).bind(SHADOW_CURSOR, at),
  ];
  ids.forEach((id, i) => {
    const row = (reads[2 * i]?.results as ItemRow[] | undefined)?.[0];
    const stages = (reads[2 * i + 1]?.results ?? []) as StageRow[];
    const verdict = row ? verdictOf(row, stages) : null;
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
        ended.filter((e) => e.work_item_id === id).at(-1)?.at ?? at,
      ),
    );
  });
  await env.DB.batch(writes);
  return ended.length;
}

function verdictOf(row: ItemRow, stages: StageRow[]) {
  if (!ENDS.includes(row.status) || !row.raw) return null; // not ended, or no pinned config
  // Cancelled before its pipeline started: nothing ran, so there is nothing to compare.
  if (stages.every((s) => s.stage === "intake")) return null;
  const parsed = parseProjectPolicy(row.raw);
  if (!parsed.ok) return null;
  const policy = parsed.policy;
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
    stages,
    row.status as ItemEnd,
  );
}

/** Hourly: verdicts past 90 days, a bounded batch, oldest first. */
export async function pruneReconcileShadow(env: Env, now: Date): Promise<void> {
  await env.DB.prepare(
    "DELETE FROM core_reconcile_items WHERE work_item_id IN (SELECT work_item_id FROM core_reconcile_items WHERE finished_at < ? ORDER BY finished_at LIMIT 1000)",
  )
    .bind(new Date(now.getTime() - VERDICT_KEEP_MS).toISOString())
    .run();
}
