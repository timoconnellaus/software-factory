// The factory's own code is excluded from auto-approval by directory (ADR 0515 §4, review of #152):
// every module reachable from the gate and verify entry points must be inside `SELF_MODIFY_PATHS`,
// so a change to anything that enforces policy always goes to a person.
import { describe, expect, it } from "vitest";
import { globMatch, SELF_MODIFY_PATHS } from "../src/index.ts";

// Vite's glob import (vitest transforms it); typed here, as core doesn't take vite's client types.
declare global {
  interface ImportMeta {
    glob(
      patterns: string[],
      options: { query: string; import: string; eager: true },
    ): Record<string, unknown>;
  }
}

// Every TypeScript source in the workspace's packages and apps, as text, keyed by repo path.
const sources = import.meta.glob(
  [
    "../../../packages/*/src/**/*.ts",
    "../../../apps/engine/src/**/*.ts",
    "../../../local/runner-host/src/**/*.ts",
    "../../../apps/desktop/src/bun/**/*.ts",
    "!**/*.test.ts",
    "!**/*.d.ts",
  ],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;
/** A glob key (relative to this test's folder) as a repository path. */
function repoPath(key: string): string {
  const parts = ["packages", "core", "test"];
  for (const seg of key.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  return parts.join("/");
}
const byPath = new Map(Object.entries(sources).map(([k, v]) => [repoPath(k), v] as const));

// Each workspace package's manifest and tsconfig, read for `exports` and `paths` (review of #152):
// a package's entry is what its `exports` says, never assumed to be src/index.ts.
const manifests = import.meta.glob(
  [
    "../../../packages/*/package.json",
    "../../../apps/*/package.json",
    "../../../local/*/package.json",
  ],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;
const tsconfigs = import.meta.glob(
  [
    "../../../packages/*/tsconfig.json",
    "../../../apps/*/tsconfig.json",
    "../../../local/*/tsconfig.json",
  ],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;
type Exports = string | Record<string, unknown> | undefined;
const packages = new Map<string, { dir: string; exports: Exports }>();
for (const [k, text] of Object.entries(manifests)) {
  const json = JSON.parse(text) as { name?: string; exports?: Exports; main?: string };
  if (!json.name) continue;
  const dir = repoPath(k).replace(/\/package\.json$/, "");
  packages.set(json.name, { dir, exports: json.exports ?? json.main });
}
/** `paths` mappings from every tsconfig: alias prefix → target directories (comments stripped). */
const paths: { prefix: string; dir: string; targets: string[] }[] = [];
for (const [k, text] of Object.entries(tsconfigs)) {
  let json: { compilerOptions?: { paths?: Record<string, string[]>; baseUrl?: string } };
  try {
    json = JSON.parse(text.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1"));
  } catch {
    continue;
  }
  const dir = repoPath(k).replace(/\/tsconfig\.json$/, "");
  for (const [alias, targets] of Object.entries(json.compilerOptions?.paths ?? {}))
    paths.push({
      prefix: alias.replace(/\*$/, ""),
      dir,
      targets: targets.map((t) => t.replace(/\*$/, "")),
    });
}
const target = (e: unknown): string | null =>
  typeof e === "string"
    ? e
    : e && typeof e === "object"
      ? target((e as Record<string, unknown>).import ?? (e as Record<string, unknown>).default)
      : null;
function exported(dir: string, exports: Exports, sub: string | undefined): string | null {
  const key = sub ? `./${sub}` : ".";
  const t =
    typeof exports === "string" && !sub
      ? exports
      : target((exports as Record<string, unknown>)?.[key]);
  return t ? `${dir}/${t.replace(/^\.\//, "")}` : null;
}

function resolve(from: string, spec: string): string | null {
  if (spec.startsWith(".")) {
    const parts = from.split("/").slice(0, -1);
    for (const seg of spec.split("/")) {
      if (seg === "..") parts.pop();
      else if (seg !== ".") parts.push(seg);
    }
    const path = parts.join("/");
    for (const p of [path, `${path}.ts`, `${path}/index.ts`]) if (byPath.has(p)) return p;
    return null;
  }
  for (const p of paths)
    if (spec.startsWith(p.prefix))
      for (const t of p.targets) {
        const base = resolve(`${p.dir}/x`, `./${t}${spec.slice(p.prefix.length)}`);
        if (base) return base;
      }
  const m = /^(@software-factory\/[a-z-]+)(?:\/(.+))?$/.exec(spec);
  if (!m) return null; // a third-party module
  const pkg = packages.get(m[1] as string);
  if (!pkg) throw new Error(`no workspace package ${m[1]}`);
  const entry = exported(pkg.dir, pkg.exports, m[2]);
  if (!entry) throw new Error(`${m[1]} exports nothing at ${m[2] ?? "."}`);
  return entry;
}

const IMPORT =
  /(?:import|export)\s[^"']*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

describe("SELF_MODIFY_PATHS covers the code that enforces policy", () => {
  it("every module reachable from the gate and verify entry points is inside it", () => {
    const entries = [
      "packages/core/src/policy/gate.ts",
      "packages/core/src/invoke.ts",
      "packages/core/src/operations/gates.ts",
      "packages/core/src/operations/verify.ts",
      "packages/core/src/verify/packet.ts",
      "packages/core/src/policy/auto-approve.ts",
      "apps/engine/src/index.ts",
      "apps/engine/src/workflow/work-item.ts",
      "apps/desktop/src/bun/index.ts",
    ];
    for (const e of entries) expect(byPath.has(e), e).toBe(true);
    const seen = new Set<string>();
    const queue = [...entries];
    while (queue.length) {
      const at = queue.pop() as string;
      if (seen.has(at)) continue;
      seen.add(at);
      const text = byPath.get(at) ?? "";
      for (const m of text.matchAll(IMPORT)) {
        const spec = (m[1] ?? m[2] ?? "").replace(/\?raw$/, "");
        const next = resolve(at, spec);
        if (next && !seen.has(next)) queue.push(next);
      }
    }
    expect(seen.size).toBeGreaterThan(50);
    const outside = [...seen].filter((p) => !SELF_MODIFY_PATHS.some((g) => globMatch(g, p)));
    expect(outside).toEqual([]);
  });
});
