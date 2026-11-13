// The sandbox runtime's own helpers (Linux runs `vendor/seccomp/<arch>/apply-seccomp` inside the
// sandbox): read-only for the check, wherever the runner's checkout keeps them (under the home).
//
// Its own module because it is the runner's one `import.meta.resolve`: SF Runner.app's sealed
// scripts may load nothing from outside the bundle (spec 45 §1), so its build replaces this module
// with `null` (apps/desktop/scripts/bundle-runner.mjs). That bundle runs only on macOS, where the
// sandbox runtime needs no vendored helper.
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SRT_VENDOR: string | null = (() => {
  try {
    const entry = realpathSync(fileURLToPath(import.meta.resolve("@anthropic-ai/sandbox-runtime")));
    return join(dirname(dirname(entry)), "vendor");
  } catch {
    return null;
  }
})();
