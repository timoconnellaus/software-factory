import { defineConfig } from "vitest/config";

// Node, not workerd: runner-local drives git and tmux on the runner host.
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
