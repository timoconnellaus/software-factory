// After a host crash, periodically while the host runs, and for `sf-runner doctor`: sprite jobs the
// host no longer runs (ADR 0480). A sprite's name starts with this runner's prefix (`sf-<runner>-`),
// so only its own are touched, never the owner's other sprites or another host's; its host dir is
// `<spritesDir>/sf-<jobId>`. A sprite is reaped when no live job has its name, or when it is older
// than the most a sprite may live (whatever holds it). Host dirs go with plain file operations.
// Failures are not swallowed: a sprite that couldn't be destroyed may still be billed.
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
  /** A sprite older than this is reaped even if a live job names it (default: never). */
  maxAgeMs?: number;
}

export interface SpriteLeftovers {
  sprites: Array<{ name: string; reason: "no live job" | "past its lifetime" }>;
  dirs: Array<{ path: string; jobId: string }>;
}

export async function spriteLeftovers(
  dirs: SpriteHostDirs,
  running: Set<string>,
  now = Date.now(),
): Promise<SpriteLeftovers> {
  const live = new Set([...running].map((id) => spriteName(dirs.namePrefix, id)));
  const sprites: SpriteLeftovers["sprites"] = [];
  for (const s of await dirs.api.list(dirs.namePrefix)) {
    if (!s.name.startsWith(dirs.namePrefix)) continue;
    if (!live.has(s.name)) sprites.push({ name: s.name, reason: "no live job" });
    else if (dirs.maxAgeMs && s.createdAt !== null && now - s.createdAt > dirs.maxAgeMs) {
      sprites.push({ name: s.name, reason: "past its lifetime" });
    }
  }
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

/**
 * Destroys this runner's sprites that no live job holds (or past their lifetime) and removes job
 * dirs no live job accounts for. Throws, after trying them all, when any sprite couldn't be
 * destroyed.
 */
export async function reapSprites(dirs: SpriteHostDirs, running: Set<string>): Promise<string[]> {
  const found = await spriteLeftovers(dirs, running);
  const reaped: string[] = [];
  const failed: string[] = [];
  for (const s of found.sprites) {
    try {
      await dirs.api.destroy(s.name);
      reaped.push(s.name);
    } catch (err) {
      failed.push(`${s.name}: ${err instanceof Error ? err.message : err}`);
    }
  }
  const root = await realpath(dirs.spritesDir).catch(() => dirs.spritesDir);
  for (const d of found.dirs) {
    if (!isUnder(d.path, root)) continue;
    await rm(d.path, { recursive: true, force: true }).catch(() => {});
    await removeRunDir(join(dirs.runsDir, d.jobId)).catch(() => {});
    reaped.push(d.jobId);
  }
  if (failed.length) {
    throw new Error(
      `couldn't destroy ${failed.length} sprite(s), which may still be running: ${failed.join("; ")}`,
    );
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
    ...found.sprites.map((s) => `sprite ${s.name}: ${s.reason}`),
    ...found.dirs.map((d) => `job dir ${d.path} has no live job`),
  ];
}
