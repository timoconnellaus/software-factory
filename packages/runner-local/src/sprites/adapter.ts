// A cloud sandbox per job on Sprites (ADR 0480, spec 36). The owner's runner host provisions it:
// for each claimed job it creates a fresh sprite with the owner's Sprites token, installs the agent
// toolchain, puts on the egress allowlist, copies the job's own repo and run files in, and runs the
// harness's unchanged launch script there with the job's Claude account token. runner-local's tmux
// session stays on the host: its pane runs a bridge to the sprite's exec TTY (`tty-bridge.ts`), so
// the start check, the prompt, steering, `tmux attach` and the web terminal work as on a container
// job. The run's files (pid, status, transcript) are mirrored back (`mirror.ts`). When the session
// ends the host brings the sprite's repo back as a git bundle (`result.ts`), scans it for the
// credential and pushes with the job token, as always; then the sprite is destroyed.
//
// The factory never holds either secret: the Sprites token and the model credential stay on the
// owner's host (ADR 0023, 0410), and the job token never enters the sprite (ADR 0033, 0250).
// Planning sessions still run on the host (their relay is on the host's loopback, ADR 0350).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_HARNESS_ACCOUNT,
  type HarnessAccount,
  type LaunchRecord,
  PID_FILE,
  parseStatusLines,
  projectHarness,
  type ReadCommand,
  readLaunchRecord,
  removeRunDir,
  STATUS_FILE,
  shellQuote,
  verifyLaunch,
} from "@software-factory/harness-claude";
import {
  type AdapterEvent,
  type Artifact,
  type CapabilityManifest,
  type Job,
  RESULT_FILE,
  type RunnerAdapter,
} from "@software-factory/runner-contract";
import {
  createLocalRunner,
  DEFAULT_CAPABILITIES,
  type LocalRunnerConfig,
  type LocalSession,
  type LocalWorkspace,
} from "../adapter.ts";
import { findCheckout, isUnder } from "../checkouts.ts";
import {
  claudeStateSeed,
  credentialForAccount,
  type ModelCredential,
} from "../container/adapter.ts";
import { egressAllowlist } from "../container/egress.ts";
import {
  checkJobGitDir,
  createJobRepo,
  HOST_FETCH_NAMESPACE,
  hostGitEnv,
  SAFE_GIT,
  scanForSecrets,
} from "../container/job-repo.ts";
import { jobDirs } from "../container/spec.ts";
import { nodeExec } from "../exec.ts";
import { sessionName } from "../tmux.ts";
import { type EgressRule, type SandboxApi, type SandboxSize, spritesApi } from "./api.ts";
import { createMirror, type Mirror } from "./mirror.ts";
import { fetchResult, importResult } from "./result.ts";
import {
  ENTRY,
  pinnedClaudeVersion,
  provisionScript,
  SHA256,
  scriptArgv,
  toolPrefix,
  UPLOAD,
  WRITE,
} from "./scripts.ts";
import type { TtyBridgeConfig } from "./tty-bridge.ts";

export const SPRITE_RECORD = "sprite.json";
export const SPRITE_SCRIPT = "sprite.sh";
export const SPRITE_ENTRY = "sprite-entry.sh";
export const SPRITE_TTY = "sprite-tty.json";
/** The bridge the job's tmux pane runs, on the host's Node. */
export const BRIDGE_SCRIPT = fileURLToPath(new URL("./tty-bridge.ts", import.meta.url));

/** What the runner records about a sprite job, next to the launch record. */
export interface SpriteRecord {
  jobId: string;
  provider: string;
  /** The sandbox's name; its id once created. */
  name: string;
  id?: string;
  /** The egress allowlist put on it before the job's files went in. */
  egress: EgressRule[];
  claudeVersion: string;
  /** Where the pinned Claude Code and the hook's Node are in the sprite. */
  prefix: string;
  /** The job repo's HEAD when its files went in (the host's merge included). */
  uploadHead?: string;
  /** The job repo, for the checks after the session. */
  repo: { work: string; gitDir: string; dotGit: string; configHash: string };
  /**
   * The model credential's file in the sprite: in `/dev/shm` (memory: never on the sprite's disk or
   * in a checkpoint), deleted by the entry script once read.
   */
  credentialFile: string;
  /** Set (and written) before the create call: from then on the sprite may exist and must go. */
  createRequested?: boolean;
  size: SandboxSize;
  /** The most the session may run, in seconds; the entry script stops Claude then. */
  maxLifetimeS: number;
}

export interface SpritesOptions {
  /** The provider (default: Sprites over its API, with the token from `tokenFile`). */
  api?: SandboxApi;
  /** Default `https://api.sprites.dev`. */
  apiUrl?: string;
  /** The owner's Sprites token (0600, on the host; read when a job starts). */
  tokenFile: string;
  /** Host-side job dirs (`<spritesDir>/sf-<jobId>/`). */
  spritesDir: string;
  /** Every sandbox this runner makes starts with it (`sf-<runner>-`), so reaping finds only its own. */
  namePrefix?: string;
  /** The credential for a job, from its Claude account (default `credentialForAccount`). */
  modelCredential?: (
    job: Job,
    account: HarnessAccount,
  ) => Promise<ModelCredential | null> | ModelCredential | null;
  /** More egress hosts for every job on this runner. */
  allowedHosts?: string[];
  /** Where the host fetched the item and default branches in the checkout (runner-host's). */
  fetchNamespace?: string;
  /** Claude Code's version in the sprite (default: the agent image's pin). */
  claudeVersion?: string;
  /** The Node that runs the bridge on the host (default: this process's). */
  node?: string;
  /** How often the run's files are pulled from the sprite. */
  mirrorMs?: number;
  /** Tests: environment for the sprite's scripts (the fake runs them without sudo). */
  scriptEnv?: Record<string, string>;
  /** The sprite's size, sent explicitly at creation (default `DEFAULT_SPRITE_SIZE`). */
  size?: Partial<SandboxSize>;
  /**
   * The most a sprite may live (default 4 h): the entry script stops Claude then, so the sprite
   * pauses and stops costing compute, and the host's sweep destroys any sprite older than this.
   */
  maxLifetimeMs?: number;
  /** The most bytes copied in per job (default 2 GiB). */
  maxUploadBytes?: number;
  log?: (message: string) => void;
}

export interface SpritesRunnerConfig extends LocalRunnerConfig {
  sprites: SpritesOptions;
}

export interface SpriteWorkspace extends LocalWorkspace {
  sprite: SpriteRecord;
  hostAccount: HarnessAccount;
  jobRoot: string;
}

export const DEFAULT_SPRITE_SIZE: SandboxSize = { cpus: 4, memoryMb: 8192, storageGb: 50 };
export const DEFAULT_MAX_LIFETIME_MS = 4 * 60 * 60_000;
export const DEFAULT_MAX_UPLOAD_BYTES = 2 * 1024 ** 3;

const isSprite = (ws: LocalWorkspace | undefined): ws is SpriteWorkspace => !!ws && "sprite" in ws;

/** A sandbox's name for a job: lower-case, the runner's prefix, a hash so two ids never collide. */
export function spriteName(prefix: string, jobId: string): string {
  const slug = jobId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
  const hash = createHash("sha256").update(jobId).digest("hex").slice(0, 6);
  return `${prefix}${slug}-${hash}`.slice(0, 63);
}

/** The runner's sandbox name prefix from its id (`r_abc123` → `sf-abc123-`). */
export function spritePrefix(runnerId: string): string {
  return `sf-${runnerId
    .replace(/^r_/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 16)}-`;
}

/** The rule that ends every job's policy: anything not allowed above is refused. */
export const DENY_ALL: EgressRule = { domain: "*", action: "deny" };

/**
 * The egress rules for a job: the allowlist a container job's proxy gets (ADR 0430 §5), as domain
 * rules, then an explicit deny of everything else (never relying on a default). Sprites' policy is
 * DNS-based, so a port in an entry can't be kept: the host is allowed.
 */
export function egressRules(allow: readonly string[]): EgressRule[] {
  const domains = new Set<string>();
  for (const entry of allow) {
    const host = entry.trim().toLowerCase().replace(/:\d+$/, "");
    if (host && host !== "*") domains.add(host);
  }
  return [...[...domains].sort().map((domain) => ({ domain, action: "allow" as const })), DENY_ALL];
}

const ruleKey = (r: EgressRule) => `${r.action} ${r.domain.toLowerCase()}`;

/**
 * What differs between the rules in force and the job's. Empty only when they are exactly the
 * job's rules: its allows and the deny-all, nothing else (no `allow *`, nothing it doesn't know).
 */
export function egressProblems(want: EgressRule[], have: EgressRule[]): string[] {
  if (have.length === 0) return ["the sprite has no egress policy (it can reach anything)"];
  const problems: string[] = [];
  if (!have.some((r) => r.domain === "*" && r.action === "deny")) {
    problems.push("the sprite's egress policy doesn't deny everything else");
  }
  if (have.some((r) => r.domain === "*" && r.action === "allow")) {
    problems.push("the sprite's egress policy allows everything");
  }
  const a = new Set(want.map(ruleKey));
  const b = new Set(have.map(ruleKey));
  const extra = [...b].filter((k) => !a.has(k));
  const missing = [...a].filter((k) => !b.has(k));
  if (extra.length || missing.length) {
    problems.push(
      `the sprite's egress policy differs${extra.length ? `; unexpected: ${extra.join(", ")}` : ""}${missing.length ? `; missing: ${missing.join(", ")}` : ""}`,
    );
  }
  return problems;
}

/** The rules in force, checked: a policy it can't read or understand is a problem (fail closed). */
export async function checkEgress(api: SandboxApi, name: string, want: EgressRule[]) {
  try {
    return egressProblems(want, await api.getEgress(name));
  } catch (err) {
    return [
      `the sprite's egress policy can't be checked: ${err instanceof Error ? err.message : err}`,
    ];
  }
}

/** The script the job's tmux pane runs: the bridge to Claude in the sprite. */
export function spriteScript(jobId: string, node: string, config: string): string {
  return [
    "#!/bin/sh",
    `# Written by the software factory runner for job ${jobId}: Claude Code in a sprite (ADR 0480).`,
    "# This pane is bridged to the sprite's terminal; the harness's own launch script runs there.",
    `exec ${[node, "--experimental-transform-types", "--no-warnings", BRIDGE_SCRIPT, config].map(shellQuote).join(" ")}`,
    "",
  ].join("\n");
}

/**
 * The arguments of the sprite's entry script (`ENTRY`): the credential file, the launch script, the
 * keep-awake task's name, the lifetime in seconds, then the job's environment.
 */
export function entryArgs(input: {
  jobId: string;
  credentialFile: string;
  launchScript: string;
  maxLifetimeS: number;
  env: Record<string, string>;
}): string[] {
  return [
    input.credentialFile,
    input.launchScript,
    `sf-${input.jobId.replace(/[^A-Za-z0-9-]/g, "-")}`,
    String(Math.max(60, Math.round(input.maxLifetimeS))),
    ...Object.entries(input.env).map(([k, v]) => `${k}=${v}`),
  ];
}

/** The environment Claude gets in a sprite (a container's, without the proxy: egress is the policy). */
export function spriteEnv(home: string): Record<string, string> {
  return {
    HOME: home,
    TERM: "xterm-256color",
    LANG: "C.UTF-8",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "safe.directory",
    GIT_CONFIG_VALUE_0: "*",
    SOFTWARE_FACTORY_ISOLATION: "sprites",
  };
}

/**
 * A tar of the given absolute paths, relative to `/`, without extended attributes, streamed into
 * `out` (never held in memory). Fails past `maxBytes`. Returns its sha256 and size.
 */
async function tarTo(
  paths: string[],
  out: string,
  maxBytes: number,
): Promise<{ sha256: string; bytes: number }> {
  const flags =
    process.platform === "darwin" ? ["--no-xattrs", "--no-mac-metadata"] : ["--no-xattrs"];
  const child = spawn(
    "tar",
    ["-c", "-f", "-", ...flags, "-C", "/", ...paths.map((p) => relative("/", p))],
    { env: { ...process.env, COPYFILE_DISABLE: "1" }, stdio: ["ignore", "pipe", "pipe"] },
  );
  let err = "";
  child.stderr.on("data", (c: Buffer) => {
    err += c.toString();
  });
  const exited = new Promise<number | null>((done, fail) => {
    child.on("error", fail);
    child.on("close", done);
  });
  let bytes = 0;
  const capped = new Transform({
    transform(chunk: Buffer, _enc, next) {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        child.kill();
        next(new Error(`the job's files are over ${maxBytes} bytes; not copying them in`));
      } else next(null, chunk);
    },
  });
  await pipeline(child.stdout, capped, createWriteStream(out, { mode: 0o600 }));
  const code = await exited;
  if (code !== 0) throw new Error(`tar exited ${code}: ${err.trim()}`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(out)) hash.update(chunk as Buffer);
  return { sha256: hash.digest("hex"), bytes: (await stat(out)).size };
}

/** `ps` in the sprite: the process's argv, or null when it is gone. */
export function spriteReadCommand(
  api: SandboxApi,
  name: string,
  env?: Record<string, string>,
): ReadCommand {
  return async (pid) => {
    const r = await api.exec(name, ["ps", "-ww", "-o", "command=", "-p", String(pid)], {
      ...(env ? { env } : {}),
      timeoutMs: 20_000,
    });
    const line = r.stdout.toString("utf8").replace(/\n$/, "");
    return r.code === 0 && line ? line : null;
  };
}

/**
 * The sprite side of the launch check: the sandbox is the one the runner made, its egress policy is
 * the job's, and the settings Claude reads in it are the projected ones.
 */
export async function spriteChecks(
  api: SandboxApi,
  record: SpriteRecord,
  launch: LaunchRecord,
  env?: Record<string, string>,
): Promise<string[]> {
  const problems: string[] = [];
  const info = await api.get(record.name).catch(() => null);
  if (!info) return [`sprite ${record.name} isn't there`];
  if (record.id && info.id !== record.id) {
    problems.push(`sprite ${record.name} is ${info.id}, not the ${record.id} the runner made`);
  }
  problems.push(...(await checkEgress(api, record.name, record.egress)));
  const r = await api.exec(record.name, scriptArgv(SHA256, launch.settingsPaths), {
    ...(env ? { env } : {}),
    timeoutMs: 20_000,
  });
  const hashes = r.stdout.toString("utf8").trim().split("\n");
  launch.settingsPaths.forEach((path, i) => {
    if (hashes[i] !== launch.settingsHash)
      problems.push(`${path} in the sprite isn't the projected one`);
  });
  return problems;
}

export async function readSpriteRecord(runDir: string): Promise<SpriteRecord | null> {
  try {
    return JSON.parse(await readFile(join(runDir, SPRITE_RECORD), "utf8")) as SpriteRecord;
  } catch {
    return null;
  }
}

/** The launch and sprite check for a running sprite job (for `sf-runner doctor`). */
export async function checkRunningSprite(
  runDir: string,
  api: SandboxApi,
): Promise<{ record: LaunchRecord; problems: string[] } | null> {
  const sprite = await readSpriteRecord(runDir);
  const launch = await readLaunchRecord(runDir);
  if (!sprite || !launch) return null;
  return {
    record: launch,
    problems: [
      ...(await verifyLaunch(launch, spriteReadCommand(api, sprite.name))),
      ...(await spriteChecks(api, sprite, launch)),
    ],
  };
}

/** The provider token, read from its file when a job needs it. */
export async function readSpritesToken(file: string): Promise<string> {
  const token = (await readFile(file, "utf8").catch(() => "")).trim();
  if (!token) {
    throw new Error(
      `no Sprites token in ${file}: run \`sf-runner sprites login\` (paste a token from https://sprites.dev/account)`,
    );
  }
  return token;
}

export function createSpritesRunner(
  config: SpritesRunnerConfig,
): RunnerAdapter<LocalWorkspace, LocalSession> {
  const exec = config.exec ?? nodeExec;
  const options = config.sprites;
  const local = createLocalRunner(config);
  const capabilities = config.capabilities ?? DEFAULT_CAPABILITIES;
  const log = options.log ?? (() => {});
  const prefix = options.namePrefix ?? "sf-";
  const scriptEnv = options.scriptEnv;
  const execOpts = (timeoutMs: number, extra: { stdin?: Buffer | string } = {}) => ({
    timeoutMs,
    ...(scriptEnv ? { env: scriptEnv } : {}),
    ...extra,
  });
  /** The client for the token in the file now: a re-login takes effect on the next call. */
  let cached: { token: string; api: SandboxApi } | null = null;
  const api = async (): Promise<SandboxApi> => {
    if (options.api) return options.api;
    const token = await readSpritesToken(options.tokenFile);
    if (cached?.token !== token) {
      cached = {
        token,
        api: spritesApi({ token, ...(options.apiUrl ? { apiUrl: options.apiUrl } : {}) }),
      };
    }
    return cached.api;
  };
  const size: SandboxSize = { ...DEFAULT_SPRITE_SIZE, ...options.size };
  const maxLifetimeMs = options.maxLifetimeMs ?? DEFAULT_MAX_LIFETIME_MS;
  const search = {
    dirs: config.checkouts ?? [],
    exclude: [
      config.worktreesDir,
      options.spritesDir,
      ...(config.ownReposDir ? [config.ownReposDir] : []),
    ],
    exec,
  };
  const secrets = new Map<string, string[]>();
  const mirrors = new Map<string, Mirror>();
  const active = new Map<string, SpriteWorkspace>();

  async function checkoutFor(job: Job): Promise<string> {
    const found = await findCheckout(job, search);
    if (found) return found.path;
    const clone = await config.resolveRepoPath(job);
    return realpath(clone).catch(() => clone);
  }

  async function spritesRoot(): Promise<string> {
    await mkdir(options.spritesDir, { recursive: true, mode: 0o700 });
    return realpath(options.spritesDir);
  }

  async function stopMirror(jobId: string): Promise<void> {
    const mirror = mirrors.get(jobId);
    mirrors.delete(jobId);
    await mirror?.stop().catch(() => {});
  }

  /** Destroys a sprite. Any failure (no token, the API) throws: it may still be running. */
  async function destroy(name: string): Promise<void> {
    await (await api()).destroy(name);
  }

  async function cleanUp(job: Job, ws: SpriteWorkspace | undefined): Promise<string[]> {
    const errors: string[] = [];
    const attempt = async (what: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (err) {
        errors.push(`${what}: ${err instanceof Error ? err.message : err}`);
      }
    };
    await stopMirror(job.jobId);
    const runDir = ws?.runDir ?? join(config.runsDir, job.jobId);
    const record = ws?.sprite ?? (await readSpriteRecord(runDir));
    const name = record?.name ?? spriteName(prefix, job.jobId);
    if (record?.createRequested) {
      // It may exist: it must be destroyed, or this release fails (and says so).
      await attempt(`destroy sprite ${name} (it may still be running)`, () => destroy(name));
    } else {
      // Never created by this run; a crashed earlier run's, if any, goes too when it can.
      await destroy(name).catch(() => {});
    }
    const root = await spritesRoot().catch(() => options.spritesDir);
    await attempt("remove job dir", async () => {
      const dir = ws?.jobRoot ?? jobDirs(root, sessionName(job.jobId)).root;
      if (!isUnder(dir, root)) throw new Error(`refusing to remove ${dir}: not under ${root}`);
      await rm(dir, { recursive: true, force: true });
    });
    await attempt("remove run dir", () => removeRunDir(runDir));
    if (ws) await attempt("remove attachments", () => removeRunDir(ws.attachmentsDir));
    secrets.delete(job.jobId);
    return errors;
  }

  /** The files the mirror pulls: the run's pid and status, and transcripts under the job's home. */
  async function mirrored(ws: SpriteWorkspace): Promise<string[]> {
    const home = join(ws.jobRoot, "home");
    const files = [ws.statusFile, join(ws.runDir, PID_FILE)];
    const lines = parseStatusLines(await readFile(ws.statusFile, "utf8").catch(() => ""));
    for (const line of lines) {
      if (!line.transcript) continue;
      const path = resolve(line.transcript);
      if (isUnder(path, home) && path !== home) files.push(path);
    }
    return files;
  }

  /** Where a job's transfer files go on the host: outside every dir copied in or checked out. */
  async function transferDir(): Promise<string> {
    const dir = join(await spritesRoot(), ".transfer");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  /** After the session: the result into the host's job repo, then the checks (ADR 0480). */
  async function afterSession(job: Job, ws: SpriteWorkspace): Promise<string[]> {
    const provider = await api();
    const record = ws.sprite;
    await stopMirror(job.jobId);
    const transfer = await transferDir();
    const name = sessionName(job.jobId);
    // The stage result is a private file (never in git): pulled to a host file of its own, and put
    // in the worktree only after the import (which could otherwise replace it with a symlink).
    const resultPath = join(ws.path, RESULT_FILE);
    const pulled = join(transfer, `${name}.result.json`);
    await rm(pulled, { force: true });
    try {
      await createMirror({
        api: provider,
        sandbox: record.name,
        files: () => [{ remote: resultPath, local: pulled }],
        maxSize: 8 << 20,
      })
        .pull()
        .catch((err) =>
          log(`${job.jobId}: pulling the result: ${err instanceof Error ? err.message : err}`),
        );
      const bundleFile = join(transfer, `${name}.bundle`);
      const header = await fetchResult(
        provider,
        record.name,
        {
          work: ws.path,
          gitDir: record.repo.gitDir,
          tmp: ws.runTmp,
          base: record.uploadHead ?? ws.baseSha,
        },
        { outFile: join(transfer, `${name}.result`), bundleFile },
      );
      const problems = await importResult({
        exec,
        work: ws.path,
        gitDir: record.repo.gitDir,
        branch: ws.branch,
        header,
        bundleFile,
      });
      problems.push(...(await checkJobGitDir(record.repo)));
      // Whatever the import left at the result's path goes (never followed), then the pulled one.
      const there = await lstat(resultPath).catch(() => null);
      if (there) await rm(resultPath, { recursive: true, force: true });
      if (await lstat(pulled).catch(() => null)) await rename(pulled, resultPath);
      if (problems.length === 0) {
        const leaked = await scanForSecrets(
          exec,
          ws.path,
          ws.baseSha,
          secrets.get(job.jobId) ?? [],
        );
        if (leaked.length)
          problems.push(`the model credential is in ${leaked.slice(0, 10).join(", ")}`);
      }
      return problems;
    } finally {
      await rm(pulled, { force: true });
      // The result is in (or failed): the sprite goes now. If it can't, release tries again and
      // fails loudly.
      await provider.destroy(record.name).catch((err) => {
        log(
          `${job.jobId}: DESTROYING SPRITE ${record.name} FAILED, it may still be running: ${err instanceof Error ? err.message : err}`,
        );
      });
    }
  }

  return {
    async manifest(): Promise<CapabilityManifest> {
      const base = await local.manifest();
      // Not the owner's hardware: a project that requires `own-hardware` (client repos) won't
      // route here. Not `container-isolation` either: the egress is weaker than a container's
      // (every port of an allowed host, no request log), so it declares only what is true.
      return {
        ...base,
        capabilities: [
          ...new Set([
            ...base.capabilities.filter((c) => c !== "own-hardware"),
            "cloud-sandbox" as const,
          ]),
        ],
      };
    },

    capacity: () => local.capacity(),

    resolveCheckout: (job) => local.resolveCheckout?.(job) ?? Promise.resolve(null),

    async prepareWorkspace(job, signal, prepareOptions): Promise<LocalWorkspace> {
      if (job.stage === "planning") return local.prepareWorkspace(job, signal, prepareOptions);
      const session = sessionName(job.jobId);
      const name = spriteName(prefix, job.jobId);
      const root = await spritesRoot();
      const dirs = jobDirs(root, session);
      const runDir = join(config.runsDir, job.jobId);
      const attachmentsDir = join(
        config.attachmentsDir ?? join(dirname(config.runsDir), "attachments"),
        job.jobId,
      );
      await cleanUp(job, undefined);
      try {
        const hostAccount = (await config.account?.(job)) ?? DEFAULT_HARNESS_ACCOUNT;
        // A login account can't go into a sandbox (ADR 0430 §8): say so before anything is made.
        if (hostAccount.configDir && !hostAccount.token) await credentialForAccount(hostAccount);
        // A clear failure without a Sprites token, before anything is made.
        await api();
        if (signal.aborted) throw signal.reason;
        const checkout = await checkoutFor(job);
        const start = config.startPoint ? await config.startPoint(job, checkout) : job.repo.baseRef;
        for (const dir of [dirs.home, dirs.tmp, dirs.pnpmStore]) {
          await mkdir(dir, { recursive: true, mode: 0o700 });
        }
        const attachments = capabilities.includes("work-item-attachments");
        if (attachments) await mkdir(attachmentsDir, { recursive: true, mode: 0o700 });
        const repo = await createJobRepo({
          exec,
          checkout,
          work: dirs.work,
          gitDir: dirs.gitDir,
          jobId: job.jobId,
          branch: job.branch,
          start,
          refs: [job.repo.baseRef, job.repo.defaultBranch]
            .filter((b): b is string => !!b)
            .map((b) => `${options.fetchNamespace ?? HOST_FETCH_NAMESPACE}/${b}`),
        });
        const claudeVersion = options.claudeVersion ?? pinnedClaudeVersion();
        const tools = toolPrefix(claudeVersion);
        const projected = await projectHarness(job, {
          worktree: dirs.work,
          runDir,
          runTmp: dirs.tmp,
          protectPaths: [...new Set([...(config.protectPaths ?? []), checkout])],
          git: { commonDir: dirs.gitDir, gitDir: dirs.gitDir },
          ...(attachments ? { attachmentsDir } : {}),
          // Inside the sprite: the provisioned Node runs the status hook, the pinned claude runs.
          statusHook: { node: join(tools, "node") },
          claudeBin: join(tools, "bin", "claude"),
          // The sandbox is the floor, as a container is (ADR 0430 §6): every stage
          // bypassPermissions, Claude's own sandbox off.
          isolation: "container",
          platform: "linux",
          ...(config.identity ? { identity: config.identity } : {}),
        });
        await writeFile(join(runDir, STATUS_FILE), "", { mode: 0o600 });
        await writeFile(join(runDir, PID_FILE), "", { mode: 0o600 });
        const credentialFile = `/dev/shm/${session}.env`;
        const maxLifetimeS =
          Math.min(maxLifetimeMs, (job.limits.sessionTimeoutMs ?? maxLifetimeMs) + 30 * 60_000) /
          1000;
        const record: SpriteRecord = {
          jobId: job.jobId,
          provider: options.api?.kind ?? "sprites",
          name,
          egress: egressRules(egressAllowlist(job.harness.profile, options.allowedHosts)),
          claudeVersion,
          prefix: tools,
          repo: {
            work: repo.work,
            gitDir: repo.gitDir,
            dotGit: repo.dotGit,
            configHash: repo.configHash,
          },
          credentialFile,
          size,
          maxLifetimeS,
        };
        await writeFile(join(runDir, SPRITE_RECORD), `${JSON.stringify(record, null, 2)}\n`, {
          mode: 0o600,
        });
        const entry = join(runDir, SPRITE_ENTRY);
        await writeFile(
          entry,
          `#!/bin/sh\n# Written by the software factory runner for job ${job.jobId}: the sprite's side (ADR 0480).\n${ENTRY}`,
          { mode: 0o700 },
        );
        const argv = [
          "/bin/sh",
          entry,
          ...entryArgs({
            jobId: job.jobId,
            credentialFile,
            launchScript: projected.scriptPath,
            maxLifetimeS,
            env: spriteEnv(dirs.home),
          }),
        ];
        const provider = await api();
        const ttyConfig: TtyBridgeConfig = {
          url: provider.ttyUrl(name, argv, { cols: 200, rows: 50, dir: dirs.work }),
          attachBase: provider.ttyUrl(name, [], { cols: 200, rows: 50 }).split("?")[0] ?? "",
          tokenFile: options.tokenFile,
        };
        const ttyFile = join(runDir, SPRITE_TTY);
        await writeFile(ttyFile, `${JSON.stringify(ttyConfig, null, 2)}\n`, { mode: 0o600 });
        const script = join(runDir, SPRITE_SCRIPT);
        await writeFile(
          script,
          spriteScript(job.jobId, options.node ?? process.execPath, ttyFile),
          { mode: 0o700 },
        );
        const ws: SpriteWorkspace = {
          jobId: job.jobId,
          path: dirs.work,
          branch: job.branch,
          baseSha: repo.baseSha,
          checkout,
          name: session,
          runDir,
          runTmp: dirs.tmp,
          launch: projected.launch,
          launchScript: script,
          statusFile: projected.statusFile ?? join(runDir, STATUS_FILE),
          attachmentsDir,
          readCommand: spriteReadCommand(provider, name, scriptEnv),
          launchChecks: () => spriteChecks(provider, record, projected.launch, scriptEnv),
          writeRunFile: async (path, content) => {
            const r = await provider.exec(
              name,
              scriptArgv(WRITE, [path]),
              execOpts(60_000, { stdin: content }),
            );
            if (r.code !== 0 || !r.stdout.toString().includes("written")) {
              throw new Error(`exited ${r.code}: ${r.stderr.toString().trim()}`);
            }
          },
          sprite: record,
          hostAccount,
          account: { name: hostAccount.name, configDir: join(dirs.home, ".claude") },
          jobRoot: dirs.root,
        };
        return ws;
      } catch (err) {
        await cleanUp(job, undefined).catch(() => {});
        throw err;
      }
    },

    attachFiles: local.attachFiles
      ? (job, workspace, files) => local.attachFiles?.(job, workspace, files) ?? Promise.resolve("")
      : undefined,

    async startSession(job, workspace, signal): Promise<LocalSession> {
      if (!isSprite(workspace)) return local.startSession(job, workspace, signal);
      const record = workspace.sprite;
      const provider = await api();
      const credential = await (options.modelCredential ?? ((_job, a) => credentialForAccount(a)))(
        job,
        workspace.hostAccount,
      );
      if (!credential || Object.keys(credential.env).length === 0) {
        throw new Error(
          "a sprite needs a model credential on this host: make a token account active (`claude setup-token | sf-runner account add <name> --token-stdin`, then `sf-runner account use <name>`)",
        );
      }
      for (const [k, v] of Object.entries(credential.env)) {
        if (!/^[A-Z_][A-Z0-9_]*$/.test(k) || /[\r\n'"\\$`]/.test(v)) {
          throw new Error(`the model credential's ${k} can't go in an env file`);
        }
      }
      secrets.set(job.jobId, Object.values(credential.env));
      const run = async (
        what: string,
        argv: string[],
        timeoutMs: number,
        stdin?: Buffer | string,
      ) => {
        const r = await provider.exec(
          record.name,
          argv,
          execOpts(timeoutMs, stdin === undefined ? {} : { stdin }),
        );
        if (r.code !== 0) {
          throw new Error(
            `${what} in sprite ${record.name} exited ${r.code}: ${r.stderr.toString().trim().slice(-1_000)}`,
          );
        }
        return r;
      };
      try {
        // A fresh sprite per job (Sprites can't create one from another's checkpoint). Recorded
        // first: from here on, release must destroy it or fail.
        record.createRequested = true;
        await writeFile(
          join(workspace.runDir, SPRITE_RECORD),
          `${JSON.stringify(record, null, 2)}\n`,
          {
            mode: 0o600,
          },
        );
        const created = await provider.create(record.name, record.size);
        record.id = created.id;
        if (signal.aborted) throw signal.reason;
        // The toolchain first, while nothing of the job is inside: no code, no credential.
        const provisioned = await run(
          "provisioning",
          scriptArgv(provisionScript(), [record.claudeVersion, record.prefix]),
          15 * 60_000,
        );
        log(
          `${job.jobId}: ${provisioned.stdout.toString().trim().split("\n").at(-1) ?? "provisioned"}`,
        );
        // Then the allowlist, outside the sprite's reach, and checked before anything goes in.
        await provider.setEgress(record.name, record.egress);
        const egress = await checkEgress(provider, record.name, record.egress);
        if (egress.length) throw new Error(egress.join("; "));
        // The job's files, at the paths the harness projected (after the host's merge).
        record.uploadHead = (
          await exec("git", [...SAFE_GIT, "rev-parse", "HEAD"], {
            cwd: workspace.path,
            env: hostGitEnv(),
          })
        ).stdout.trim();
        await writeFile(
          join(workspace.runDir, SPRITE_RECORD),
          `${JSON.stringify(record, null, 2)}\n`,
          {
            mode: 0o600,
          },
        );
        await writeFile(
          join(workspace.jobRoot, "home", ".claude.json"),
          `${JSON.stringify(claudeStateSeed(workspace.path, credential), null, 2)}\n`,
          { mode: 0o600 },
        );
        const roots = [workspace.jobRoot, workspace.runDir];
        if (capabilities.includes("work-item-attachments")) roots.push(workspace.attachmentsDir);
        const tarFile = join(await transferDir(), `${workspace.name}.tar`);
        try {
          const tar = await tarTo(
            roots,
            tarFile,
            options.maxUploadBytes ?? DEFAULT_MAX_UPLOAD_BYTES,
          );
          const r = await provider.exec(
            record.name,
            scriptArgv(UPLOAD, ["/", tar.sha256, ...roots]),
            { ...execOpts(15 * 60_000), stdinFile: tarFile },
          );
          if (r.code !== 0 || !r.stdout.toString().includes(`uploaded ${tar.sha256}`)) {
            throw new Error(
              `copying the job in exited ${r.code}: ${r.stderr.toString().trim().slice(-1_000)}`,
            );
          }
        } finally {
          await rm(tarFile, { force: true });
        }
        // The credential last, into memory in the sprite, just before the session that reads it.
        await run(
          "writing the credential",
          scriptArgv(WRITE, [record.credentialFile]),
          60_000,
          `${Object.entries(credential.env)
            .map(([k, v]) => `${k}='${v}'`)
            .join("\n")}\n`,
        );
        const mirror = createMirror({
          api: provider,
          sandbox: record.name,
          files: () => mirrored(workspace),
          maxFiles: 8,
          maxTotal: 256 << 20,
          log: (m) => log(`${job.jobId}: ${m}`),
        });
        mirrors.set(job.jobId, mirror);
        mirror.start(options.mirrorMs ?? 500);
        active.set(job.jobId, workspace);
        return await local.startSession(job, workspace, signal);
      } catch (err) {
        active.delete(job.jobId);
        await stopMirror(job.jobId);
        // The sprite (and the credential file in it) goes now; release tries again if this fails.
        await provider.destroy(record.name).catch((destroyErr) => {
          log(
            `${job.jobId}: DESTROYING SPRITE ${record.name} FAILED, it may still be running: ${destroyErr instanceof Error ? destroyErr.message : destroyErr}`,
          );
        });
        throw err;
      }
    },

    async *events(job, session, signal): AsyncIterable<AdapterEvent> {
      const ws = active.get(job.jobId);
      if (!ws) {
        yield* local.events(job, session, signal);
        return;
      }
      let ended: Extract<AdapterEvent, { type: "session.ended" }> | null = null;
      for await (const event of local.events(job, session, signal)) {
        if (event.type === "session.ended") {
          ended = event;
          break;
        }
        yield event;
      }
      ended ??= { type: "session.ended", outcome: signal.aborted ? "cancelled" : "failed" };
      const problems = await afterSession(job, ws).catch((err) => [
        `bringing the sprite's result back: ${err instanceof Error ? err.message : err}`,
      ]);
      active.delete(job.jobId);
      if (problems.length === 0) {
        yield ended;
        return;
      }
      yield {
        type: "session.ended",
        outcome: "failed",
        summary: [ended.summary, `Not pushing: ${problems.join("; ")}. The run failed (ADR 0480).`]
          .filter(Boolean)
          .join("\n\n"),
      };
    },

    async collectArtifacts(job, workspace, session): Promise<Artifact[]> {
      const artifacts = await local.collectArtifacts(job, workspace, session);
      if (isSprite(workspace)) {
        artifacts.push({
          kind: "log",
          name: "egress-policy",
          text: `Sprite ${workspace.sprite.name}: egress allowed only to\n${workspace.sprite.egress.map((r) => `  ${r.domain}`).join("\n")}\n`,
        });
      }
      return artifacts;
    },

    async release(job, workspace, session): Promise<void> {
      if (workspace && !isSprite(workspace)) return local.release(job, workspace, session);
      active.delete(job.jobId);
      const errors: string[] = [];
      await local.release(job, undefined, session).catch((err) => {
        errors.push(`kill session: ${err instanceof Error ? err.message : err}`);
      });
      errors.push(...(await cleanUp(job, workspace)));
      if (errors.length > 0) throw new Error(errors.join("; "));
    },

    steer: local.steer
      ? (session, text) => local.steer?.(session, text) ?? Promise.resolve()
      : undefined,

    openTerminal: local.openTerminal
      ? (session, terminalOptions) =>
          (local.openTerminal as NonNullable<typeof local.openTerminal>)(session, terminalOptions)
      : undefined,
  };
}
