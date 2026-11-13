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

/** Where a workspace package's source lives, by its name. */
const PACKAGE_DIRS: Record<string, string> = {
  "runner-host": "local/runner-host",
  engine: "apps/engine",
};
const dirOf = (name: string) => PACKAGE_DIRS[name] ?? `packages/${name}`;

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
  const m = /^@software-factory\/([a-z-]+)(?:\/(.+))?$/.exec(spec);
  if (!m) return null; // a third-party module
  const dir = dirOf(m[1] as string);
  const sub = m[2];
  for (const p of sub
    ? [`${dir}/src/${sub}/index.ts`, `${dir}/src/${sub}.ts`, `${dir}/src/index.ts`]
    : [`${dir}/src/index.ts`])
    if (byPath.has(p)) return p;
  return null;
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
