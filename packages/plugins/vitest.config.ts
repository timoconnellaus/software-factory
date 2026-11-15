import { readD1Migrations } from "@cloudflare/vitest-plugin";
import { COMPATIBILITY_DATE, defineWorkersTestConfig } from "@software-factory/config/vitest";

export default defineWorkersTestConfig({
  workers: {
    miniflare: {
      compatibilityDate: COMPATIBILITY_DATE,
      compatibilityFlags: ["nodejs_compat"],
      d1Databases: ["DB"],
      // The Worker Loader: plugins run as real Dynamic Workers in these tests.
      workerLoaders: { LOADER: {} },
      bindings: {
        TEST_MIGRATIONS: await readD1Migrations("../db/migrations"),
        FLOW_GATEWAY_KEY: "test-gateway-key",
      },
    },
  },
  setupFiles: ["./test/apply-migrations.ts"],
});
