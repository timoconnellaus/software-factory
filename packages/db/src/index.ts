// @software-factory/db: the core_* schema (SQL migrations in ../migrations) and typed access to it
// through Kysely over a D1 binding (ADR 0050).
import { type Compilable, type InferResult, Kysely } from "kysely";
import { D1Dialect } from "./dialect.ts";
import type { CoreDatabase } from "./schema.ts";

export { D1Dialect } from "./dialect.ts";
export type * from "./schema.ts";

/** Every core table and index is prefixed `core_`. */
export const CORE_TABLE_PREFIX = "core_";

/**
 * The highest migration number on this branch. Parallel builds use number blocks
 * (docs/parallel-work.md); when merging main, keep the larger value.
 */
export const SCHEMA_VERSION = 242;

/** Path of the migrations folder, relative to this package's root. */
export const MIGRATIONS_DIR = "migrations";

export type Db = Kysely<CoreDatabase>;

/** Typed Kysely access to the core tables. D1 has no interactive transactions: see `toStatement`. */
export function createDb(d1: D1Database): Db {
  return new Kysely<CoreDatabase>({ dialect: new D1Dialect(d1) });
}

/**
 * Compiles a Kysely query into a D1 prepared statement, so it can go into `D1Database.batch()`
 * (the only way to write atomically on D1).
 */
export function toStatement(d1: D1Database, query: Compilable): D1PreparedStatement {
  const { sql, parameters } = query.compile();
  return d1.prepare(sql).bind(...parameters);
}

/**
 * Several independent reads in one D1 request (ADR 0241): each query's rows, in order. Concurrent
 * D1 requests queue behind each other, so one batch beats the same queries in `Promise.all`.
 */
export async function readBatch<const Q extends readonly Compilable<unknown>[]>(
  d1: D1Database,
  queries: Q,
): Promise<{ -readonly [K in keyof Q]: InferResult<Q[K]> }> {
  if (queries.length === 0) return [] as { -readonly [K in keyof Q]: InferResult<Q[K]> };
  const results = await d1.batch(queries.map((q) => toStatement(d1, q)));
  return results.map((r) => r.results) as { -readonly [K in keyof Q]: InferResult<Q[K]> };
}

/**
 * A batch guard (ADR 0050): aborts the whole batch unless the previous statement changed at least
 * one row. Put it right after a conditional UPDATE/INSERT. Name it for the error message.
 */
export function guardChanged(d1: D1Database, name: string): D1PreparedStatement {
  return d1.prepare("INSERT INTO core_batch_guard (name, ok) VALUES (?, changes())").bind(name);
}

/** A batch guard that aborts the batch unless `query` (a SELECT) returns a row. */
export function guardExists(d1: D1Database, name: string, query: Compilable): D1PreparedStatement {
  const { sql, parameters } = query.compile();
  return d1
    .prepare(`INSERT INTO core_batch_guard (name, ok) SELECT ?, EXISTS (${sql})`)
    .bind(name, ...parameters);
}

/** The statement every guarded batch ends with, so no guard row survives the batch. */
export function clearGuards(d1: D1Database): D1PreparedStatement {
  return d1.prepare("DELETE FROM core_batch_guard");
}

/** Whether a D1 error came from a failed batch guard; returns the guard's name if so. */
export function failedGuard(error: unknown): string | null {
  const text = String(error instanceof Error ? error.message : error);
  return /CHECK constraint failed: (core_batch_guard|ok > 0)/.test(text) ? "guard" : null;
}

export function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (text === null || text === undefined || text === "") return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
