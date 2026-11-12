// After a host crash, and for `sf-runner doctor`: sprite jobs the host no longer runs (ADR 0460).
// A sprite's name starts with this runner's prefix (`sf-<runner>-`), so only its own are touched,
// never the owner's other sprites or another host's; its host dir is `<spritesDir>/sf-<jobId>`.
// A sprite is reaped when no live job has its name. Host dirs go with plain file operations.
import { readdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { removeRunDir } from "@software-factory/harness-claude";
import { isUnder } from "../checkouts.ts";
import { jobIdOfSession } from "../tmux.ts";
import { spriteName } from "./adapter.ts";
import type { SandboxApi } from "./api.ts";

export interface SpriteHostDirs {
  spritesDir: string;
  runsDir: string;
  /** This runner's sandbox name prefix. */
  namePrefix: string;
  api: SandboxApi;
}

export interface SpriteLeftovers {
  sprites: string[];
  dirs: Array<{ path: string; jobId: string }>;
}

export async function spriteLeftovers(
  dirs: SpriteHostDirs,
  running: Set<string>,
): Promise<SpriteLeftovers> {
  const live = new Set([...running].map((id) => spriteName(dirs.namePrefix, id)));
  const sprites = (await dirs.api.list(dirs.namePrefix))
    .map((s) => s.name)
    .filter((name) => name.startsWith(dirs.namePrefix) && !live.has(name));
  const out: SpriteLeftovers = { sprites, dirs: [] };
  const root = await realpath(dirs.spritesDir).catch(() => null);
  if (root) {
    for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
      const jobId = entry.isDirectory() ? jobIdOfSession(entry.name) : null;
      if (jobId && !running.has(jobId)) out.dirs.push({ path: join(root, entry.name), jobId });
    }
  }
  return out;
}

/** Destroys this runner's sprites and removes job dirs that no live job accounts for. */
export async function reapSprites(dirs: SpriteHostDirs, running: Set<string>): Promise<string[]> {
  const found = await spriteLeftovers(dirs, running);
  const reaped: string[] = [];
  for (const name of found.sprites) {
    await dirs.api.destroy(name).catch(() => {});
    reaped.push(name);
  }
  const root = await realpath(dirs.spritesDir).catch(() => dirs.spritesDir);
  for (const d of found.dirs) {
    if (!isUnder(d.path, root)) continue;
    await rm(d.path, { recursive: true, force: true }).catch(() => {});
    await removeRunDir(join(dirs.runsDir, d.jobId)).catch(() => {});
    reaped.push(d.jobId);
  }
  return [...new Set(reaped)];
}

/** What `sf-runner doctor` reports. */
export async function diagnoseSprites(
  dirs: SpriteHostDirs,
  running: Set<string>,
): Promise<string[]> {
  const found = await spriteLeftovers(dirs, running);
  return [
    ...found.sprites.map((name) => `sprite ${name} has no live job`),
    ...found.dirs.map((d) => `job dir ${d.path} has no live job`),
  ];
}
