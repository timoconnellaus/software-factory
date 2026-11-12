import { defineConfig } from "vitest/config";

// Node, not workerd: this package runs outside Cloudflare.
// The tests drive real git: under a whole-repo parallel run on a loaded machine the 5 s default
// timed out (verify of work item #8), so they get 30 s.
export default defineConfig({ test: { include: ["test/**/*.test.ts"], testTimeout: 30_000 } });
