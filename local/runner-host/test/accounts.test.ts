// Claude accounts on a host (ADR 0410, spec 32): the registry and its files, `sf-runner account`,
// and the heartbeat (names only) with the dashboard's `account.use`.
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { type AccountCliDeps, accountCommand } from "../src/account-cli.ts";
import {
  type AccountPaths,
  accountConfigDirs,
  accountsInUse,
  accountsReport,
  activeAccount,
  addLoginAccount,
  addTokenAccount,
  detectTokenEnv,
  listAccounts,
  noteUsage,
  removeAccount,
  useAccount,
} from "../src/accounts.ts";
import { paths } from "../src/config.ts";
import { RunnerHost } from "../src/host.ts";
import { controlPlane, fakeAdapter, fakeCloud, scratchRepo } from "./helpers.ts";

const OAUTH = "sk-ant-oat01-not-a-real-token-abcdefghijklmnopqrstuvwxyz";
const API_KEY = "sk-ant-api03-not-a-real-key-abcdefghijklmnopqrstuvwxyz0123";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function home(): Promise<{ root: string; p: AccountPaths; runsDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "sf-accounts-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const dirs = paths({ HOME: root });
  return {
    root,
    runsDir: dirs.runsDir,
    p: {
      accountsFile: dirs.accountsFile,
      accountTokensDir: dirs.accountTokensDir,
      accountConfigsDir: dirs.accountConfigsDir,
      limitsFile: join(dirs.stateDir, "account-limits.json"),
    },
  };
}

const mode = async (path: string) => (await stat(path)).mode & 0o777;

describe("accounts on a host", () => {
  it("has only `default` with zero setup, which is the host's own claude", async () => {
    const { p } = await home();
    expect(await activeAccount(p)).toEqual({ name: "default" });
    expect(await accountsReport(p)).toEqual({ names: ["default"], active: "default", limits: [] });
    const [only] = await listAccounts(p, { HOME: "/h" });
    expect(only).toEqual({ name: "default", kind: "default", active: true, configDir: "/h/.claude" });
  });

  it("adds a login account in its own 0700 config dir and makes it active on `use`", async () => {
    const { p } = await home();
    const added = await addLoginAccount(p, "work");
    expect(added).toEqual({ name: "work", configDir: join(p.accountConfigsDir, "work") });
    expect(await mode(join(p.accountConfigsDir, "work"))).toBe(0o700);
    expect(await mode(p.accountsFile)).toBe(0o600);
    // Not active until picked.
    expect((await activeAccount(p)).name).toBe("default");
    await useAccount(p, "work");
    expect(await activeAccount(p)).toEqual(added);
    expect(await accountsReport(p)).toEqual({
      names: ["default", "work"],
      active: "work",
      limits: [],
    });
    expect(await accountConfigDirs(p)).toContain(join(p.accountConfigsDir, "work"));
    await expect(addLoginAccount(p, "work")).rejects.toThrow(/already/);
    await expect(addLoginAccount(p, "default")).rejects.toThrow(/already/);
    await expect(addLoginAccount(p, "Work!")).rejects.toThrow(/isn't an account name/);
    await expect(useAccount(p, "nope")).rejects.toThrow(/no account/);
  });

  it("keeps a token in one 0600 file and nowhere else, and seeds the account's config dir", async () => {
    const { p, root } = await home();
    expect(detectTokenEnv(OAUTH)).toBe("CLAUDE_CODE_OAUTH_TOKEN");
    expect(detectTokenEnv(API_KEY)).toBe("ANTHROPIC_API_KEY");
    expect(detectTokenEnv("something")).toBeNull();
    const ci = await addTokenAccount(p, "ci", `  ${OAUTH}\n`);
    expect(ci.token).toEqual({
      file: join(p.accountTokensDir, "ci.token"),
      env: "CLAUDE_CODE_OAUTH_TOKEN",
    });
    expect(await readFile(join(p.accountTokensDir, "ci.token"), "utf8")).toBe(`${OAUTH}\n`);
    expect(await mode(join(p.accountTokensDir, "ci.token"))).toBe(0o600);
    expect(await mode(p.accountTokensDir)).toBe(0o700);
    // The token file sits under the runner's config dir (denied to every run), not in the
    // account's Claude config dir.
    expect(join(p.accountTokensDir, "ci.token").startsWith(join(root, ".config/software-factory"))).toBe(
      true,
    );
    const seeded = JSON.parse(await readFile(join(p.accountConfigsDir, "ci", ".claude.json"), "utf8"));
    expect(seeded).toEqual({ hasCompletedOnboarding: true });
    expect(await readFile(p.accountsFile, "utf8")).not.toContain(OAUTH);
    expect(JSON.stringify(await accountsReport(p))).not.toContain(OAUTH);

    await addTokenAccount(p, "api", API_KEY);
    const api = JSON.parse(await readFile(join(p.accountConfigsDir, "api", ".claude.json"), "utf8"));
    // Claude's own approval record for a custom key: its last 20 characters.
    expect(api.customApiKeyResponses.approved).toEqual([API_KEY.slice(-20)]);
    await expect(addTokenAccount(p, "x", "opaque")).rejects.toThrow(/--oauth/);
    expect((await addTokenAccount(p, "x", "opaque", { env: "ANTHROPIC_API_KEY" })).token?.env).toBe(
      "ANTHROPIC_API_KEY",
    );
    await expect(addTokenAccount(p, "y", " ")).rejects.toThrow(/empty/);
  });

  it("removes an account only when it is neither active, nor `default`, nor in use by a running job", async () => {
    const { p, runsDir } = await home();
    await addTokenAccount(p, "ci", OAUTH);
    await addLoginAccount(p, "work");
    await useAccount(p, "work");
    await expect(removeAccount(p, "default")).rejects.toThrow(/can't be removed/);
    await expect(removeAccount(p, "work")).rejects.toThrow(/active/);
    // A running job's launch record names the account it started on.
    await mkdir(join(runsDir, "job_1"), { recursive: true });
    await writeFile(join(runsDir, "job_1", "launch.json"), JSON.stringify({ account: "ci" }));
    const inUse = await accountsInUse(runsDir, ["job_1", "job_gone"]);
    expect(inUse).toEqual(new Set(["ci"]));
    await expect(removeAccount(p, "ci", inUse)).rejects.toThrow(/running job/);
    await removeAccount(p, "ci");
    await expect(stat(join(p.accountTokensDir, "ci.token"))).rejects.toThrow();
    await expect(stat(join(p.accountConfigsDir, "ci"))).rejects.toThrow();
    expect((await accountsReport(p)).names).toEqual(["default", "work"]);
  });

  it("records a usage limit against its account until a run on it ends cleanly", async () => {
    const { p } = await home();
    await addLoginAccount(p, "work");
    const at = new Date("2026-11-12T10:00:00Z");
    await noteUsage(p, "work", "You've hit your usage limit", at);
    expect((await accountsReport(p)).limits).toEqual([
      { name: "work", at: at.toISOString(), message: "You've hit your usage limit" },
    ]);
    await noteUsage(p, "work", null);
    expect((await accountsReport(p)).limits).toEqual([]);
  });

  it("falls back to `default` when the active name is gone from the registry", async () => {
    const { p } = await home();
    await mkdir(join(p.accountsFile, ".."), { recursive: true });
    await writeFile(p.accountsFile, JSON.stringify({ active: "ghost", accounts: {} }));
    expect(await activeAccount(p)).toEqual({ name: "default" });
    expect((await accountsReport(p)).active).toBe("default");
  });
});

describe("sf-runner account", () => {
  async function cli(stdin = "") {
    const { p, runsDir } = await home();
    const out: string[] = [];
    const claudeEnvs: NodeJS.ProcessEnv[] = [];
    const deps: AccountCliDeps = {
      paths: p,
      runsDir,
      liveJobs: async () => new Set(),
      allRuns: async () => [],
      readStdin: async () => stdin,
      runClaude: async (env) => {
        claudeEnvs.push(env);
        return 0;
      },
      log: (line) => out.push(line),
    };
    return { p, out, claudeEnvs, run: (...args: string[]) => accountCommand(args, deps) };
  }

  it("add runs claude in the new account's config dir, with no other model credential", async () => {
    const before = { ...process.env };
    process.env.ANTHROPIC_API_KEY = "host-key";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "host-oauth";
    try {
      const c = await cli();
      expect(await c.run("add", "work")).toBe(0);
      const [env] = c.claudeEnvs;
      expect(env?.CLAUDE_CONFIG_DIR).toBe(join(c.p.accountConfigsDir, "work"));
      expect(env?.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect(await c.run("add", "later", "--no-login")).toBe(0);
      expect(c.claudeEnvs).toHaveLength(1);
      expect(await c.run("use", "work")).toBe(0);
      c.out.length = 0;
      expect(await c.run("list")).toBe(0);
      expect(c.out.find((l) => l.startsWith("*"))).toMatch(/^\* work +login/);
    } finally {
      process.env = before;
    }
  });

  it("add --token-stdin keeps the token out of everything it prints", async () => {
    const c = await cli(`${OAUTH}\n`);
    expect(await c.run("add", "ci", "--token-stdin")).toBe(0);
    expect(c.out.join("\n")).not.toContain(OAUTH);
    expect(c.out.join("\n")).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(await c.run("add", "ci2", "--token-stdin", "--oauth", "--api-key")).toBe(2);
    expect(await c.run("remove", "ci")).toBe(0);
    expect(await c.run("frobnicate")).toBe(2);
    expect(await c.run("use")).toBe(2);
  });
});

describe("the heartbeat carries account names; the dashboard's pick switches the host", () => {
  it("reports names only and applies account.use", async () => {
    const { p } = await home();
    await addTokenAccount(p, "ci", OAUTH);
    await addLoginAccount(p, "work");
    const repo = await scratchRepo();
    cleanups.push(repo.cleanup);
    const cloud = fakeCloud();
    const cp = await controlPlane(cloud);
    const host = new RunnerHost({
      adapter: fakeAdapter((j) => repo.host.clonePath(j), async () => []),
      cp,
      git: repo.host,
      maxConcurrent: 1,
      heartbeatMs: 20,
      log: () => {},
      accounts: { report: () => accountsReport(p), use: (name) => useAccount(p, name) },
    });
    await host.start();
    expect(cloud.heartbeats[0]?.accounts).toEqual({
      names: ["default", "ci", "work"],
      active: "default",
      limits: [],
    });
    cloud.commands.push({ kind: "account.use", name: "work" });
    for (let i = 0; i < 50 && cloud.heartbeats.at(-1)?.accounts?.active !== "work"; i++) {
      await sleep(20);
    }
    await host.stop();
    expect(cloud.heartbeats.at(-1)?.accounts?.active).toBe("work");
    expect((await activeAccount(p)).name).toBe("work");
    // Never a credential on the wire.
    expect(JSON.stringify(cloud.heartbeats)).not.toContain(OAUTH);
  });

  it("ignores an account.use for a name it doesn't have", async () => {
    const { p } = await home();
    const repo = await scratchRepo();
    cleanups.push(repo.cleanup);
    const cloud = fakeCloud();
    const lines: string[] = [];
    const host = new RunnerHost({
      adapter: fakeAdapter((j) => repo.host.clonePath(j), async () => []),
      cp: await controlPlane(cloud),
      git: repo.host,
      maxConcurrent: 1,
      heartbeatMs: 20,
      log: (m) => lines.push(m),
      accounts: { report: () => accountsReport(p), use: (name) => useAccount(p, name) },
    });
    cloud.commands.push({ kind: "account.use", name: "ghost" });
    await host.start();
    await host.stop();
    expect((await activeAccount(p)).name).toBe("default");
    expect(lines.some((l) => /account.use ghost: no account/.test(l))).toBe(true);
  });
});
