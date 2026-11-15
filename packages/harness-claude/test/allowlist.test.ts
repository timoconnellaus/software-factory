// A run in a plain directory runs in dontAsk with an allowlist: nothing on it may start another
// program, or the allowlist means nothing (a `find -exec` or `xargs` could launch /usr/bin/security
// or a binary a keychain item trusts). A run in a repository runs the toolchain, which runs
// anything; its floor is the OS sandbox, not this list.
import { describe, expect, it } from "vitest";
import { harnessEnv, runAllow } from "../src/settings.ts";

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

describe("allowlists", () => {
  it("leaves ripgrep out (`rg --pre <cmd>` and `--hostname-bin <cmd>` run programs)", () => {
    for (const kind of ["plain", "repo"] as const) {
      expect(bashCommands(runAllow(kind, "/w"))).not.toContain("rg");
    }
  });

  it("git reads can't page through a program, and no git rule can take -c or --exec-path", () => {
    const env = harnessEnv("/r");
    expect(env.GIT_PAGER).toBe("cat");
    expect(env.PAGER).toBe("cat");
    for (const c of bashCommands(runAllow("repo", "/w")).filter((c) => c.startsWith("git"))) {
      // `-c`/`--exec-path` go before the subcommand, so a `git <subcommand>` prefix can't match them.
      expect(c).toMatch(/^git [a-z-]+( [a-z-]+)*$/);
    }
  });

  it("plain: no allowlisted command can start another program", () => {
    const commands = bashCommands(runAllow("plain", "/w"));
    expect(commands.length).toBeGreaterThan(0);
    const hits = commands.filter((c) => EXEC_CAPABLE.some((e) => c === e || c.startsWith(`${e} `)));
    expect(hits).toEqual([]);
  });
});
