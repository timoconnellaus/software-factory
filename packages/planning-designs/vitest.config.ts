import { defineConfig } from "vitest/config";

// Node, not workerd: the checks run on the runner host, where the harness's MCP server calls them.
export default defineConfig({ test: { include: ["test/**/*.test.ts"], testTimeout: 30_000 } });
