// The hot-path query-plan guard (AGENTS.md, "Cloudflare cost"): run a path through the real code with
// a D1 binding that records every statement, then `EXPLAIN QUERY PLAN` each one against the schema
// the migrations built. A SCAN of a table that grows is the failure: D1 bills every row it reads,
// and these paths run every minute, every heartbeat or every poll.

/** Tables sized by configuration, not by use: a SCAN of one of these is fine. Every other table grows. */
export const SMALL_TABLES = new Set([
  "core_organization",
  "core_member",
  "core_user",
  "core_factories",
  "core_projects",
  "core_repositories",
  "core_github_installations",
  "core_runners",
  "core_kill_switches",
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
    /\b(?:from|join|update|into)\s+"?(core_\w+)"?(?:\s+(?:as\s+)?"?(?!(?:on|where|join|left|inner|cross|set|values|group|order|limit|using|natural)\b)(\w+)"?)?/gi;
  for (const m of sql.matchAll(re)) {
    const table = m[1] as string;
    names.set(table, table);
    if (m[2]) names.set(m[2], table);
  }
  return names;
}

export interface Scan {
  sql: string;
  table: string;
  detail: string;
}

/**
 * EXPLAINs every recorded statement and returns each SCAN of a growing table. A SCAN of a partial
 * index (`… WHERE verdict IS NULL`) is allowed: it reads only the rows the index keeps.
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
