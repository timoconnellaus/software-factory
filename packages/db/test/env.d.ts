import type { D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      /** An empty database a test migrates step by step (backfill tests). */
      UPGRADE_DB: D1Database;
      /** An empty database that gets main's migrations first, then this branch's (late-migrations). */
      LATE_DB: D1Database;
      /** An empty database a test migrates out of order (late blocks after everything else). */
      ORDER_DB: D1Database;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
