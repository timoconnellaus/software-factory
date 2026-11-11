import { fileURLToPath } from "node:url";
import { readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineWorkersTestConfig } from "@software-factory/config/vitest";
import { mergeConfig } from "vitest/config";

// A stand-in sf-engine so the ENGINE binding resolves. Tests pass their own recording engine to
// the server code; the real EngineApi is tested in apps/engine and packages/core.
const ENGINE_STUB = `
import { WorkerEntrypoint } from "cloudflare:workers";
export class EngineApi extends WorkerEntrypoint {
  async invoke() { return { ok: false, error: { code: "unavailable", message: "stub" } }; }
}
export default { fetch() { return new Response("stub"); } };`;

export default mergeConfig(
  defineWorkersTestConfig({
    include: ["test/**/*.test.{ts,tsx}"],
    workers: {
      // Bindings and vars from wrangler.jsonc; main is a plain test Worker: these tests exercise
      // src/server/* and src/lib/* directly, not TanStack Start's entry.
      wrangler: { configPath: "./wrangler.jsonc" },
      main: "./test/worker.ts",
      miniflare: {
        // Attachment tests run the real operations against a real R2 binding (ADR 0260).
        r2Buckets: ["ATTACHMENTS"],
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("../../packages/db/migrations"),
          BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-123",
          GH_APP_CLIENT_SECRET: "test-client-secret",
        },
        workers: [
          {
            name: "sf-engine",
            modules: true,
            script: ENGINE_STUB,
            compatibilityDate: "2026-10-01",
          },
        ],
      },
    },
    setupFiles: ["./test/apply-migrations.ts"],
  }),
  { resolve: { alias: { "#": fileURLToPath(new URL("./src", import.meta.url)) } } },
);
