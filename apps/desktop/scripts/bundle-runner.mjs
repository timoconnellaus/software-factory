// Bundles sf-runner (local/runner-host) for the bundled Node:
//
// - `vendor/sf-runner.mjs`, one ESM file the app's in-app runner runs today (spec 40 M2). It goes
//   with the app's `runner/` copy in spec 45's last build PR.
// - `vendor/runner-bundle/*.cjs`, the sealed scripts of SF Runner.app (spec 45 §1): the guard and
//   self-test (`service.cjs`), the runner (`sf-runner.cjs`) and the check child
//   (`check-sandbox-child.cjs`, the sandbox runtime bundled in). Each is one self-contained
//   CommonJS file that loads nothing but `node:` built-ins, because Node resolves any other
//   specifier through `node_modules` folders above the bundle that the seal doesn't cover, and
//   because the launcher hands each to Node on a pipe (`/dev/fd/4`), from which Node reads an ES
//   module's source twice and gets nothing the second time. The build fails on anything else.
import { mkdirSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
const host = join(desktop, "..", "..", "local", "runner-host", "src");

/** The sealed scripts: published name → entry point. */
export const SEALED = {
  "service.cjs": join(host, "service-guard.ts"),
  "sf-runner.cjs": join(host, "cli.ts"),
  "check-sandbox-child.cjs": join(host, "check-sandbox-child.mjs"),
};

/**
 * `import.meta.url` and `.filename` in a sealed script: the script's own path inside the bundle (the launcher sets
 * SF_RUNNER_BUNDLE), as it would be read from disk. Lookups of files beside it keep working.
 */
const metaBanner = (name) =>
  [
    `var __sf_import_meta_filename = require("node:path").join(process.env.SF_RUNNER_BUNDLE ?? __dirname, "Contents", "Resources", "runner", ${JSON.stringify(name)});`,
    `var __sf_import_meta_url = require("node:url").pathToFileURL(__sf_import_meta_filename).href;`,
  ].join("\n");

const builtins = new Set(builtinModules.filter((m) => !m.startsWith("_")));

/** Rewrites every built-in to its `node:` form, stubs the one module that resolves a package. */
const sealPlugin = {
  name: "seal",
  setup(b) {
    b.onResolve({ filter: /.*/ }, (args) => {
      const bare = args.path.replace(/^node:/, "");
      if (builtins.has(bare) || builtins.has(bare.split("/")[0]))
        return { path: `node:${bare}`, external: true };
      return undefined;
    });
    b.onLoad({ filter: /[\\/]srt-vendor\.ts$/ }, () => ({
      contents: "export const SRT_VENDOR = null;",
      loader: "ts",
    }));
  },
};

/** Why a sealed build isn't self-contained, or [] when it is. Exported for the tests. */
export function sealProblems(result, outputs) {
  const problems = [];
  for (const [name, input] of Object.entries(result.metafile.inputs)) {
    if (name.endsWith(".node")) problems.push(`a native addon: ${name}`);
    for (const im of input.imports)
      if (im.external && !im.path.startsWith("node:"))
        problems.push(`${name} imports ${im.path} from outside the bundle`);
  }
  for (const w of result.warnings) problems.push(`esbuild: ${w.text} (${w.location?.file ?? "?"})`);
  for (const [file, text] of Object.entries(outputs)) {
    if (/\bcreateRequire\b/.test(text)) problems.push(`${file} uses createRequire`);
    if (/import\.meta\.resolve|import_meta\.resolve/.test(text))
      problems.push(`${file} uses import.meta.resolve`);
    // esbuild turns a bundled dynamic import into a require; one left over (outside a comment)
    // would load from outside the bundle.
    if (/^(?!\s*(\/\/|\*)).*\bimport\(/m.test(text))
      problems.push(`${file} has a dynamic import()`);
    // Every require esbuild leaves is of a `node:` literal; anything else would search node_modules.
    for (const m of text.matchAll(/\brequire\(\s*([^)]{0,80})/g))
      if (!/^["']node:[a-z_/]+["']\s*$/.test(m[1]))
        problems.push(`${file} has require(${m[1].slice(0, 40)}…)`);
  }
  return problems;
}

/** Builds one sealed script in memory: its files and why it isn't self-contained ([] when it is). */
export async function sealedBuild(entry, name, outdir) {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    target: "node24",
    format: "cjs",
    outfile: join(outdir, name),
    metafile: true,
    write: false,
    banner: { js: metaBanner(name) },
    define: {
      "import.meta.url": "__sf_import_meta_url",
      "import.meta.filename": "__sf_import_meta_filename",
    },
    plugins: [sealPlugin],
    logLevel: "silent",
  });
  const outputs = Object.fromEntries(result.outputFiles.map((f) => [f.path, f.text]));
  return { files: result.outputFiles, problems: sealProblems(result, outputs) };
}

export async function buildSealed(outdir = join(desktop, "vendor", "runner-bundle")) {
  const all = [];
  const files = [];
  for (const [name, entry] of Object.entries(SEALED)) {
    const built = await sealedBuild(entry, name, outdir);
    all.push(...built.problems.map((p) => `${name}: ${p}`));
    files.push(...built.files);
  }
  if (all.length)
    throw new Error(`the sealed scripts aren't self-contained:\n  ${all.join("\n  ")}`);
  mkdirSync(outdir, { recursive: true });
  for (const f of files) writeFileSync(f.path, f.contents);
  console.log(`bundle-runner: ${Object.keys(SEALED).join(", ")} -> ${outdir}`);
}

async function buildApp() {
  await build({
    entryPoints: [join(host, "cli.ts")],
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    outfile: join(desktop, "vendor", "sf-runner.mjs"),
    banner: {
      js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
    },
    logLevel: "info",
  });
}

// `--sealed` builds SF Runner.app's scripts only (CI's launcher job and the release's prototype
// step); without it, the app's runner as today.
if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes("--sealed")) await buildSealed();
  else await buildApp();
}
