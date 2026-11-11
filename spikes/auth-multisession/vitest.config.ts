import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const migrationsDir = fileURLToPath(new URL("./migrations", import.meta.url));

// Tests run inside workerd against a real (local) D1, like the CRM's packages.
export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: "2026-10-01",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["DB"],
        bindings: { TEST_MIGRATIONS: await readD1Migrations(migrationsDir) },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/apply-migrations.ts"],
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
