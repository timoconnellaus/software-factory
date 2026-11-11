// Repo-wide guards that need the file system (workerd tests can't read it). Run with
// `node --test "scripts/*/*.test.ts"` (CI does).
//
// - Code asks for a model role, never a model id (ADR 0018, spec 02 criterion 7): no source file
//   outside the model-role registry names a model.
// - Runners are adapters (ADR 0014, spec 03 criterion 1): nothing in packages/core,
//   packages/runner-contract or apps/* imports Orca or runner-orca.
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

const MODEL_REGISTRY = "packages/core/src/model-roles.ts";
const MODEL_ID = /\b(claude-(?:opus|sonnet|haiku|fable)-[0-9][0-9a-z.-]*|gpt-[0-9][0-9a-z.-]*|gemini-[0-9][0-9a-z.-]*)\b/i;

test("no source file outside the model-role registry names a model id", () => {
  const offenders: string[] = [];
  for (const area of ["apps", "packages", "local"]) {
    for (const file of sources(join(root, area))) {
      const rel = relative(root, file);
      if (rel === MODEL_REGISTRY || rel.includes("/test/")) continue;
      const match = readFileSync(file, "utf8").match(MODEL_ID);
      if (match) offenders.push(`${rel}: ${match[0]}`);
    }
  }
  assert.deepEqual(offenders, [], "use a model role (packages/core/src/model-roles.ts)");
});

test("core, the runner contract and the apps never import Orca or a runner adapter", () => {
  const offenders: string[] = [];
  const areas = ["packages/core", "packages/runner-contract", "packages/db", "apps"];
  const forbidden = /from\s+["'](?:@software-factory\/runner-(?!contract)[a-z-]+|[^"']*orca[^"']*)["']|import\(\s*["'][^"']*orca/i;
  for (const area of areas) {
    for (const file of sources(join(root, area))) {
      const text = readFileSync(file, "utf8");
      if (forbidden.test(text)) offenders.push(relative(root, file));
    }
  }
  assert.deepEqual(offenders, []);
});
