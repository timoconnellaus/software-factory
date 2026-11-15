// The result is read only as a regular file in the worktree: a symlink the agent left there (to a
// key, a config) is refused and never followed.
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RESULT_FILE } from "@software-factory/runner-contract";
import { afterEach, describe, expect, it } from "vitest";
import { readResultFile } from "../src/job.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

describe("the result file", () => {
  it("is read when it is a regular file in the worktree, refused when a symlink or elsewhere", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "sf-result-")));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const work = join(root, "work");
    await mkdir(work);
    const secret = join(root, "secret.json");
    await writeFile(secret, '{"key":"the owner\'s"}');
    const notes: string[] = [];
    const path = join(work, RESULT_FILE);
    expect(await readResultFile(work, path, notes)).toBeNull();
    await writeFile(path, '{"notes":"ok"}');
    expect(await readResultFile(work, path, notes)).toBe('{"notes":"ok"}');
    await rm(path);
    await symlink(secret, path);
    expect(await readResultFile(work, path, notes)).toBeNull();
    expect(notes.at(-1)).toMatch(/not a regular file in the worktree/);
    await rm(path);
    await mkdir(path);
    expect(await readResultFile(work, path, notes)).toBeNull();
  });
});
