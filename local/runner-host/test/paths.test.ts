// Incident 2026-11-12 #9: job worktrees lived under ~/.local/state/software-factory, which the
// harness denies reading, so every agent was refused its own prompt file and handed back at once.
// What the agent must read (its worktree, its attachments) is never under a denied home path; what
// it must not read (the key, other runs, the clones) still is, or is protected explicitly.
import { join } from "node:path";
import { DENY_HOME } from "@software-factory/harness-claude";
import { describe, expect, it } from "vitest";
import { paths } from "../src/config.ts";

const HOME = "/Users/someone";
const denied = DENY_HOME.map((p) => join(HOME, p));
const under = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);

describe("runner paths", () => {
  for (const env of [{ HOME }, { HOME, XDG_STATE_HOME: join(HOME, ".local/state") }]) {
    const dirs = paths(env);
    it(`the agent's own dirs are readable (${Object.keys(env).join(",")})`, () => {
      for (const readable of [dirs.worktreesDir, dirs.attachmentsDir]) {
        expect(denied.filter((d) => under(readable, d))).toEqual([]);
      }
    });
    it("the runner's private dirs stay denied", () => {
      for (const secret of [dirs.configDir, dirs.runsDir, dirs.reposDir]) {
        expect(denied.some((d) => under(secret, d))).toBe(true);
      }
    });
  }
});
