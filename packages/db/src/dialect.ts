// A minimal Kysely dialect over a D1 binding. D1 has no interactive transactions, so this dialect
// rejects them instead of pretending; use `db.batch()` on the raw binding for atomic writes.
import {
  type CompiledQuery,
  type DatabaseConnection,
  type DatabaseIntrospector,
  type Dialect,
  type Driver,
  type Kysely,
  type QueryCompiler,
  type QueryResult,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
} from "kysely";

class D1Connection implements DatabaseConnection {
  constructor(private readonly db: D1Database) {}

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    const result = await this.db
      .prepare(compiledQuery.sql)
      .bind(...compiledQuery.parameters)
      .all<R>();
    if (result.error) throw new Error(String(result.error));
    const changes = result.meta.changes;
    return {
      rows: result.results ?? [],
      numAffectedRows: changes > 0 ? BigInt(changes) : undefined,
      insertId:
        result.meta.last_row_id === undefined || result.meta.last_row_id === null
          ? undefined
          : BigInt(result.meta.last_row_id),
    };
  }

  // biome-ignore lint/correctness/useYield: streaming is not supported by D1; this always throws.
  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error("D1 does not support streaming queries");
  }
}

class D1Driver implements Driver {
  readonly #connection: D1Connection;

  constructor(db: D1Database) {
    this.#connection = new D1Connection(db);
  }

  async init(): Promise<void> {}
  async acquireConnection(): Promise<DatabaseConnection> {
    return this.#connection;
  }
  async beginTransaction(): Promise<void> {
    throw new Error("D1 does not support interactive transactions; use D1Database.batch()");
  }
  async commitTransaction(): Promise<void> {
    throw new Error("D1 does not support interactive transactions");
  }
  async rollbackTransaction(): Promise<void> {
    throw new Error("D1 does not support interactive transactions");
  }
  async releaseConnection(): Promise<void> {}
  async destroy(): Promise<void> {}
}

export class D1Dialect implements Dialect {
  constructor(private readonly db: D1Database) {}

  createAdapter() {
    return new SqliteAdapter();
  }
  createDriver(): Driver {
    return new D1Driver(this.db);
  }
  createQueryCompiler(): QueryCompiler {
    return new SqliteQueryCompiler();
  }
  // biome-ignore lint/suspicious/noExplicitAny: Kysely's introspector is typed against Kysely<any>.
  createIntrospector(db: Kysely<any>): DatabaseIntrospector {
    return new SqliteIntrospector(db);
  }
}
