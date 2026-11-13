import { readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineWorkersTestConfig } from "@software-factory/config/vitest";

export default defineWorkersTestConfig({
  workers: {
    wrangler: { configPath: "./wrangler.jsonc" },
    miniflare: {
      d1Databases: ["MIGRATION_DB"],
      bindings: {
        TEST_MIGRATIONS: await readD1Migrations("../../packages/db/migrations"),
        GITHUB_FAKE: "1",
        RUNNER_CHANNEL_SECRET: "test-channel-secret",
        GH_APP_PRIVATE_KEY: "",
        GH_APP_WEBHOOK_SECRET: "test-webhook-secret",
        FACTORY_FLOOR: "",
        // Production's floor (wrangler.jsonc) is not the tests': each test that needs one sets it.
        DESKTOP_MIN_PROTOCOL: "",
        // The test app's signing certificate (test/attestation.ts), trusted only here.
        MOBILE_SIGNING_CERTS:
          "5E:5E:5E:5E:5E:5E:5E:5E:5E:5E:5E:5E:5E:5E:5E:5E:5E:5E:5E:5E:5E:5E:5E:5E:5E:5E:5E:5E:5E:5E:5E:5E",
      },
    },
  },
  setupFiles: ["./test/apply-migrations.ts"],
});
