// Bundles sf-runner (local/runner-host) into one ESM file for the bundled Node to run.
import { build } from "esbuild";

await build({
  entryPoints: ["../../local/runner-host/src/cli.ts"],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  outfile: "vendor/sf-runner.mjs",
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: "info",
});
