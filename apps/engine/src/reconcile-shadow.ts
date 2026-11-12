// The reconciler in shadow (spec 52 PR (c), ADR 0511 §7). The Workflow's `workItem.enterStage`
// emits `reconcile.shadow`; this rebuilds the item's stage history as it was just before that
// transition, asks the reconciler what it would have done, and records both. It drives nothing.
//
// Cost (D1 bills rows scanned): one batch of three point or per-item indexed reads (the item by
// primary key with its pinned policy by primary key, its stage rows by core_stages_item_idx with a
// LIMIT), and one batch of writes (one row per transition, idempotent by id; at Done, the item's
// verdict from its own rows by core_reconcile_shadow_item_idx). Once per Workflow transition, never
// per poll. Pruning: `pruneReconcileShadow`, hourly from the minute cron.

import { type OutboxMessage, parseProjectPolicy } from "@software-factory/core";
import {
  compileItemWorkflow,
  type ObservedTransition,
  SIZE_RANK,
  type Size,
  type StageRow,
  shadowCompare,
} from "@software-factory/core/stages";

type Payload = Extract<OutboxMessage, { kind: "reconcile.shadow" }>["payload"];

interface ItemRow {
  id: string;
  org_id: string;
  kind: "change" | "incident" | "attached";
  size: Size | null;
  domains: string | null;
  spec_required: number | null;
  workflow: string | null;
  pulled_at: string | null;
  raw: string | null;
}

/** Shadow rows and verdicts are kept this long (they measure the reconciler before the switch-over). */
export const SHADOW_KEEP_MS = 30 * 24 * 3_600_000;
export const VERDICT_KEEP_MS = 90 * 24 * 3_600_000;

export async function recordShadow(env: Env, payload: Payload): Promise<void> {
  const [item, stages] = await env.DB.batch([
    env.DB.prepare(
      `SELECT w.id, w.org_id, w.kind, w.size, w.domains, w.spec_required, w.workflow, w.pulled_at, p.raw
       FROM core_work_items w
       LEFT JOIN core_project_policies p ON p.project_id = w.project_id
         AND p.sha = COALESCE(w.policy_sha, (SELECT policy_sha FROM core_projects WHERE id = w.project_id))
       WHERE w.id = ?`,
    ).bind(payload.workItemId),
    env.DB.prepare(
      "SELECT stage, status FROM core_stages WHERE work_item_id = ? AND started_at < ? ORDER BY started_at, rowid LIMIT 500",
    ).bind(payload.workItemId, payload.at),
  ]);
  const row = (item?.results as ItemRow[] | undefined)?.[0];
  if (!row?.raw) return; // no pinned config to compile: nothing to compare against
  const parsed = parseProjectPolicy(row.raw);
  if (!parsed.ok) return;
  const policy = parsed.policy;
  let definition: ReturnType<typeof compileItemWorkflow>;
  try {
    definition = compileItemWorkflow(policy, row.workflow, row.kind);
  } catch {
    return; // a slot workflow that doesn't compile (spec 52 PR (a)): not comparable
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
  const comparisons = shadowCompare(
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
    (stages?.results ?? []) as StageRow[],
    payload.observed as ObservedTransition[],
  );
  const writes = comparisons.map((c, i) =>
    env.DB.prepare(
      "INSERT OR IGNORE INTO core_reconcile_shadow (id, work_item_id, org_id, seq, observed, predicted, agrees, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      `${row.id}:${payload.at}:${i}`,
      row.id,
      row.org_id,
      i,
      c.observed,
      c.predicted,
      c.agrees ? 1 : 0,
      payload.at,
    ),
  );
  if (payload.observed.some((t) => t.kind === "enter" && t.stage === "done")) {
    // The item's verdict, from its own rows (indexed by item; tens of rows).
    writes.push(
      env.DB.prepare(
        `INSERT OR REPLACE INTO core_reconcile_items (work_item_id, org_id, transitions, divergences, finished_at)
         SELECT ?, ?, COUNT(*), COALESCE(SUM(1 - agrees), 0), ? FROM core_reconcile_shadow WHERE work_item_id = ?`,
      ).bind(row.id, row.org_id, payload.at, row.id),
    );
  }
  if (writes.length) await env.DB.batch(writes);
}

/** Hourly: shadow rows past 30 days and verdicts past 90, a bounded batch each, oldest first. */
export async function pruneReconcileShadow(env: Env, now: Date): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM core_reconcile_shadow WHERE id IN (SELECT id FROM core_reconcile_shadow WHERE created_at < ? ORDER BY created_at LIMIT 1000)",
    ).bind(new Date(now.getTime() - SHADOW_KEEP_MS).toISOString()),
    env.DB.prepare(
      "DELETE FROM core_reconcile_items WHERE work_item_id IN (SELECT work_item_id FROM core_reconcile_items WHERE finished_at < ? ORDER BY finished_at LIMIT 1000)",
    ).bind(new Date(now.getTime() - VERDICT_KEEP_MS).toISOString()),
  ]);
}
