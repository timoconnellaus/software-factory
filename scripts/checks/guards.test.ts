// Repo-wide guards that need the file system (workerd tests can't read it). Run with
// `node --test "scripts/*/*.test.ts"` (CI does).
//
// - Code asks for a model role or a Claude Code alias, never a model id (ADR 0018, spec 02
//   criterion 7): no source file names a model.
// - Runners are adapters (ADR 0014, spec 03 criterion 1): nothing in packages/core,
//   packages/runner-contract or apps/* imports Orca or a runner adapter (runner-local).
import { strict as assert } from "node:assert";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..", "..");
const SKIP = new Set(["node_modules", "dist", ".wrangler", ".turbo", "spikes", ".git", ".kim"]);

function sources(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.(ts|tsx|js|mjs|jsonc?)$/.test(name) && !name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

const MODEL_ID =
  /\b(claude-(?:opus|sonnet|haiku|fable)-[0-9][0-9a-z.-]*|gpt-[0-9][0-9a-z.-]*|gemini-[0-9][0-9a-z.-]*)\b/i;

test("no source file names a model id", () => {
  const offenders: string[] = [];
  for (const area of ["apps", "packages", "local"]) {
    for (const file of sources(join(root, area))) {
      const rel = relative(root, file);
      if (rel.includes("/test/")) continue;
      const match = readFileSync(file, "utf8").match(MODEL_ID);
      if (match) offenders.push(`${rel}: ${match[0]}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "use a model role or a Claude Code alias (packages/ops/src/models.ts), never a model id",
  );
});

test("core, the runner contract and the apps never import Orca or a runner adapter", () => {
  const offenders: string[] = [];
  const areas = ["packages/core", "packages/runner-contract", "packages/db", "apps"];
  const forbidden =
    /from\s+["'](?:@software-factory\/runner-(?!contract)[a-z-]+|[^"']*orca[^"']*)["']|import\(\s*["'][^"']*orca/i;
  for (const area of areas) {
    for (const file of sources(join(root, area))) {
      const text = readFileSync(file, "utf8");
      if (forbidden.test(text)) offenders.push(relative(root, file));
    }
  }
  assert.deepEqual(offenders, []);
});

// The new core stays in small modules (ADR 0660, spec 70 criteria 6 and 7): no source file in its
// packages is over 400 lines, and none of them imports the old core.
const NEW_CORE = ["flow", "ops", "store", "plugins", "plugin-editor", "gateways"];

test("no source file in the new core's packages is over 400 lines", () => {
  const offenders: string[] = [];
  for (const name of NEW_CORE) {
    for (const file of sources(join(root, "packages", name, "src"))) {
      const lines = readFileSync(file, "utf8").split("\n").length;
      if (lines > 400) offenders.push(`${relative(root, file)} (${lines} lines)`);
    }
  }
  assert.deepEqual(offenders, [], "split these files: the new core's limit is 400 lines");
});

test("the new core's packages don't import the old core", () => {
  const offenders: string[] = [];
  for (const name of NEW_CORE) {
    for (const file of sources(join(root, "packages", name))) {
      if (/@software-factory\/core\b/.test(readFileSync(file, "utf8"))) {
        offenders.push(relative(root, file));
      }
    }
  }
  assert.deepEqual(offenders, [], "the new core is built beside packages/core, not on it");
});
