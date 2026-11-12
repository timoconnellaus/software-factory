// The pull (ADR 0491): `queue.pull` by the scheduler, after a release, create-and-release, finish or
// cancel commits (the outbox), and from the minute cron. Always its own batch: a pull that loses a
// race aborts itself, never the call that asked for it, and the next pull picks up.
import { invoke, isOperationError, SCHEDULER } from "@software-factory/core";
import { invokeDeps } from "./deps.ts";

/** Pulls one project. Never throws an operation's refusal: the cron catches up. */
export async function pullProject(env: Env, projectId: string): Promise<string[]> {
  // A floor that sends the scheduler's writes to review would open one approval per pull: while
  // one is pending, don't ask again.
  const pending = await env.DB.prepare(
    "SELECT 1 FROM core_pending_actions WHERE operation = 'queue.pull' AND project_id = ? AND status = 'pending' LIMIT 1",
  )
    .bind(projectId)
    .first();
  if (pending) return [];
  try {
    const result = await invoke<{ started: string[] }>(
      invokeDeps(env),
      "queue.pull",
      { projectId },
      { actor: SCHEDULER, origin: { surface: "cron" } },
    );
    return result.status === "ok" ? result.output.started : [];
  } catch (error) {
    if (!isOperationError(error)) throw error;
    console.warn(`pull ${projectId}: ${error.code} ${error.message}`);
    return [];
  }
}

/**
 * The cron's pass: the projects where something could start now (a queued item with its waits-for
 * done, under the config's active limit), oldest released work first, so no project starves and a
 * project with nothing to start costs no call and no audit row.
 */
export async function pullQueuedWork(env: Env, limit = 20): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT w.project_id, MIN(w.released_at) AS oldest FROM core_work_items w
     JOIN core_projects p ON p.id = w.project_id
     LEFT JOIN core_project_policies pp ON pp.project_id = p.id AND pp.sha = p.policy_sha
     WHERE w.status = 'queued'
       AND NOT EXISTS (
         SELECT 1 FROM core_work_item_links l JOIN core_work_items t ON t.id = l.waits_for_id
         WHERE l.work_item_id = w.id AND t.status != 'done')
       AND (SELECT count(*) FROM core_work_items a
            WHERE a.project_id = w.project_id AND a.status IN ('running', 'waiting', 'paused'))
           < COALESCE(json_extract(CASE WHEN json_valid(pp.raw) THEN pp.raw END, '$.activeLimit'), 10)
       -- Never a project the pull would refuse anyway, so it can't hold a slot of the LIMIT:
       -- a kill switch on it or its org,
       AND NOT EXISTS (
         SELECT 1 FROM core_kill_switches k WHERE k.is_on = 1
         AND ((k.scope = 'project' AND k.scope_id = p.id) OR (k.scope = 'org' AND k.scope_id = p.org_id)))
       -- a config that defines workflows but names none (ADR 0492),
       AND NOT (COALESCE(json_array_length(CASE WHEN json_valid(pp.raw) THEN pp.raw END, '$.workflows'), 0) > 0
                AND json_extract(CASE WHEN json_valid(pp.raw) THEN pp.raw END, '$.workflow') IS NULL)
       -- or a pull approval still pending (a floor that reviews the scheduler).
       AND NOT EXISTS (
         SELECT 1 FROM core_pending_actions x
         WHERE x.operation = 'queue.pull' AND x.project_id = p.id AND x.status = 'pending')
     GROUP BY w.project_id ORDER BY oldest LIMIT ?`,
  )
    .bind(limit)
    .all<{ project_id: string }>();
  for (const { project_id } of results) await pullProject(env, project_id);
  return results.length;
}
