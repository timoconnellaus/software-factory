import { defineConfig } from "vitest/config";

// Node, not workerd: runner-local drives git and tmux on the runner host.
// The container and stream tests spawn real processes: on a loaded machine (load average ~30) the
// 5 s default timed out (PR #73), so they get 30 s, as runner-host's do.
export default defineConfig({ test: { include: ["test/**/*.test.ts"], testTimeout: 30_000 } });
