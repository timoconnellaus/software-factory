import { readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineWorkersTestConfig } from "@software-factory/config/vitest";

export default defineWorkersTestConfig({
  workers: {
    wrangler: { configPath: "./wrangler.jsonc" },
    miniflare: {
      bindings: {
        TEST_MIGRATIONS: await readD1Migrations("../../packages/db/migrations"),
        GITHUB_FAKE: "1",
        RUNNER_CHANNEL_SECRET: "test-channel-secret",
        GH_APP_PRIVATE_KEY: "",
        GH_APP_WEBHOOK_SECRET: "test-webhook-secret",
        FACTORY_FLOOR: "",
      },
    },
  },
  setupFiles: ["./test/apply-migrations.ts"],
});
