import { readD1Migrations } from "@cloudflare/vitest-plugin";
import { COMPATIBILITY_DATE, defineWorkersTestConfig } from "@software-factory/config/vitest";

export default defineWorkersTestConfig({
  workers: {
    miniflare: {
      compatibilityDate: COMPATIBILITY_DATE,
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: ["DB"],
      r2Buckets: ["ATTACHMENTS"],
      bindings: { TEST_MIGRATIONS: await readD1Migrations("../db/migrations") },
    },
  },
  setupFiles: ["./test/apply-migrations.ts"],
});
