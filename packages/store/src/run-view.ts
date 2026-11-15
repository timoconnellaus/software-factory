// The run view's run (spec 70, .kim/mockups/run.html): a run with its totals, what started it and
// the names around it, in one read. A run may have no item (a chat's), so every join is a left one.
import { RUN_EVENTS_KEEP_DAYS } from "./run-events.ts";
import { type Run, toRun } from "./runs.ts";
import type { FlowRunRow } from "./schema.ts";

/** A run as the run view shows it: its totals, what started it, and the names around it. */
export interface RunView extends Run {
  /** Null for a run on no item (a chat's). */
  itemTitle: string | null;
  /** A chat's run: the chat's title (null for an item's run). */
  chatTitle: string | null;
  itemNumber: number | null;
  projectId: string | null;
  projectKey: string | null;
  agentName: string | null;
  /** The status the run is for, by name in its project's workflow (null without an item). */
  statusName: string | null;
  /** "entering Build" for an item's run, "a message in the chat" for a chat's. */
  startedBy: string | null;
  /** Claimed to finished; null while it runs or if it was never claimed. */
  durationMs: number | null;
  runnerName: string | null;
  /** Events beyond RUN_EVENTS_CAP were dropped. */
  eventsTruncated: boolean;
  /** Its events were pruned (30 days after it finished); the totals remain. */
  eventsRemoved: boolean;
}

/**
 * One run for the run view, or null. One read: the run by primary key, and by primary key each of
 * its item, project, workflow, agent and runner (left joins: a run may have no item). The status's
 * name is picked out of the workflow's JSON in SQL.
 */
export async function runView(
  d1: D1Database,
  runId: string,
  now = Date.now(),
): Promise<RunView | null> {
  const row = await d1
    .prepare(
      `SELECT r.*, i.title AS item_title, i.number AS item_number, i.project_id AS project_id,
          p.key AS project_key, a.name AS agent_name, cr.name AS runner_name, c.title AS chat_title,
          (SELECT json_extract(s.value, '$.name') FROM json_each(w.definition, '$.statuses') AS s
            WHERE json_extract(s.value, '$.id') = r.status_id) AS status_name
        FROM flow_runs AS r
        LEFT JOIN flow_items AS i ON i.id = r.item_id
        LEFT JOIN flow_projects AS p ON p.id = i.project_id
        LEFT JOIN flow_workflows AS w ON w.id = p.workflow_id
        LEFT JOIN flow_agents AS a ON a.id = r.agent_id
        LEFT JOIN core_runners AS cr ON cr.id = r.runner_id
        LEFT JOIN flow_chats AS c ON c.id = r.chat_id
        WHERE r.id = ?`,
    )
    .bind(runId)
    .first<
      FlowRunRow & {
        item_title: string | null;
        item_number: number | null;
        project_id: string | null;
        project_key: string | null;
        agent_name: string | null;
        runner_name: string | null;
        status_name: string | null;
        chat_title: string | null;
      }
    >();
  if (!row) return null;
  const {
    item_title,
    item_number,
    project_id,
    project_key,
    agent_name,
    runner_name,
    status_name,
    chat_title,
    ...run
  } = row;
  const statusName = item_title === null ? null : (status_name ?? run.status_id);
  const claimed = run.claimed_at;
  const finished = run.finished_at;
  return {
    ...toRun(run),
    itemTitle: item_title,
    chatTitle: chat_title,
    itemNumber: item_number,
    projectId: project_id,
    projectKey: project_key,
    agentName: agent_name,
    statusName,
    startedBy:
      statusName !== null
        ? `entering ${statusName}`
        : run.chat_id !== null
          ? "a message in the chat"
          : null,
    durationMs:
      claimed && finished ? Math.max(0, Date.parse(finished) - Date.parse(claimed)) : null,
    runnerName: runner_name,
    eventsTruncated: run.events_truncated === 1,
    // The prune runs every minute: a run whose events were due and has none had them removed.
    eventsRemoved:
      run.event_count === 0 &&
      finished !== null &&
      Date.parse(finished) < now - RUN_EVENTS_KEEP_DAYS * 86_400_000,
  };
}
