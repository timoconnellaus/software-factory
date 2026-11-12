// The read-only stages (triage, spec, planning) run in dontAsk with an allowlist: nothing on it may
// start another program, or the allowlist means nothing (a `find -exec` or `xargs` could launch
// /usr/bin/security or a binary a keychain item trusts). Verify and build run the toolchain, which
// runs anything; their floor is the OS sandbox, not this list.
import { describe, expect, it } from "vitest";
import { stageAllow } from "../src/settings.ts";

/** Commands that can execute another program through an argument, a flag or a script. */
const EXEC_CAPABLE = [
  "find",
  "rg",
  "xargs",
  "sort",
  "env",
  "nice",
  "nohup",
  "time",
  "timeout",
  "command",
  "exec",
  "eval",
  "sh",
  "bash",
  "zsh",
  "awk",
  "sed",
  "perl",
  "python",
  "python3",
  "ruby",
  "node",
  "bun",
  "deno",
  "npm",
  "npx",
  "pnpm",
  "tar",
  "make",
  "watch",
  "git grep",
  "git -c",
  "git difftool",
  "git mergetool",
  "git filter-branch",
  "open",
];

const bashCommands = (rules: string[]) =>
  rules.flatMap((r) => {
    const m = r.match(/^Bash\((.+?)(?::\*)?\)$/);
    return m?.[1] ? [m[1]] : [];
  });

describe("read-only stage allowlists", () => {
  it("leaves ripgrep out (`rg --pre <cmd>` and `--hostname-bin <cmd>` run programs)", () => {
    for (const stage of ["triage", "spec", "planning", "verify", "build"] as const) {
      expect(bashCommands(stageAllow(stage, "/w"))).not.toContain("rg");
    }
  });

  it("git reads can't page through a program, and no git rule can take -c or --exec-path", async () => {
    const { harnessEnv } = await import("../src/settings.ts");
    const env = harnessEnv("/r");
    expect(env.GIT_PAGER).toBe("cat");
    expect(env.PAGER).toBe("cat");
    for (const stage of ["triage", "spec", "planning"] as const) {
      for (const c of bashCommands(stageAllow(stage, "/w")).filter((c) => c.startsWith("git"))) {
        // `-c`/`--exec-path` go before the subcommand, so a `git <subcommand>` prefix can't match them.
        expect(c).toMatch(/^git [a-z-]+( [a-z-]+)*$/);
      }
    }
  });

  for (const stage of ["triage", "spec", "planning"] as const) {
    it(`${stage}: no allowlisted command can start another program`, () => {
      const commands = bashCommands(stageAllow(stage, "/w"));
      expect(commands.length).toBeGreaterThan(0);
      const hits = commands.filter((c) =>
        EXEC_CAPABLE.some((e) => c === e || c.startsWith(`${e} `)),
      );
      expect(hits).toEqual([]);
    });
  }
});
