// A container per job (ADR 0661): runner-local's sessions (tmux or stream-json), status hook, events
// and steering, with the job's Claude Code in a Docker container on the runner's own machine. The
// session runs `container.sh`, which `exec`s `docker run … /bin/sh <runDir>/launch.sh`, so `tmux
// attach` still takes the live Claude over and the status hook still lands in the run dir. What
// changes from a plain local job:
//
// - a repo job works in its own job repo (`job-repo.ts`), never a worktree of the owner's checkout;
// - the container sees only that repo, a fresh home, its temp dir, the run dir (read only) and the
//   account's token file (read only): no host home, no keychain, no SSH keys, no Docker socket;
// - Claude runs with permissions off and its own sandbox off: the container is the floor;
// - the launch check reads the process inside the container;
// - when the session ends the container is removed and the job's git dir checked, before the
//   host's git (commit leftovers, push with the job token, diff) touches the repo.
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_HARNESS_ACCOUNT,
  type HarnessAccount,
  PID_FILE,
  projectHarness,
  type ReadCommand,
  removeRunDir,
  STATUS_FILE,
  shellQuote,
} from "@software-factory/harness-claude";
import {
  type AdapterEvent,
  type Capability,
  hasRepo,
  type Job,
  type RunnerAdapter,
} from "@software-factory/runner-contract";
import {
  createLocalRunner,
  type LocalRunnerConfig,
  type LocalSession,
  type LocalWorkspace,
} from "../adapter.ts";
import { findCheckout, isUnder } from "../checkouts.ts";
import { nodeExec } from "../exec.ts";
import { sessionName } from "../tmux.ts";
import { ensureImage, IMAGE_NODE } from "./image.ts";
import { checkJobGitDir, createJobRepo, type JobRepo } from "./job-repo.ts";
import { type ContainerRuntime, type ContainerSpec, dockerRuntime, type Mount } from "./runtime.ts";

/** The label on every job container: its job id. */
export const JOB_LABEL = "software-factory.job";
/** The runner that started it: two runners can share one Docker, and each reaps only its own. */
export const RUNNER_LABEL = "software-factory.runner";
/** The script the session runs: the container, in the foreground. */
export const CONTAINER_SCRIPT = "container.sh";

export interface ContainerOptions {
  /** The runtime (default: Docker over its CLI). */
  runtime?: ContainerRuntime;
  /** This runner's id, on every container it starts: it reaps only its own. */
  runnerId?: string;
  /** `uid:gid` the agent runs as (default: this process's, so its files are the host user's). */
  user?: string;
  /** The `claude` the launch script runs inside the image (default `claude`). */
  claudeBin?: string;
  /** Tests: the image's Dockerfile, and more mounts (a stand-in claude). */
  dockerfile?: string;
  extraMounts?: Mount[];
  /** Tests: how the live command line is read in the container (default `docker exec … ps`). */
  readCommand?: (runtime: ContainerRuntime, container: string) => ReadCommand;
  log?: (message: string) => void;
}

export interface ContainerRunnerConfig extends LocalRunnerConfig {
  container: ContainerOptions;
}

export interface ContainerWorkspace extends LocalWorkspace {
  container: { spec: ContainerSpec; root: string; repo: JobRepo | null };
}

const isContainer = (ws: LocalWorkspace | undefined): ws is ContainerWorkspace =>
  !!ws && "container" in ws;

/** The job's Claude account can't go into a container. */
export class ContainerAccountError extends Error {
  override name = "ContainerAccountError";
}

/**
 * The account a container job uses: the host's active one, which must be a token account. A login
 * lives in the macOS Keychain (or next to the account's other conversations in its config dir), so
 * it can't be handed to a container. The token file is mounted read only; Claude's config dir is a
 * fresh one in the job's home.
 */
export function containerAccount(host: HarnessAccount, home: string): HarnessAccount {
  if (!host.token) {
    throw new ContainerAccountError(
      `this runner runs jobs in a container, and Claude account "${host.name}" isn't a token account: add one with \`claude setup-token | sf-runner account add <name> --token-stdin\`, then \`sf-runner account use <name>\``,
    );
  }
  return { name: host.name, configDir: join(home, ".claude"), token: host.token };
}

/** `ps` inside the container: the process's argv, or null when it is gone. */
export function containerReadCommand(runtime: ContainerRuntime, container: string): ReadCommand {
  return async (pid) => {
    const r = await runtime.exec(container, ["ps", "-ww", "-o", "command=", "-p", String(pid)]);
    const line = r.stdout.replace(/\n$/, "");
    return r.code === 0 && line ? line : null;
  };
}

/** Claude's own state in the job's fresh home: onboarding done, the working tree trusted. */
export function claudeStateSeed(work: string) {
  return {
    hasCompletedOnboarding: true,
    bypassPermissionsModeAccepted: true,
    projects: {
      [work]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true },
    },
  };
}

/**
 * The container's `/etc/passwd`: the image's users plus the runner's own uid, so a program that
 * asks who it is (Node's `os.userInfo()`) gets an answer.
 */
export function passwdFile(user: string, home: string): string {
  const [uid = "1000", gid = "1000"] = user.split(":");
  return [
    "root:x:0:0:root:/root:/bin/sh",
    "node:x:1000:1000::/home/node:/bin/sh",
    ...(uid === "0" || uid === "1000" ? [] : [`agent:x:${uid}:${gid}:agent:${home}:/bin/sh`]),
    "",
  ].join("\n");
}

/** What the container sees, each at its host path (the passwd file at `/etc/passwd`). */
export function containerMounts(input: {
  passwd: string;
  work: string;
  gitDir: string | null;
  runDir: string;
  home: string;
  tmp: string;
  tokenFile: string;
  extra?: Mount[];
}): Mount[] {
  const rw = (path: string): Mount => ({ path, readOnly: false });
  const ro = (path: string): Mount => ({ path, readOnly: true });
  const git = input.gitDir;
  return [
    rw(input.work),
    // The factory's Claude config in the working tree is never the agent's.
    ro(join(input.work, ".claude")),
    // The working tree's pointer to its git dir, and what in the git dir could run code or point
    // git elsewhere: read only (and checked after the session).
    ...(git
      ? [
          ro(join(input.work, ".git")),
          rw(git),
          ro(join(git, "config")),
          ro(join(git, "hooks")),
          ro(join(git, "info")),
          ro(join(git, "objects", "info")),
        ]
      : []),
    // Settings, launch script, git identity, status hook, MCP config: read only, except the two
    // files the run reports through.
    ro(input.runDir),
    rw(join(input.runDir, STATUS_FILE)),
    rw(join(input.runDir, PID_FILE)),
    rw(input.home),
    rw(input.tmp),
    ro(input.tokenFile),
    { path: input.passwd, target: "/etc/passwd", readOnly: true },
    ...(input.extra ?? []),
  ];
}

/** The script the job's session runs: its container, in the foreground. */
export function containerScript(jobId: string, argv: string[]): string {
  return [
    "#!/bin/sh",
    `# Written by the software factory runner for job ${jobId}: Claude Code in a container (ADR 0661).`,
    "# The harness's own launch script runs inside it.",
    `exec ${argv.map(shellQuote).join(" ")}`,
    "",
  ].join("\n");
}

export function createContainerRunner(
  config: ContainerRunnerConfig,
): RunnerAdapter<LocalWorkspace, LocalSession> {
  const exec = config.exec ?? nodeExec;
  const options = config.container;
  const runtime = options.runtime ?? dockerRuntime({ exec });
  const local = createLocalRunner(config);
  const log = options.log ?? (() => {});
  const user = options.user ?? `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
  const tty = config.session !== "stream-json";
  const search = {
    dirs: config.checkouts ?? [],
    exclude: [config.worktreesDir, ...(config.ownReposDir ? [config.ownReposDir] : [])],
    exec,
  };
  /** The job repo per running job, for the check after its session (events see no workspace). */
  const repos = new Map<string, JobRepo>();
  const labels = (jobId: string) => ({
    [JOB_LABEL]: jobId,
    ...(options.runnerId ? { [RUNNER_LABEL]: options.runnerId } : {}),
  });

  async function worktreesRoot(): Promise<string> {
    await mkdir(config.worktreesDir, { recursive: true });
    return realpath(config.worktreesDir);
  }

  /** Removes everything a container job left on the host, by name. Safe twice. */
  async function cleanUp(job: Job, ws: ContainerWorkspace | undefined): Promise<string[]> {
    const errors: string[] = [];
    const attempt = async (what: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (err) {
        errors.push(`${what}: ${err instanceof Error ? err.message : err}`);
      }
    };
    const name = ws?.name ?? sessionName(job.jobId);
    await attempt("remove container", () => runtime.remove(name));
    await attempt("remove job dir", async () => {
      const base = await worktreesRoot();
      const dir = ws?.container.root ?? join(base, name);
      if (!isUnder(dir, base)) throw new Error(`refusing to remove ${dir}: not under ${base}`);
      // Plain file operations, never git: a tampered job repo can't run anything here.
      await rm(dir, { recursive: true, force: true });
    });
    await attempt("remove run dir", () =>
      removeRunDir(ws?.runDir ?? join(config.runsDir, job.jobId)),
    );
    return errors;
  }

  return {
    ...local,

    async manifest() {
      const base = await local.manifest();
      const capabilities: Capability[] = [...base.capabilities, "container-isolation"];
      return { ...base, capabilities: [...new Set(capabilities)] };
    },

    async prepareWorkspace(job): Promise<LocalWorkspace> {
      const name = sessionName(job.jobId);
      const root = join(await worktreesRoot(), name);
      const runDir = join(config.runsDir, job.jobId);
      // Whatever a crashed run of this same job left goes first.
      await cleanUp(job, undefined);
      try {
        // The host's active account, now: the job keeps it (ADR 0410). Say so before anything
        // is made when it can't go into a container, or Docker isn't running.
        const hostAccount = (await config.account?.(job)) ?? DEFAULT_HARNESS_ACCOUNT;
        const home = join(root, "home");
        const account = containerAccount(hostAccount, home);
        await runtime.version();
        const image = await ensureImage(runtime, {
          log,
          ...(options.dockerfile ? { dockerfile: options.dockerfile } : {}),
        });
        const work = join(root, "work");
        const tmp = join(root, "tmp");
        for (const dir of [home, tmp, account.configDir ?? home]) {
          await mkdir(dir, { recursive: true, mode: 0o700 });
        }
        let repo: JobRepo | null = null;
        let checkout = "";
        if (hasRepo(job)) {
          const found = await findCheckout(job, search);
          checkout = found
            ? found.path
            : await realpath(await config.resolveRepoPath(job)).catch(() => "");
          if (!checkout) throw new Error(`no checkout of ${job.repo.owner}/${job.repo.name}`);
          const start = config.startPoint
            ? await config.startPoint(job, checkout)
            : job.repo.baseRef;
          repo = await createJobRepo({
            exec,
            checkout,
            work,
            gitDir: join(root, "git"),
            jobId: job.jobId,
            branch: job.branch,
            start,
          });
        } else {
          await mkdir(work, { recursive: true });
        }
        const projected = await projectHarness(job, {
          account,
          worktree: work,
          runDir,
          runTmp: tmp,
          protectPaths: [...(config.protectPaths ?? []), ...(checkout ? [checkout] : [])],
          ...(repo ? { git: { commonDir: repo.gitDir, gitDir: repo.gitDir } } : {}),
          ...(tty ? {} : { session: "stream" as const }),
          // Inside the image: its Node runs the status hook, its claude is launched.
          statusHook: { node: IMAGE_NODE },
          claudeBin: options.claudeBin ?? "claude",
          isolation: "container",
          platform: "linux",
          ...(config.identity ? { identity: config.identity } : {}),
        });
        // The two files the container writes into the (read-only) run dir must exist to be mounted.
        await writeFile(join(runDir, STATUS_FILE), "", { mode: 0o600 });
        await writeFile(join(runDir, PID_FILE), "", { mode: 0o600 });
        const passwd = join(root, "passwd");
        await writeFile(passwd, passwdFile(user, home), { mode: 0o644 });
        const seed = `${JSON.stringify(claudeStateSeed(work), null, 2)}\n`;
        for (const dir of [home, account.configDir ?? home]) {
          await writeFile(join(dir, ".claude.json"), seed, { mode: 0o600 });
        }
        const spec: ContainerSpec = {
          name,
          image,
          user,
          workdir: work,
          script: projected.scriptPath,
          env: {
            HOME: home,
            TERM: "xterm-256color",
            LANG: "C.UTF-8",
            DISABLE_AUTOUPDATER: "1",
            // The job repo belongs to the host user; the container's uid may map differently.
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "safe.directory",
            GIT_CONFIG_VALUE_0: "*",
          },
          mounts: containerMounts({
            passwd,
            work,
            gitDir: repo?.gitDir ?? null,
            runDir,
            home,
            tmp,
            // containerAccount refused an account without one.
            tokenFile: account.token?.file ?? "",
            ...(options.extraMounts ? { extra: options.extraMounts } : {}),
          }),
          labels: labels(job.jobId),
        };
        const script = join(runDir, CONTAINER_SCRIPT);
        await writeFile(script, containerScript(job.jobId, runtime.runArgv(spec, tty)), {
          mode: 0o700,
        });
        if (repo) repos.set(job.jobId, repo);
        const ws: ContainerWorkspace = {
          jobId: job.jobId,
          path: work,
          branch: hasRepo(job) ? job.branch : "",
          baseSha: repo?.baseSha ?? "",
          checkout,
          name,
          runDir,
          runTmp: tmp,
          launch: projected.launch,
          // The session runs the container; the harness's launch script runs inside it.
          launchScript: script,
          statusFile: projected.statusFile ?? join(runDir, STATUS_FILE),
          account,
          readCommand: (options.readCommand ?? containerReadCommand)(runtime, name),
          container: { spec, root, repo },
        };
        return ws;
      } catch (err) {
        await cleanUp(job, undefined).catch(() => {});
        throw err;
      }
    },

    async *events(job, session, signal): AsyncIterable<AdapterEvent> {
      let ended: Extract<AdapterEvent, { type: "session.ended" }> | null = null;
      for await (const event of local.events(job, session, signal)) {
        if (event.type === "session.ended") {
          ended = event;
          break;
        }
        yield event;
      }
      ended ??= { type: "session.ended", outcome: signal.aborted ? "cancelled" : "failed" };
      // The container stops before the host's git runs on the repo, then the repo is checked.
      const name = sessionName(job.jobId);
      const problems: string[] = [];
      await runtime.remove(name).catch((err) => {
        problems.push(`removing the container: ${err instanceof Error ? err.message : err}`);
      });
      const repo = repos.get(job.jobId);
      if (repo) problems.push(...(await checkJobGitDir(repo)));
      if (problems.length === 0) {
        yield ended;
        return;
      }
      yield {
        type: "session.ended",
        outcome: "failed",
        summary: [
          ended.summary,
          `Not pushing: ${problems.join("; ")}. The job repo was put back and the run failed (ADR 0661).`,
        ]
          .filter(Boolean)
          .join("\n\n"),
      };
    },

    async release(job, workspace, session): Promise<void> {
      if (workspace && !isContainer(workspace)) return local.release(job, workspace, session);
      repos.delete(job.jobId);
      const errors: string[] = [];
      // The session (tmux or stream) and any process it left: runner-local's release without a
      // workspace touches nothing else.
      await local.release(job, undefined, session).catch((err) => {
        errors.push(`stop session: ${err instanceof Error ? err.message : err}`);
      });
      errors.push(...(await cleanUp(job, workspace)));
      if (errors.length > 0) throw new Error(errors.join("; "));
    },
  };
}
