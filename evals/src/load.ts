// Loading checks and regression cases from disk, and the repo files a check applies to (Node).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { type FactoryCheck, factoryCheckSchema, type SourceFile } from "./checks.ts";
import { type RegressionCase, regressionCaseSchema } from "./regressions.ts";

function jsonFiles(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => join(dir, f));
  } catch {
    return [];
  }
}

function parse<T>(file: string, schema: { parse(v: unknown): T }): T {
  try {
    return schema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch (error) {
    throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Every `<dir>/*.json` check, keyed by name; a file must be named after its check. */
export function loadChecks(dir: string): Map<string, FactoryCheck> {
  const out = new Map<string, FactoryCheck>();
  for (const file of jsonFiles(dir)) {
    const check = parse(file, factoryCheckSchema);
    if (!file.endsWith(`/${check.name}.json`))
      throw new Error(`${file}: must be named ${check.name}.json`);
    out.set(check.name, check);
  }
  return out;
}

export function loadRegressions(dir: string): RegressionCase[] {
  return jsonFiles(dir).map((file) => {
    const rc = parse(file, regressionCaseSchema);
    if (!file.endsWith(`/${rc.incident}.json`))
      throw new Error(`${file}: must be named ${rc.incident}.json`);
    return rc;
  });
}

const SKIP = new Set(["node_modules", ".git", ".turbo", ".wrangler", "dist", "coverage", "spikes"]);

/** The repo's text files (skipping build output, dependencies and spikes), relative paths. */
export function repoFiles(root: string, maxBytes = 512 * 1024): SourceFile[] {
  const out: SourceFile[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (SKIP.has(name)) continue;
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile() && st.size <= maxBytes) {
        out.push({ path: relative(root, full), content: readFileSync(full, "utf8") });
      }
    }
  };
  walk(root);
  return out;
}
