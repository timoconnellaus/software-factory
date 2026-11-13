// The hot-path query-plan guard (AGENTS.md, "Cloudflare cost"): run a path through the real code with
// a D1 binding that records every statement, then `EXPLAIN QUERY PLAN` each one against the schema
// the migrations built. A SCAN of a table that grows is the failure: D1 bills every row it reads,
// and these paths run every minute, every heartbeat or every poll.

/** Tables sized by configuration, not by use: a SCAN of one of these is fine. Every other table grows. */
export const SMALL_TABLES = new Set([
  // One row per open item the babysitter resolved a conflict for; pruned hourly once it ends.
  "core_babysit_resolutions",
  "core_organization",
  "core_member",
  "core_user",
  "core_factories",
  "core_projects",
  "core_repositories",
  // One row per repository (spec 53): sized like core_repositories.
  "core_main_health",
  "core_github_installations",
  "core_runners",
  "core_kill_switches",
  "core_project_protection",
]);

export interface Recorded {
  sql: string;
  params: unknown[];
}

/** A D1 binding that records each statement it prepares (with its bound parameters). */
export function recordingD1(db: D1Database, seen: Recorded[]): D1Database {
  const prepare = (sql: string) => {
    const stmt = db.prepare(sql);
    const entry: Recorded = { sql, params: [] };
    seen.push(entry);
    const bind = stmt.bind.bind(stmt);
    stmt.bind = (...params: unknown[]) => {
      entry.params = params;
      return bind(...params);
    };
    return stmt;
  };
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") return prepare;
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** `{ ...env, DB }` with DB recording: bindings are own properties of the test env. */
export function recordingEnv(env: Env, seen: Recorded[]): Env {
  return { ...env, DB: recordingD1(env.DB, seen) };
}

/** Maps each name a statement reads a table under (its alias, or the table itself) to the table. */
function tableAliases(sql: string): Map<string, string> {
  const names = new Map<string, string>();
  const re =
    /\b(?:from|join|update|into)\s+"?(core_\w+)"?(?:\s+(?:as\s+)?"?(?!(?:on|where|join|left|inner|cross|set|values|group|order|limit|using|natural|indexed)\b)(\w+)"?)?/gi;
  for (const m of sql.matchAll(re)) {
    const table = m[1] as string;
    names.set(table, table);
    if (m[2]) names.set(m[2], table);
  }
  return names;
}

/**
 * Statements allowed a temp B-tree for their ORDER BY, each with why the rows it sorts are few. A
 * sort is fine when an index has already narrowed the rows to a bounded set; it is the failure when
 * the set grows with the table (every item of an org, sorted to take the newest 50).
 */
export const SORT_ALLOWED: { match: RegExp; why: string }[] = [
  {
    match:
      /from "core_work_items" where "repository_id" = \? and "head_sha" = \? order by "updated_at"/,
    why: "the items with one head SHA in one repository (core_work_items_repository_head_idx): one or two",
  },
  {
    match:
      /FROM core_merge_queue q JOIN core_work_items w ON w\.id = q\.work_item_id\s+WHERE q\.project_id = \?1 AND q\.status = 'queued'/,
    why: "the deliverer's head: one project's open queue entries (core_merge_queue_project_idx), a handful",
  },
  {
    match: /FROM core_outbox WHERE next_at <= \?/,
    why: "due outbox rows only (core_outbox_next_idx); a delivered row is deleted",
  },
  {
    match: /SELECT w\.project_id, MIN\(w\.released_at\) AS oldest/,
    why: "sorts one row per project with queued work (core_work_items_status_idx)",
  },
  {
    match: /from "core_pending_actions".*"core_pending_actions"\."status" = \?/,
    why: "pending gates only (core_pending_actions_status_idx)",
  },
  {
    match: /from "core_questions".*"core_questions"\."assignee_user_id" = \?/,
    why: "the caller's open questions only (core_questions_assignee_idx)",
  },
  {
    match:
      /from "core_work_items" where "org_id" in .* and "status" in \(\?, \?, \?\) order by "updated_at"/,
    why: "active items only (core_work_items_org_idx on org and status), capped by the active limit",
  },
  {
    match: /from "core_work_items" where .*"status" in .* order by \+updated_at/,
    why: "workItem.list with a status filter reads and sorts only that project's rows in those statuses (core_work_items_status_idx). Only the CLI's `sf list` filters by status, on demand, asking for the live statuses (bounded by the active limit); a status that grows (done) would sort them all, and nothing polls with a status",
  },
  {
    match: /^select \* from "core_questions" where "work_item_id" = \? order by "created_at"$/,
    why: "workItem.get: one item's questions (a few per planning round), by the item's index",
  },
  {
    match:
      /^select \* from "core_pending_actions" where "work_item_id" = \? order by "created_at"$/,
    why: "workItem.get: one item's gates (one per gate it reached), by the item's index",
  },
  {
    match:
      /from "core_merge_queue" as "q" inner join "core_work_items" as "w".*where "q"\."project_id" = \? and "w"\."repository_id" = \? and "q"\."status" = \?/,
    why: "workItem.get at the merge stage: one repository's queued merges (the merge queue's depth, a handful)",
  },
];

export interface Scan {
  sql: string;
  table: string;
  detail: string;
}

/**
 * EXPLAINs every recorded statement and returns each SCAN of a growing table, and each temp B-tree
 * for an ORDER BY in a statement that reads one (unless SORT_ALLOWED says why it is bounded). A SCAN
 * of a partial index (`… WHERE verdict IS NULL`) is allowed: it reads only the rows the index keeps.
 */
export async function growingScans(db: D1Database, seen: Recorded[]): Promise<Scan[]> {
  const partial = new Set(
    (
      await db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND sql LIKE '% WHERE %'")
        .all<{ name: string }>()
    ).results.map((r) => r.name),
  );
  const scans: Scan[] = [];
  const done = new Set<string>();
  for (const { sql, params } of seen) {
    if (done.has(sql) || /^\s*(explain|pragma|create|drop)\b/i.test(sql)) continue;
    done.add(sql);
    const { results } = await db
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .bind(...params)
      .all<{ detail: string }>();
    const aliases = tableAliases(sql);
    const growing = [...new Set(aliases.values())].filter((t) => !SMALL_TABLES.has(t));
    const sorted = results.some((r) => /^USE TEMP B-TREE FOR (?:[A-Z]+ )?ORDER BY/.test(r.detail));
    if (sorted && growing.length > 0 && !SORT_ALLOWED.some((a) => a.match.test(sql))) {
      scans.push({
        sql: sql.replace(/\s+/g, " ").trim(),
        table: growing.join(", "),
        detail: "USE TEMP B-TREE FOR ORDER BY",
      });
    }
    for (const { detail } of results) {
      const m = /^SCAN (\w+)(?: USING (?:COVERING )?INDEX (\w+))?/.exec(detail);
      if (!m || (m[2] && partial.has(m[2]))) continue;
      const table = aliases.get(m[1] as string) ?? (m[1] as string);
      if (!table.startsWith("core_") || SMALL_TABLES.has(table)) continue;
      scans.push({ sql: sql.replace(/\s+/g, " ").trim(), table, detail });
    }
  }
  return scans;
}
