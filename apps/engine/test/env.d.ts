import type { D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS: D1Migration[];
      /** An empty database for migration tests (spec 60: old desktop rows survive 0310). */
      MIGRATION_DB: D1Database;
    }
  }
}
