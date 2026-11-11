import { defineConfig } from "vitest/config";

// Node, not workerd: this package runs outside Cloudflare.
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
