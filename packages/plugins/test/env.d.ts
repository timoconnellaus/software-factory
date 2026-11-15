import type { D1Migration } from "cloudflare:test";

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      LOADER: WorkerLoader;
      FLOW_GATEWAY_KEY: string;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
