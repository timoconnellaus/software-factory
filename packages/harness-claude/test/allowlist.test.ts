// The read-only stages (triage, spec, planning) run in dontAsk with an allowlist: nothing on it may
// start another program, or the allowlist means nothing (a `find -exec` or `xargs` could launch
// /usr/bin/security or a binary a keychain item trusts). Verify and build run the toolchain, which
// runs anything; their floor is the OS sandbox, not this list.
import { describe, expect, it } from "vitest";
import { stageAllow } from "../src/settings.ts";

/** Commands that can execute another program through an argument, a flag or a script. */
const EXEC_CAPABLE = [
  "find",
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
