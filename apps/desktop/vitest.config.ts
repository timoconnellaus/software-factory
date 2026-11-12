// The main process's pure logic runs on Node: deep links, PKCE, the door client, backoff.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"], environment: "node" },
});
