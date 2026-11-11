import { defineConfig } from "vitest/config";

// Node, not workerd: runner-orca drives the `orca` CLI on the runner host.
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
