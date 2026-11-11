// Mechanical guard (ADR 0100): the contract is runner-agnostic. Nothing in src/contract imports
// outside it, uses Node APIs, or names a specific runner in code (comments may mention examples).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dir = join(import.meta.dirname, "../src/contract");
const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));

function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

describe("runner contract boundary", () => {
  it.each(files)("%s imports only from src/contract and no node: modules", (file) => {
    const source = readFileSync(join(dir, file), "utf8");
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    for (const spec of imports) expect(spec).toMatch(/^\.\/[\w-]+\.ts$/);
  });

  it.each(files)("%s names no runner (orca, local, sprites, codex) in code", (file) => {
    const body = code(readFileSync(join(dir, file), "utf8"));
    expect(body).not.toMatch(/orca|sprites|codex|claude -p|worktree/i);
  });

  it("the Orca and local adapters satisfy the same RunnerAdapter type", async () => {
    // Type-level: this file only compiles (pnpm typecheck) if both return RunnerAdapter.
    const { createOrcaRunner } = await import("../src/runner-orca/adapter.ts");
    const { createLocalRunner } = await import("../src/runner-local/adapter.ts");
    const adapters: Array<import("../src/contract/types.ts").RunnerAdapter> = [
      createOrcaRunner({ resolveRepoPath: () => "/tmp" }),
      createLocalRunner({ resolveRepoPath: () => "/tmp", worktreeRoot: "/tmp/x" }),
    ];
    const manifests = await Promise.all(adapters.map((a) => a.manifest()));
    expect(manifests.map((m) => m.runnerKind)).toEqual(["orca", "local"]);
  });
});
