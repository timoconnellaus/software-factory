import { defineWorkersTestConfig } from "@software-factory/config/vitest";

export default defineWorkersTestConfig({
  workers: { wrangler: { configPath: "./wrangler.jsonc" } },
});
