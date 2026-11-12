// The Claude account a run uses (ADR 0410, spec 32): one model credential reaches Claude, the token
// is in no file the harness writes, and the ADR 0270 check still holds.
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Job } from "@software-factory/runner-contract";
import { afterEach, describe, expect, it } from "vitest";
import {
  accountConfigDir,
  carryConversation,
  type HarnessAccount,
  isUsageLimitText,
  MODEL_CREDENTIAL_ENV,
  parseStatusLines,
  projectDirName,
  projectHarness,
  psCommand,
  STATUS_HOOK_SCRIPT,
  statusHookSource,
  usageLimitOf,
  verifyLaunch,
} from "../src/index.ts";

const inHarnessSandbox =
  !process.env.CI &&
  (await psCommand(process.pid).then(
    (line) => line === null,
    () => true,
  ));

const dirs: string[] = [];
const temp = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const job = (stage: Job["stage"] = "build") => ({
  jobId: "job_acc",
  stage,
  harness: { id: "claude-code" as const, role: "implement" as const, prompt: "p" },
});

const SECRET = "sk-ant-oat01-not-a-real-token-0123456789abcdef";

/**
 * Projects a run, then runs its launch script with a stand-in `claude` that writes its
 * environment to a file: what the real Claude would start with.
 */
async function launchWith(account: HarnessAccount | undefined, parentEnv: NodeJS.ProcessEnv = {}) {
  const worktree = await temp("sf-acc-wt-");
  const runDir = join(await temp("sf-acc-run-"), "job_acc");
  const runTmp = join(await temp("sf-acc-tmp-"), "job_acc");
  const bin = await temp("sf-acc-bin-");
  const envOut = join(bin, "env.txt");
  const claudeBin = join(bin, "claude");
  await writeFile(claudeBin, `#!/bin/sh\nenv > '${envOut}'\nsleep 3\n`, { mode: 0o755 });
  const projected = await projectHarness(job(), {
    worktree,
    runDir,
    runTmp,
    claudeBin,
    ...(account ? { account } : {}),
  });
  const script = await readFile(projected.scriptPath, "utf8");
  const child = spawn("/bin/sh", [projected.scriptPath], {
    stdio: "ignore",
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...parentEnv },
  });
  let gone = false;
  const exited = new Promise<number | null>((resolve) =>
    child.on("exit", (code) => {
      gone = true;
      resolve(code);
    }),
  );
  let env: Record<string, string> | null = null;
  for (let i = 0; i < 40 && !env && !gone; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const text = await readFile(envOut, "utf8").catch(() => "");
    if (text.includes("\n")) {
      env = Object.fromEntries(
        text
          .split("\n")
          .filter((l) => l.includes("="))
          .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
      );
    }
  }
  return { projected, script, env, child, exited, worktree, runDir, runTmp };
}

/** Every file under `dir`, with its contents. */
async function filesUnder(dir: string): Promise<{ path: string; text: string }[]> {
  const out: { path: string; text: string }[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(path)));
    else if (entry.isFile()) out.push({ path, text: await readFile(path, "utf8") });
  }
  return out;
}

describe("a run's Claude account (ADR 0410)", () => {
  it("leaves the environment as the host has it on the default account", async () => {
    const run = await launchWith(undefined, { ANTHROPIC_API_KEY: "host-key" });
    try {
      expect(run.script).not.toMatch(/CLAUDE_CONFIG_DIR|ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN/);
      expect(run.projected.launch.account).toBeUndefined();
      expect(run.env?.ANTHROPIC_API_KEY).toBe("host-key");
      expect(run.env?.CLAUDE_CONFIG_DIR).toBeUndefined();
    } finally {
      run.child.kill();
    }
    const named = await launchWith({ name: "default" });
    named.child.kill();
    expect(named.script).not.toMatch(/CLAUDE_CONFIG_DIR/);
    expect(named.projected.launch.account).toBe("default");
    expect(named.projected.launch.configDir).toBeUndefined();
  });

  it("gives a login account its config dir and no other model credential", async () => {
    const configDir = join(await temp("sf-acc-cfg-"), "work");
    const run = await launchWith(
      { name: "work", configDir },
      {
        ANTHROPIC_API_KEY: "host-key",
        ANTHROPIC_AUTH_TOKEN: "host-auth",
        CLAUDE_CODE_OAUTH_TOKEN: "host-oauth",
        CLAUDE_CONFIG_DIR: "/somewhere/else",
      },
    );
    try {
      expect(run.env).not.toBeNull();
      expect(run.env?.CLAUDE_CONFIG_DIR).toBe(configDir);
      for (const name of MODEL_CREDENTIAL_ENV.filter((n) => n !== "CLAUDE_CONFIG_DIR")) {
        expect(run.env?.[name]).toBeUndefined();
      }
      expect(run.projected.launch).toEqual(
        expect.objectContaining({ account: "work", configDir }),
      );
      // The config dir stays readable (Claude's shell snapshots); its credentials file doesn't.
      const settings = run.projected.settings;
      expect(settings.permissions.deny).toContain(`Read(/${join(configDir, ".credentials.json")})`);
      expect(settings.sandbox.filesystem.denyRead).toContain(join(configDir, ".credentials.json"));
      expect(settings.sandbox.filesystem.denyRead).not.toContain(configDir);
      // The account changes neither the argv nor the settings env.
      expect(run.projected.launch.argv.join(" ")).not.toMatch(/CONFIG_DIR|account/);
      expect(settings.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    } finally {
      run.child.kill();
    }
  });

  it("reads a token account's token from its file at launch, into the one variable, and writes it nowhere", async () => {
    const accounts = await temp("sf-acc-secrets-");
    const tokenFile = join(accounts, "ci.token");
    await writeFile(tokenFile, `${SECRET}\n`, { mode: 0o600 });
    const configDir = join(accounts, "ci");
    await mkdir(configDir, { recursive: true });
    const run = await launchWith(
      { name: "ci", configDir, token: { file: tokenFile, env: "CLAUDE_CODE_OAUTH_TOKEN" } },
      { ANTHROPIC_API_KEY: "host-key" },
    );
    try {
      expect(run.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe(SECRET);
      expect(run.env?.ANTHROPIC_API_KEY).toBeUndefined();
      expect(run.env?.CLAUDE_CONFIG_DIR).toBe(configDir);
      // Not in the script, the settings, the launch record, or anything else the harness wrote.
      expect(run.script).not.toContain(SECRET);
      expect(run.script).toContain(`CLAUDE_CODE_OAUTH_TOKEN="$(cat ${tokenFile})" || exit 96`);
      for (const dir of [run.runDir, run.worktree, run.runTmp]) {
        for (const f of await filesUnder(dir)) expect(f.text, f.path).not.toContain(SECRET);
      }
      expect(run.projected.settings.permissions.deny).toContain(`Read(/${tokenFile})`);
      expect(run.projected.settings.sandbox.filesystem.denyRead).toContain(tokenFile);
    } finally {
      run.child.kill();
    }
  });

  it("refuses to start without the token rather than fall back to another credential", async () => {
    const accounts = await temp("sf-acc-secrets-");
    const run = await launchWith(
      {
        name: "ci",
        configDir: join(accounts, "ci"),
        token: { file: join(accounts, "missing.token"), env: "ANTHROPIC_API_KEY" },
      },
      { ANTHROPIC_API_KEY: "host-key" },
    );
    expect(await run.exited).toBe(96);
    expect(run.env).toBeNull();
  });

  it.skipIf(inHarnessSandbox)(
    "still passes the ADR 0270 check on a named account",
    async () => {
      const configDir = join(await temp("sf-acc-cfg-"), "work");
      const run = await launchWith({ name: "work", configDir });
      try {
        let problems: string[] = ["not started"];
        for (let i = 0; i < 30 && problems.length; i++) {
          await new Promise((r) => setTimeout(r, 100));
          problems = await verifyLaunch(run.projected.launch, async (pid) => {
            const real = await psCommand(pid);
            return real?.replace(/^\/bin\/sh /, "") ?? null;
          });
        }
        expect(problems).toEqual([]);
      } finally {
        run.child.kill();
      }
    },
  );

  it("knows where a run's transcripts go", () => {
    expect(accountConfigDir({ name: "work", configDir: "/a/work" })).toBe("/a/work");
    expect(accountConfigDir(undefined, { HOME: "/home/x" })).toBe("/home/x/.claude");
    expect(accountConfigDir({ name: "default" }, { CLAUDE_CONFIG_DIR: "/c", HOME: "/h" })).toBe(
      "/c",
    );
  });

  it("carries a planning conversation into the account it resumes on", async () => {
    const old = await temp("sf-acc-old-");
    const now = await temp("sf-acc-new-");
    const cwd = "/w/sf-plan-ps_1";
    const project = join(old, "projects", projectDirName(cwd));
    await mkdir(project, { recursive: true });
    await writeFile(join(project, "sess-1.jsonl"), '{"type":"user"}\n');
    const from = await carryConversation({ cwd, sessionId: "sess-1", to: now, from: [now, old] });
    expect(from).toBe(join(project, "sess-1.jsonl"));
    const copied = join(now, "projects", projectDirName(cwd), "sess-1.jsonl");
    expect(await readFile(copied, "utf8")).toBe('{"type":"user"}\n');
    // Already there, or found nowhere: nothing to do.
    expect(await carryConversation({ cwd, sessionId: "sess-1", to: now, from: [old] })).toBeNull();
    expect(await carryConversation({ cwd, sessionId: "nope", to: now, from: [old] })).toBeNull();
    expect((await stat(copied)).isFile()).toBe(true);
  });
});

describe("usage limits (ADR 0410: surfaced, never acted on)", () => {
  it("reads a usage limit from a StopFailure, not from other events", () => {
    expect(usageLimitOf({ event: "StopFailure", error: "rate_limit" })).toBe(
      "usage limit reached (rate_limit)",
    );
    expect(
      usageLimitOf({
        event: "StopFailure",
        error: "unknown",
        message: "You've hit your usage limit · resets 5pm",
      }),
    ).toBe("You've hit your usage limit · resets 5pm");
    expect(usageLimitOf({ event: "StopFailure", error: "authentication_failed" })).toBeNull();
    expect(usageLimitOf({ event: "Notification", message: "usage limit" })).toBeNull();
    expect(isUsageLimitText("Claude AI usage limit reached|1700000000")).toBe(true);
    expect(isUsageLimitText("Done: tests pass.")).toBe(false);
  });

  it("the status hook records a failure's error type", async () => {
    const dir = await temp("sf-acc-hook-");
    const script = join(dir, STATUS_HOOK_SCRIPT);
    const file = join(dir, "status.jsonl");
    await writeFile(script, statusHookSource());
    const r = spawnSync(process.execPath, [script, file], {
      input: JSON.stringify({
        hook_event_name: "StopFailure",
        error: "rate_limit",
        last_assistant_message: "You've hit your limit · resets 3pm",
      }),
      encoding: "utf8",
    });
    expect(r.stdout.trim()).toBe("{}");
    const [line] = parseStatusLines(await readFile(file, "utf8"));
    expect(line).toEqual(
      expect.objectContaining({
        event: "StopFailure",
        error: "rate_limit",
        message: "You've hit your limit · resets 3pm",
      }),
    );
    expect(usageLimitOf(line ?? { event: "" })).toBe("You've hit your limit · resets 3pm");
  });
});
