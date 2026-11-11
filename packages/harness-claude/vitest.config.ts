import { defineConfig } from "vitest/config";

// Node, not workerd: the harness writes files and runs on the runner host.
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
